import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { fiscalContentFingerprint, fiscalIdentityFromRaw, fiscalIdentityKey } from './fiscal-evidence.js';
import { FiscalContentConflictError, FiscalIdentityConflictError, FiscalIdentityUnavailableError } from './fiscal-errors.js';
import { FnsSourceObservationConflictError } from './multi-user-errors.js';

export function createPool(config = {}) {
  const connectionString = config.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString && !config.host && !process.env.PGHOST) throw new Error('DATABASE_URL or PostgreSQL connection variables are required');
  return new Pool({ connectionString, host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, max: config.max ?? 5, ssl: config.ssl ?? (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined) });
}

export async function migrate(pool, migrationsDir = path.join(process.cwd(), 'db', 'migrations')) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const filename of files) {
    if ((await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename])).rowCount) continue;
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(await fs.readFile(path.join(migrationsDir, filename), 'utf8')); await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

export class ReceiptRepository {
  constructor(pool, { faultInjector = null } = {}) { this.pool = pool; this.faultInjector = faultInjector; }
  async findReceipt(fnsId) { const result = await this.pool.query('SELECT id FROM receipts WHERE fns_id=$1', [fnsId]); return result.rows[0] ?? null; }
  async upsertBundle({ normalized, raw, listSummary = null }) {
    const fiscalIdentity = fiscalIdentityFromRaw(raw);
    const fiscalKey = fiscalIdentityKey(fiscalIdentity);
    if (!normalized?.id) {
      throw new FiscalIdentityUnavailableError();
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the same identity key before probing/inserting. The unique
      // indexes remain the final barrier for races and independent writers.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${normalized.id}|${fiscalKey ?? ''}`]);
      const byFns = await client.query('SELECT id, fns_id, fiscal_drive_number, fiscal_document_number, fiscal_sign FROM receipts WHERE fns_id=$1 FOR UPDATE', [normalized.id]);
      const byFiscal = fiscalKey
        ? await client.query('SELECT id, fns_id, fiscal_drive_number, fiscal_document_number, fiscal_sign FROM receipts WHERE fiscal_drive_number=$1 AND fiscal_document_number=$2 AND fiscal_sign=$3 FOR UPDATE', [fiscalIdentity.fiscalDriveNumber, fiscalIdentity.fiscalDocumentNumber, fiscalIdentity.fiscalSign])
        : { rows: [] };
      if (byFns.rowCount && byFiscal.rowCount && byFns.rows[0].id !== byFiscal.rows[0].id) {
        await this.observeConflict({ branch: 'BOTH_IDENTITIES_MATCH_DIFFERENT_ROWS', normalized, raw, listSummary, byFns: byFns.rows[0], byFiscal: byFiscal.rows[0], client });
        throw new FiscalIdentityConflictError();
      }
      if (fiscalKey && ((byFns.rowCount && !byFiscal.rowCount) || (!byFns.rowCount && byFiscal.rowCount))) {
        await this.observeConflict({ branch: byFns.rowCount ? 'FNS_ID_MATCH_BUT_TUPLE_NOT_FOUND' : 'TUPLE_MATCH_BUT_FNS_ID_NOT_FOUND', normalized, raw, listSummary, byFns: byFns.rows[0] ?? null, byFiscal: byFiscal.rows[0] ?? null, client });
        throw new FiscalIdentityConflictError();
      }

      let id = byFns.rows[0]?.id ?? byFiscal.rows[0]?.id ?? null;
      if (id) {
        const storedRaw = await client.query('SELECT payload FROM receipt_raw WHERE receipt_id=$1 FOR UPDATE', [id]);
        if (!storedRaw.rowCount || fiscalContentFingerprint(storedRaw.rows[0].payload) !== fiscalContentFingerprint(raw)) {
          throw new FiscalContentConflictError();
        }
        await client.query('COMMIT');
        return { id, created: false, replayed: true };
      }

      const result = await client.query(`INSERT INTO receipts (fns_id,date_time,seller,seller_inn,total_sum,currency,operation_type,fiscal_document_number,fiscal_drive_number,fiscal_sign,kkt_reg_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`, [normalized.id, normalized.dateTime, normalized.seller, normalized.sellerInn, normalized.totalSum, normalized.currency, normalized.operationType ?? null, raw?.fiscalDocumentNumber ?? null, raw?.fiscalDriveNumber ?? null, raw?.fiscalSign ?? null, raw?.kktRegId ?? null]);
      id = result.rows[0]?.id ?? null;
      if (!id) {
        const racedFns = await client.query('SELECT id FROM receipts WHERE fns_id=$1 FOR UPDATE', [normalized.id]);
        const racedFiscal = fiscalKey
          ? await client.query('SELECT id FROM receipts WHERE fiscal_drive_number=$1 AND fiscal_document_number=$2 AND fiscal_sign=$3 FOR UPDATE', [fiscalIdentity.fiscalDriveNumber, fiscalIdentity.fiscalDocumentNumber, fiscalIdentity.fiscalSign])
          : { rows: [] };
        if (racedFns.rowCount && racedFiscal.rowCount && racedFns.rows[0].id !== racedFiscal.rows[0].id) throw new FiscalIdentityConflictError();
        id = racedFns.rows[0]?.id ?? racedFiscal.rows[0]?.id ?? null;
        if (!id) throw new FiscalIdentityConflictError();
        const racedRaw = await client.query('SELECT payload FROM receipt_raw WHERE receipt_id=$1 FOR UPDATE', [id]);
        if (!racedRaw.rowCount || fiscalContentFingerprint(racedRaw.rows[0].payload) !== fiscalContentFingerprint(raw)) throw new FiscalContentConflictError();
        await client.query('COMMIT');
        return { id, created: false, replayed: true };
      }

      await this.faultInjector?.('after_receipt_insert');
      for (const [position, item] of (normalized.items ?? []).entries()) { const source = raw?.items?.[position] ?? null; await client.query('INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum,provider_inn,nds,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, position, item.name, item.quantity, item.price, item.sum, source?.providerInn ?? null, source?.nds ?? null, source]); }
      await this.faultInjector?.('after_items');
      await client.query('INSERT INTO receipt_raw(receipt_id,payload) VALUES($1,$2)', [id, raw]);
      await this.faultInjector?.('after_raw');
      await client.query('COMMIT');
      return { id, created: true, replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async ensureSource({ scopeKey = 'default', sourceKey, displayName = null, sessionRef, deviceRef = null, personKey = null, personDisplayName = null, enabled = true }) {
    if (!sourceKey || !sessionRef) throw new Error('sourceKey and sessionRef are required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scope = (await client.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$1) ON CONFLICT(scope_key) DO UPDATE SET label=accounting_scopes.label RETURNING id', [scopeKey])).rows[0];
      const source = (await client.query(`INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref,enabled) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(scope_id,source_key) DO UPDATE SET display_name=COALESCE(EXCLUDED.display_name,fns_sources.display_name),session_ref=EXCLUDED.session_ref,device_ref=EXCLUDED.device_ref,enabled=EXCLUDED.enabled,updated_at=NOW()
        RETURNING id,scope_id,source_key,enabled`, [scope.id, sourceKey, displayName, sessionRef, deviceRef, enabled])).rows[0];
      if (personKey) {
        const person = (await client.query(`INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3)
          ON CONFLICT(scope_id,person_key) DO UPDATE SET display_name=COALESCE(EXCLUDED.display_name,persons.display_name) RETURNING id`, [scope.id, personKey, personDisplayName])).rows[0];
        await client.query('INSERT INTO fns_source_person(fns_source_id,person_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [source.id, person.id]);
      }
      await client.query('INSERT INTO fns_source_sync_state(fns_source_id) VALUES($1) ON CONFLICT DO NOTHING', [source.id]);
      await client.query('COMMIT');
      return source;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async updateSourceSyncState(sourceId, values) {
    await this.pool.query(`INSERT INTO fns_source_sync_state(fns_source_id,last_sync_started_at,last_sync_finished_at,last_error,last_error_class,fetched_count,canonical_inserted_count,observation_replayed_count)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(fns_source_id) DO UPDATE SET last_sync_started_at=EXCLUDED.last_sync_started_at,last_sync_finished_at=EXCLUDED.last_sync_finished_at,last_error=EXCLUDED.last_error,last_error_class=EXCLUDED.last_error_class,fetched_count=EXCLUDED.fetched_count,canonical_inserted_count=EXCLUDED.canonical_inserted_count,observation_replayed_count=EXCLUDED.observation_replayed_count,updated_at=NOW()`, [sourceId, values.startedAt ?? null, values.finishedAt ?? null, values.error ?? null, values.errorClass ?? null, values.fetched ?? 0, values.inserted ?? 0, values.replayed ?? 0]);
  }
  async upsertSourceReceiptReference({ sourceId, sourceReceiptId }) {
    const result = await this.pool.query(`INSERT INTO fns_source_receipt_refs(fns_source_id,source_receipt_id,status)
      VALUES($1,$2,'PENDING_DETAIL')
      ON CONFLICT(fns_source_id,source_receipt_id) DO UPDATE SET last_seen_at=NOW(),updated_at=NOW()
      RETURNING id,receipt_id,status,detail_next_retry_at,detail_attempt_count`, [sourceId, sourceReceiptId]);
    return result.rows[0];
  }
  async markSourceReceiptDetailAttempt({ sourceId, sourceReceiptId }) {
    const result = await this.pool.query(`UPDATE fns_source_receipt_refs
      SET detail_last_attempt_at=NOW(), detail_attempt_count=detail_attempt_count+1, updated_at=NOW()
      WHERE fns_source_id=$1 AND source_receipt_id=$2
      RETURNING detail_attempt_count`, [sourceId, sourceReceiptId]);
    if (!result.rowCount) throw new Error('Source receipt reference was not registered');
    return result.rows[0];
  }
  async markSourceReceiptResolved({ sourceId, sourceReceiptId, receiptId }) {
    await this.pool.query(`UPDATE fns_source_receipt_refs
      SET receipt_id=$3,status='RESOLVED',resolved_at=NOW(),detail_next_retry_at=NULL,
          detail_http_status=NULL,detail_error_code=NULL,detail_error_signature=NULL,updated_at=NOW()
      WHERE fns_source_id=$1 AND source_receipt_id=$2`, [sourceId, sourceReceiptId, receiptId]);
  }
  async markSourceReceiptDetailUnavailable({ sourceId, sourceReceiptId, error }) {
    const result = await this.pool.query(`UPDATE fns_source_receipt_refs
      SET receipt_id=NULL,status='FNS_DETAIL_UNAVAILABLE',
          detail_next_retry_at=CASE
            WHEN detail_attempt_count <= 1 THEN NOW() + INTERVAL '24 hours'
            WHEN detail_attempt_count = 2 THEN NOW() + INTERVAL '7 days'
            ELSE NOW() + INTERVAL '30 days'
          END,
          detail_http_status=$3,detail_error_code=$4,detail_error_signature=$5,updated_at=NOW()
      WHERE fns_source_id=$1 AND source_receipt_id=$2
      RETURNING detail_next_retry_at`, [sourceId, sourceReceiptId, error.httpStatus, error.errorCode, error.errorSignature]);
    if (!result.rowCount) throw new Error('Source receipt reference was not registered');
    return result.rows[0];
  }
  async markSourceReceiptRetryable({ sourceId, sourceReceiptId, error }) {
    const result = await this.pool.query(`UPDATE fns_source_receipt_refs
      SET receipt_id=NULL,status='RETRYABLE_DETAIL_ERROR',
          detail_next_retry_at=NOW() + INTERVAL '1 hour',
          detail_http_status=$3,detail_error_code=$4,detail_error_signature=$5,updated_at=NOW()
      WHERE fns_source_id=$1 AND source_receipt_id=$2
      RETURNING detail_next_retry_at`, [sourceId, sourceReceiptId, error.httpStatus, error.errorCode, error.errorSignature]);
    if (!result.rowCount) throw new Error('Source receipt reference was not registered');
    return result.rows[0];
  }
  async countSourceReceiptReferences(sourceId) {
    const result = await this.pool.query(`SELECT status,count(*)::int AS count
      FROM fns_source_receipt_refs WHERE fns_source_id=$1 GROUP BY status`, [sourceId]);
    return Object.fromEntries(result.rows.map((row) => [row.status, row.count]));
  }
  async upsertObservedBundle({ sourceId, sourceReceiptId, normalized, raw, listSummary = null }) {
    if (!sourceId || !sourceReceiptId) throw new Error('sourceId and sourceReceiptId are required');
    const fiscalIdentity = fiscalIdentityFromRaw(raw);
    const fiscalKey = fiscalIdentityKey(fiscalIdentity);
    if (!normalized?.id) throw new FiscalIdentityUnavailableError();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the source-reference conflict domain, not the incoming fiscal
      // identity. Different fiscal identities using one source reference must
      // still serialize and fail closed deterministically.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`multi:${sourceId}:${sourceReceiptId}`]);
      // The advisory xact lock above serializes this source-reference domain.
      // Keep the provenance table append-only: SELECT FOR UPDATE would require
      // UPDATE privilege even though observations must never be updated.
      const prior = await client.query('SELECT receipt_id FROM receipt_source_observations WHERE fns_source_id=$1 AND source_receipt_id=$2', [sourceId, sourceReceiptId]);
      let existing = fiscalKey ? await client.query('SELECT id,fns_id FROM receipts WHERE fiscal_drive_number=$1 AND fiscal_document_number=$2 AND fiscal_sign=$3 FOR UPDATE', [fiscalIdentity.fiscalDriveNumber, fiscalIdentity.fiscalDocumentNumber, fiscalIdentity.fiscalSign]) : { rows: [] };
      const byFns = await client.query('SELECT id FROM receipts WHERE fns_id=$1 FOR UPDATE', [normalized.id]);
      if (prior.rowCount && existing.rowCount && Number(prior.rows[0].receipt_id) !== Number(existing.rows[0].id)) throw new FnsSourceObservationConflictError();
      if (prior.rowCount && !existing.rowCount) throw new FnsSourceObservationConflictError();
      if (byFns.rowCount && existing.rowCount && Number(byFns.rows[0].id) !== Number(existing.rows[0].id)) throw new FiscalIdentityConflictError();
      let id = existing.rows[0]?.id ?? byFns.rows[0]?.id ?? null;
      let created = false;
      if (id) {
        const stored = await client.query('SELECT payload FROM receipt_raw WHERE receipt_id=$1 FOR UPDATE', [id]);
        if (!stored.rowCount || fiscalContentFingerprint(stored.rows[0].payload) !== fiscalContentFingerprint(raw)) throw new FiscalContentConflictError();
      } else {
        if (!fiscalKey) throw new FiscalIdentityUnavailableError();
        const inserted = (await client.query(`INSERT INTO receipts(fns_id,date_time,seller,seller_inn,total_sum,currency,operation_type,fiscal_document_number,fiscal_drive_number,fiscal_sign,kkt_reg_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [normalized.id, normalized.dateTime, normalized.seller, normalized.sellerInn, normalized.totalSum, normalized.currency, normalized.operationType ?? null, raw?.fiscalDocumentNumber ?? null, raw?.fiscalDriveNumber ?? null, raw?.fiscalSign ?? null, raw?.kktRegId ?? null])).rows[0];
        id = inserted.id; created = true;
        for (const [position, item] of (normalized.items ?? []).entries()) { const source = raw?.items?.[position] ?? null; await client.query('INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum,provider_inn,nds,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, position, item.name, item.quantity, item.price, item.sum, source?.providerInn ?? null, source?.nds ?? null, source]); }
        await client.query('INSERT INTO receipt_raw(receipt_id,payload) VALUES($1,$2)', [id, raw]);
      }
      const observation = await client.query(`INSERT INTO receipt_source_observations(fns_source_id,receipt_id,source_receipt_id,source_content_sha256) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [sourceId, id, sourceReceiptId, fiscalContentFingerprint(raw)]);
      await client.query('COMMIT');
      return { id: Number(id), created, replayed: !created, observationCreated: observation.rowCount > 0 };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async observeConflict({ branch, normalized, raw, listSummary, byFns, byFiscal, client }) {
    const output = process.env.FORENSIC_CONFLICT_PATH;
    if (!output) return;
    const ids = [byFns?.id, byFiscal?.id].filter(Boolean);
    const stored = ids.length ? await client.query('SELECT r.id,r.fns_id,r.date_time,r.seller_inn,r.total_sum,r.currency,r.operation_type,r.fiscal_drive_number,r.fiscal_document_number,r.fiscal_sign,r.kkt_reg_id,rr.payload FROM receipts r LEFT JOIN receipt_raw rr ON rr.receipt_id=r.id WHERE r.id = ANY($1::bigint[]) ORDER BY r.id', [ids]) : { rows: [] };
    const safeId = (value) => value ? String(value).replace(/^[^|@\\s]+@[^|\\s]+/, '[REDACTED_EMAIL]') : null;
    const safe = (value, row = null) => ({ receiptId: row?.id ?? null, fnsId: safeId(row?.fns_id ?? value?.key ?? value?.id), identity: fiscalIdentityFromRaw(row?.payload ?? value), kktRegId: row?.kkt_reg_id ?? value?.kktRegId ?? null, sellerInn: row?.seller_inn ?? value?.sellerInn ?? value?.userInn ?? null, dateTime: row?.date_time ?? value?.dateTime ?? null, totalSum: row?.total_sum ?? value?.totalSum ?? null, currency: row?.currency ?? value?.currency ?? null, operationType: row?.operation_type ?? value?.operationType ?? null, contentSha256: fiscalContentFingerprint(row?.payload ?? value) });
    const observation = { timestamp: new Date().toISOString(), branch, incomingList: safe(listSummary), incomingDetail: safe(raw), fnsIdLookup: safe(null, stored.rows.find((row) => row.id === byFns?.id)), tupleLookup: safe(null, stored.rows.find((row) => row.id === byFiscal?.id)) };
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.appendFile(output, `${JSON.stringify(observation)}\n`, { mode: 0o600 });
  }
  async updateSyncState(accountKey, values) { await this.pool.query('INSERT INTO sync_state(account_key,last_sync_started_at,last_sync_finished_at,last_error) VALUES($1,$2,$3,$4) ON CONFLICT(account_key) DO UPDATE SET last_sync_started_at=EXCLUDED.last_sync_started_at,last_sync_finished_at=EXCLUDED.last_sync_finished_at,last_error=EXCLUDED.last_error,updated_at=NOW()', [accountKey, values.startedAt ?? null, values.finishedAt ?? null, values.error ?? null]); }
}

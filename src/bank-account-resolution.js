import { bankPayloadSha256, normalizeBankEvent } from './bank-ingestion.js';

const RELATION_TYPES = new Set(['OWNER', 'AUTHORIZED_USER']);
const INSTRUMENT_TYPES = new Set(['CARD', 'VIRTUAL_CARD', 'OTHER']);
const REFERENCE_KINDS = new Set(['MASKED_CARD', 'MASKED_ACCOUNT', 'OTHER']);
const RESOLUTION_STATES = new Set(['EXACT', 'MANUAL', 'RECONCILED', 'UNKNOWN']);
export const HISTORICAL_REPLAY_PROVENANCE = 'HISTORICAL_OBSERVATION_REPLAY';

function requiredText(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} is required`);
  return value.trim();
}

function requiredId(value, field) {
  if (!Number.isInteger(Number(value)) || Number(value) < 1) throw new Error(`${field} is required`);
  return Number(value);
}

function requireState(value) {
  if (!RESOLUTION_STATES.has(value)) throw new Error('Unsupported resolution state');
  return value;
}

export function buildBankTransactionCoverage(rows = []) {
  const total = rows.length;
  const resolved = rows.filter((row) => row.financialAccountId != null && row.resolutionState !== 'UNKNOWN').length;
  const states = Object.fromEntries([...RESOLUTION_STATES].map((state) => [state, rows.filter((row) => row.resolutionState === state).length]));
  const unresolved = total - resolved;
  return {
    totalBankTransactions: total,
    resolvedAccount: resolved,
    unresolvedAccount: unresolved,
    exact: states.EXACT,
    manual: states.MANUAL,
    reconciled: states.RECONCILED,
    unknown: states.UNKNOWN + rows.filter((row) => row.resolutionState == null).length,
    invariant: total === resolved + unresolved,
  };
}

export async function bankTransactionAccountCoverage(pool) {
  const result = await pool.query(`SELECT bt.id AS "transactionId", r.financial_account_id AS "financialAccountId",
      r.resolution_state AS "resolutionState"
    FROM bank_transactions bt
    LEFT JOIN bank_transaction_account_resolution r ON r.bank_transaction_id=bt.id
    ORDER BY bt.id`);
  return buildBankTransactionCoverage(result.rows);
}

export async function createFinancialAccount(pool, { scopeKey = 'default', institution, provider = null, displayName, currency = 'RUB', active = true }) {
  const scope = requiredText(scopeKey, 'scopeKey', 128);
  const institutionValue = requiredText(institution, 'institution');
  const name = requiredText(displayName, 'displayName');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be an uppercase ISO 4217 code');
  const result = await pool.query(`INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency,active)
    SELECT id,$2,$3,$4,$5,$6 FROM accounting_scopes WHERE scope_key=$1
    RETURNING id,scope_id,institution,provider,display_name,currency,active`, [scope, institutionValue, provider, name, currency, Boolean(active)]);
  if (!result.rowCount) throw new Error(`Accounting scope not found: ${scope}`);
  return result.rows[0];
}

export async function relateFinancialAccountPerson(pool, { financialAccountId, personId, relationType, provenance, reason }) {
  if (!RELATION_TYPES.has(relationType)) throw new Error('Unsupported account-person relation type');
  const accountPerson = (await pool.query(`SELECT a.id AS account_id, a.scope_id AS account_scope_id, p.id AS person_id, p.scope_id AS person_scope_id
    FROM financial_accounts a CROSS JOIN persons p WHERE a.id=$1 AND p.id=$2`, [requiredId(financialAccountId, 'financialAccountId'), requiredId(personId, 'personId')])).rows[0];
  if (!accountPerson) throw new Error('Financial account or person was not found');
  if (Number(accountPerson.account_scope_id) !== Number(accountPerson.person_scope_id)) throw new Error('Financial account and person are outside the same accounting scope');
  const result = await pool.query(`INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason)
    VALUES($1,$2,$3,$4,$5) RETURNING id,financial_account_id,person_id,relation_type,provenance,reason`, [requiredId(financialAccountId, 'financialAccountId'), requiredId(personId, 'personId'), relationType, requiredText(provenance, 'provenance'), requiredText(reason, 'reason', 1000)]);
  return result.rows[0];
}

export async function createPaymentInstrument(pool, { financialAccountId, instrumentType, provider = null, displayName, active = true }) {
  if (!INSTRUMENT_TYPES.has(instrumentType)) throw new Error('Unsupported payment instrument type');
  const result = await pool.query(`INSERT INTO payment_instruments(financial_account_id,instrument_type,provider,display_name,active)
    VALUES($1,$2,$3,$4,$5) RETURNING id,financial_account_id,instrument_type,provider,display_name,active`, [requiredId(financialAccountId, 'financialAccountId'), instrumentType, provider, requiredText(displayName, 'displayName'), Boolean(active)]);
  return result.rows[0];
}

export async function createBankAccountReference(pool, { financialAccountId, provider, referenceKind, referenceValue }) {
  if (!REFERENCE_KINDS.has(referenceKind)) throw new Error('Unsupported account reference kind');
  const result = await pool.query(`INSERT INTO bank_account_references(financial_account_id,provider,reference_kind,reference_value)
    VALUES($1,$2,$3,$4) RETURNING id,financial_account_id,provider,reference_kind,reference_value`, [requiredId(financialAccountId, 'financialAccountId'), requiredText(provider, 'provider'), referenceKind, requiredText(referenceValue, 'referenceValue', 200)]);
  return result.rows[0];
}

export async function listFinancialAccounts(pool, { scopeKey = null } = {}) {
  const result = await pool.query(`SELECT a.id, s.scope_key AS "scopeKey", a.institution, a.provider,
      a.display_name AS "displayName", a.currency, a.active,
      COALESCE((SELECT json_agg(json_build_object('personId', r.person_id, 'relationType', r.relation_type, 'provenance', r.provenance, 'reason', r.reason) ORDER BY r.person_id, r.relation_type)
        FROM financial_account_person_relations r WHERE r.financial_account_id=a.id), '[]'::json) AS relations,
      COALESCE((SELECT json_agg(json_build_object('provider', br.provider, 'referenceKind', br.reference_kind, 'referenceValue', br.reference_value) ORDER BY br.provider, br.reference_kind, br.reference_value)
        FROM bank_account_references br WHERE br.financial_account_id=a.id), '[]'::json) AS references,
      COALESCE((SELECT json_agg(json_build_object('instrumentType', pi.instrument_type, 'provider', pi.provider, 'displayName', pi.display_name, 'active', pi.active) ORDER BY pi.id)
        FROM payment_instruments pi WHERE pi.financial_account_id=a.id), '[]'::json) AS instruments
    FROM financial_accounts a JOIN accounting_scopes s ON s.id=a.scope_id
    WHERE ($1::text IS NULL OR s.scope_key=$1)
    ORDER BY a.id`, [scopeKey]);
  return result.rows;
}

export async function resolveBankTransactionAccount(pool, { bankTransactionId, financialAccountId = null, resolutionState, provenance, reason }) {
  const state = requireState(resolutionState);
  if (state === 'EXACT') throw new Error('EXACT resolution requires proven account reference evidence');
  if (state === 'UNKNOWN' && financialAccountId != null) throw new Error('UNKNOWN resolution cannot name a financial account');
  if (state !== 'UNKNOWN' && financialAccountId == null) throw new Error(`${state} resolution requires a financial account`);
  const transactionId = requiredId(bankTransactionId, 'bankTransactionId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await loadTransactionContext(client, transactionId);
    if (state !== 'UNKNOWN') {
      const account = (await client.query('SELECT id,scope_id FROM financial_accounts WHERE id=$1', [requiredId(financialAccountId, 'financialAccountId')])).rows[0];
      if (!account) throw new Error('Financial account was not found');
      if (Number(account.scope_id) !== Number(context.scopeId)) throw new Error('Financial account is outside the transaction scope');
    }
    const result = await client.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(bank_transaction_id) DO UPDATE SET financial_account_id=EXCLUDED.financial_account_id,
        resolution_state=EXCLUDED.resolution_state,provenance=EXCLUDED.provenance,reason=EXCLUDED.reason,resolved_at=NOW()
      RETURNING bank_transaction_id,financial_account_id,resolution_state,provenance,reason`, [transactionId, financialAccountId == null ? null : requiredId(financialAccountId, 'financialAccountId'), state, requiredText(provenance, 'provenance'), requiredText(reason, 'reason', 1000)]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function loadTransactionContext(client, transactionId) {
  const result = await client.query(`SELECT bt.id, bt.account_reference AS "accountReference", bt.account_reference_kind AS "accountReferenceKind",
      eo.ingestion_metadata->>'provider' AS provider,
      COALESCE(array_agg(DISTINCT p.scope_id) FILTER (WHERE p.scope_id IS NOT NULL), ARRAY[]::bigint[]) AS scope_ids
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id=bt.observation_id
    LEFT JOIN bank_source_person sp ON sp.bank_source_id=eo.bank_source_id AND sp.relation_type='OWNER'
    LEFT JOIN persons p ON p.id=sp.person_id
    WHERE bt.id=$1
    GROUP BY bt.id, eo.ingestion_metadata`, [transactionId]);
  const context = result.rows[0];
  if (!context) throw new Error('Bank transaction was not found');
  if (context.scope_ids.length !== 1) throw new Error('Bank source accounting scope is not unique');
  return { ...context, scopeId: Number(context.scope_ids[0]) };
}

async function persistResolution(client, { transactionId, financialAccountId = null, resolutionState, provenance, reason }) {
  const result = await client.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(bank_transaction_id) DO UPDATE SET financial_account_id=EXCLUDED.financial_account_id,
      resolution_state=EXCLUDED.resolution_state,provenance=EXCLUDED.provenance,reason=EXCLUDED.reason,resolved_at=NOW()
    RETURNING bank_transaction_id,financial_account_id,resolution_state,provenance,reason`, [transactionId, financialAccountId, resolutionState, requiredText(provenance, 'provenance'), requiredText(reason, 'reason', 1000)]);
  return result.rows[0];
}

export async function resolveBankTransactionAccountFromReference(pool, { bankTransactionId }) {
  const transactionId = requiredId(bankTransactionId, 'bankTransactionId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await loadTransactionContext(client, transactionId);
    const candidates = context.provider && context.accountReference && context.accountReferenceKind
      ? (await client.query(`SELECT DISTINCT r.financial_account_id
          FROM bank_account_references r
          JOIN financial_accounts a ON a.id=r.financial_account_id
          WHERE r.provider=$1 AND r.reference_kind=$2 AND r.reference_value=$3 AND a.scope_id=$4
          ORDER BY r.financial_account_id`, [context.provider, context.accountReferenceKind, context.accountReference, context.scopeId])).rows
      : [];
    let result;
    if (candidates.length === 1) {
      result = await persistResolution(client, { transactionId, financialAccountId: Number(candidates[0].financial_account_id), resolutionState: 'EXACT', provenance: 'OBSERVED_PROVIDER_REFERENCE', reason: 'One provider-scoped account reference candidate' });
    } else {
      const reason = candidates.length > 1
        ? 'Ambiguous provider, reference kind, and scope candidates'
        : !context.accountReferenceKind
          ? 'Observed account reference has no supported reference kind'
          : 'No provider, reference kind, and scope candidate';
      result = await persistResolution(client, { transactionId, resolutionState: 'UNKNOWN', provenance: candidates.length > 1 ? 'OBSERVED_PROVIDER_REFERENCE_AMBIGUOUS' : 'OBSERVED_PROVIDER_REFERENCE_UNRESOLVED', reason });
    }
    await client.query('COMMIT');
    return { ...result, candidateCount: candidates.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function historicalFailure(reason, extra = {}) {
  return { status: 'FAIL_CLOSED', resolutionState: 'UNKNOWN', reason, ...extra };
}

function sameValue(left, right) {
  return (left == null && right == null) || String(left) === String(right);
}

function sameTimestamp(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return new Date(left).toISOString() === new Date(right).toISOString();
}

function compatibilityField(persisted, replayed, unknownValues = []) {
  const persistedUnknown = persisted == null || unknownValues.includes(persisted);
  if (persistedUnknown) return replayed == null || unknownValues.includes(replayed) ? 'MATCH' : 'REFINEMENT';
  return replayed != null && sameValue(persisted, replayed) ? 'MATCH' : 'CONFLICT';
}

function normalizedState(value) {
  return value == null ? value : String(value).trim().toUpperCase();
}

const QUALITY_RANK = Object.freeze({ INSUFFICIENT: 0, PARTIAL: 1, EXACT: 2 });
const STATUS_RANK = Object.freeze({ UNKNOWN: 0, PARTIAL: 1, READY: 2 });

function monotonicQuality(persisted, replayed) {
  persisted = normalizedState(persisted);
  replayed = normalizedState(replayed);
  if (persisted === replayed) return 'MATCH';
  if (QUALITY_RANK[persisted] != null && QUALITY_RANK[replayed] != null && QUALITY_RANK[replayed] > QUALITY_RANK[persisted]) return 'REFINEMENT';
  return 'CONFLICT';
}

function monotonicStatus(persisted, replayed) {
  persisted = normalizedState(persisted);
  replayed = normalizedState(replayed);
  if (persisted === replayed) return 'MATCH';
  if (STATUS_RANK[persisted] != null && STATUS_RANK[replayed] != null && STATUS_RANK[replayed] > STATUS_RANK[persisted]) return 'REFINEMENT';
  return 'CONFLICT';
}

function historicalCompatibility(row, normalized) {
  const fields = {
    occurredAt: sameTimestamp(row.occurred_at, normalized.occurredAt) ? 'MATCH'
      : row.occurred_at == null ? 'REFINEMENT' : 'CONFLICT',
    amount: compatibilityField(row.amount, normalized.amount),
    currency: compatibilityField(row.currency, normalized.currency),
    direction: compatibilityField(row.direction, normalized.direction, ['UNKNOWN']),
    eventType: compatibilityField(row.event_type, normalized.eventType, ['UNKNOWN']),
    merchant: compatibilityField(row.merchant, normalized.merchant),
    counterparty: compatibilityField(row.counterparty, normalized.counterparty),
    accountReference: compatibilityField(row.account_reference, normalized.accountReference),
    accountReferenceKind: compatibilityField(row.account_reference_kind, normalized.accountReferenceKind),
    normalizationStatus: monotonicStatus(row.normalization_status, normalized.normalizationStatus),
    evidenceQuality: monotonicQuality(row.evidence_quality, normalized.evidenceQuality),
    normalizationVersion: sameValue(row.normalization_version, normalized.normalizationVersion) ? 'SAME' : 'CHANGED',
  };
  return { fields, ok: Object.entries(fields).filter(([key]) => key !== 'normalizationVersion').every(([, value]) => value !== 'CONFLICT') };
}

function safeReference(value) {
  return value == null ? null : '••' + String(value).slice(-4);
}

function historicalAudit(row, normalized, compatibility, current, candidates, provider) {
  const candidate = candidates.length === 1 ? candidates[0] : null;
  return {
    observationId: Number(row.observation_id),
    transactionId: Number(row.transaction_id),
    provider,
    persistedNormalizationVersion: row.normalization_version,
    replayNormalizationVersion: normalized.normalizationVersion,
    referenceKind: normalized.accountReferenceKind,
    maskedReference: safeReference(normalized.accountReference),
    currentResolutionState: current?.resolution_state ?? 'UNKNOWN',
    candidateCount: candidates.length,
    proposedAccountId: candidate ? Number(candidate.financial_account_id) : null,
    proposedAccountDisplayName: candidate?.display_name ?? null,
    proposedResolutionState: candidate ? 'RECONCILED' : 'UNKNOWN',
    compatibilityGate: compatibility.ok ? 'PASS' : 'FAIL',
    compatibility: compatibility.fields,
    reason: 'Historical observation replay proof; bank_transaction evidence was not backfilled',
  };
}

async function loadHistoricalContext(client, observationId) {
  const result = await client.query(`
    SELECT eo.id AS observation_id, eo.payload, eo.payload_sha256, eo.event_time, eo.ingestion_metadata,
      bt.id AS transaction_id, bt.occurred_at, bt.amount, bt.currency, bt.direction,
      bt.merchant, bt.counterparty, bt.account_reference, bt.account_reference_kind,
      bt.event_type, bt.normalization_status, bt.normalization_version, bt.evidence_quality,
      COALESCE(array_agg(DISTINCT p.scope_id) FILTER (WHERE p.scope_id IS NOT NULL), ARRAY[]::bigint[]) AS scope_ids
    FROM bank_event_observations eo
    LEFT JOIN bank_transactions bt ON bt.observation_id=eo.id
    LEFT JOIN bank_source_person sp ON sp.bank_source_id=eo.bank_source_id AND sp.relation_type='OWNER'
    LEFT JOIN persons p ON p.id=sp.person_id
    WHERE eo.id=$1
    GROUP BY eo.id, bt.id
    ORDER BY bt.id`, [observationId]);
  if (!result.rowCount) return { missing: 'observation' };
  if (result.rows.length !== 1) return { missing: 'transaction' };
  const row = result.rows[0];
  if (row.transaction_id == null) return { missing: 'transaction' };
  if (row.scope_ids.length !== 1) return { scopeAmbiguous: true, row };
  return { row, scopeId: Number(row.scope_ids[0]) };
}

async function findHistoricalCandidates(client, context) {
  const metadata = context.row.ingestion_metadata ?? {};
  const provider = metadata.provider;
  const referenceValue = context.normalized.accountReference;
  const referenceKind = context.normalized.accountReferenceKind;
  if (!provider || !referenceValue || !referenceKind) return [];
  return (await client.query(`
    SELECT DISTINCT r.financial_account_id, a.display_name
    FROM bank_account_references r
    JOIN financial_accounts a ON a.id=r.financial_account_id
    WHERE r.provider=$1 AND r.reference_kind=$2 AND r.reference_value=$3 AND a.scope_id=$4
    ORDER BY r.financial_account_id`, [provider, referenceKind, referenceValue, context.scopeId])).rows;
}

async function currentHistoricalResolution(client, transactionId, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const result = await client.query(`SELECT financial_account_id, resolution_state, provenance, reason
    FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1${suffix}`, [transactionId]);
  return result.rows[0] ?? null;
}

export async function resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId, persist = false }) {
  const id = requiredId(observationId, 'observationId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await loadHistoricalContext(client, id);
    if (context.missing === 'observation') return await rollbackHistorical(client, historicalFailure('Observation was not found'));
    if (context.missing === 'transaction') return await rollbackHistorical(client, historicalFailure('Observation does not have exactly one transaction'));
    if (context.scopeAmbiguous) return await rollbackHistorical(client, historicalFailure('Source accounting scope is not unique'));

    const { row } = context;
    if (bankPayloadSha256(row.payload) !== row.payload_sha256) return await rollbackHistorical(client, historicalFailure('Immutable payload hash mismatch'));
    let normalized;
    try {
      normalized = normalizeBankEvent({ eventTime: row.event_time, payload: row.payload, ingestionMetadata: row.ingestion_metadata ?? {} });
    } catch {
      return await rollbackHistorical(client, historicalFailure('Historical payload is not normalizable'));
    }
    context.normalized = normalized;
    if (normalized.normalizationStatus !== 'READY' || normalized.evidenceQuality !== 'EXACT') return await rollbackHistorical(client, historicalFailure('Historical normalization is not READY/EXACT'));
    const provider = row.ingestion_metadata?.provider ?? null;
    const compatibility = historicalCompatibility(row, normalized);
    const candidates = compatibility.ok ? await findHistoricalCandidates(client, context) : [];
    const current = await currentHistoricalResolution(client, Number(row.transaction_id), false);
    const audit = historicalAudit(row, normalized, compatibility, current, candidates, provider);
    if (!compatibility.ok) return await rollbackHistorical(client, historicalFailure('Historical normalization compatibility conflict', { audit, candidateCount: candidates.length }));
    if (candidates.length !== 1) return await rollbackHistorical(client, historicalFailure(candidates.length ? 'Historical account reference is ambiguous' : 'Historical account reference has no candidate', { audit, candidateCount: candidates.length }));

    if (persist) await client.query('SELECT pg_advisory_xact_lock($1)', [Number(row.transaction_id)]);
    const lockedCurrent = persist ? await currentHistoricalResolution(client, Number(row.transaction_id), true) : current;
    const accountId = Number(candidates[0].financial_account_id);
    const lockedAudit = historicalAudit(row, normalized, compatibility, lockedCurrent, candidates, provider);
    if (lockedCurrent?.resolution_state === 'RECONCILED') {
      if (Number(lockedCurrent.financial_account_id) === accountId && lockedCurrent.provenance === HISTORICAL_REPLAY_PROVENANCE) {
        return await rollbackHistorical(client, { status: 'ALREADY_RECONCILED', resolutionState: 'RECONCILED', financialAccountId: accountId, candidateCount: 1, audit: lockedAudit });
      }
      return await rollbackHistorical(client, historicalFailure('Existing reconciliation conflicts with historical replay', { audit: lockedAudit }));
    }
    if (lockedCurrent && lockedCurrent.resolution_state !== 'UNKNOWN') return await rollbackHistorical(client, historicalFailure('Existing resolution is not UNKNOWN', { audit: lockedAudit }));
    if (!persist) return await rollbackHistorical(client, { status: 'DRY_RUN', resolutionState: 'RECONCILED', financialAccountId: accountId, candidateCount: 1, provenance: HISTORICAL_REPLAY_PROVENANCE, audit });

    const reason = 'Historical replay observation ' + row.observation_id + ' transaction ' + row.transaction_id
      + '; persisted version ' + (row.normalization_version ?? 'NULL')
      + ', replay version ' + normalized.normalizationVersion
      + ', provider ' + provider + ', reference ' + normalized.accountReferenceKind + ' ' + safeReference(normalized.accountReference)
      + ', financial account ' + accountId + '; bank_transaction evidence was not backfilled';
    const result = lockedCurrent
      ? await client.query(`UPDATE bank_transaction_account_resolution
          SET financial_account_id=$2, resolution_state='RECONCILED', provenance=$3, reason=$4, resolved_at=NOW()
          WHERE bank_transaction_id=$1 AND resolution_state='UNKNOWN'
          RETURNING bank_transaction_id, financial_account_id, resolution_state, provenance, reason`, [row.transaction_id, accountId, HISTORICAL_REPLAY_PROVENANCE, reason])
      : await client.query(`INSERT INTO bank_transaction_account_resolution
          (bank_transaction_id, financial_account_id, resolution_state, provenance, reason)
          VALUES($1,$2,'RECONCILED',$3,$4)
          RETURNING bank_transaction_id, financial_account_id, resolution_state, provenance, reason`, [row.transaction_id, accountId, HISTORICAL_REPLAY_PROVENANCE, reason]);
    if (!result.rowCount) return await rollbackHistorical(client, historicalFailure('Concurrent resolution changed before persistence'));
    await client.query('COMMIT');
    return { status: 'RECONCILED', ...result.rows[0], candidateCount: 1 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackHistorical(client, result) {
  await client.query('ROLLBACK');
  return result;
}

export const BANK_ACCOUNT_RESOLUTION_STATES = Object.freeze([...RESOLUTION_STATES]);

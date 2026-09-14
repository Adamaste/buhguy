import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { FnsClient } from '../src/fns-client.js';
import { SessionStore } from '../src/session-store.js';
import { normalizeReceiptDetail } from '../src/normalize.js';
import { fiscalContentFingerprint, fiscalIdentityFromRaw, fiscalIdentityKey } from '../src/fiscal-evidence.js';
import { ReceiptRepository } from '../src/database.js';
import { normalizeAndStoreReceipt, NORMALIZATION_VERSION } from '../src/fiscal-normalization.js';
import { dryRunPrepaymentSettlements } from '../src/prepayment-settlement-matcher.js';
import { validateBusinessEventGraph } from '../src/business-event-graph.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = new FnsClient({ sessionStore: new SessionStore({ stateDir: process.env.RECEIPT_COLLECTOR_STATE_DIR }) });

function sha(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function material(raw) {
  return {
    sellerInn: raw?.kktOwnerInn ?? raw?.userInn ?? raw?.inn ?? null,
    dateTime: raw?.dateTime ?? raw?.createdDate ?? raw?.date ?? null,
    totalSum: raw?.totalSum ?? null,
    operationType: raw?.operationType ?? null,
    items: Array.isArray(raw?.items) ? raw.items.map((item) => ({
      name: item?.name ?? item?.productName ?? item?.label ?? null,
      quantity: item?.quantity ?? item?.count ?? item?.amount ?? null,
      price: item?.price ?? item?.itemPrice ?? item?.sumOfUnit ?? null,
      sum: item?.sum ?? item?.total ?? item?.amountSum ?? null,
      paymentType: item?.paymentType ?? null,
      providerInn: item?.providerInn ?? null,
      productCode: item?.productCodeNew?.code?.gtin ?? item?.productCode ?? null,
    })) : [],
  };
}

async function fetchSnapshot() {
  const summaries = [];
  let offset = 0;
  while (true) {
    const page = await client.listReceipts({ limit: 50, offset, orderBy: 'CREATED_DATE:DESC', kktOwner: '' });
    summaries.push(...page.receipts);
    offset += page.receipts.length;
    if (!page.hasMore || page.receipts.length === 0) break;
  }
  const docs = [];
  for (let i = 0; i < summaries.length; i += 8) {
    const batch = await Promise.all(summaries.slice(i, i + 8).map(async (summary) => ({ summary, raw: await client.getReceiptRaw(summary.id) })));
    docs.push(...batch);
  }
  return docs;
}

async function counts() {
  const names = ['receipts', 'receipt_items', 'receipt_raw', 'receipt_fiscal_facts', 'receipt_item_fiscal_facts', 'normalization_issues', 'business_events', 'business_event_evidence', 'business_event_edges', 'business_event_allocations'];
  const out = {};
  for (const name of names) out[name] = Number((await pool.query(`SELECT count(*)::int AS count FROM ${name}`)).rows[0].count);
  out.duplicateFns = Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT fns_id FROM receipts WHERE fns_id IS NOT NULL GROUP BY fns_id HAVING count(*) > 1) q')).rows[0].count);
  out.duplicateTuples = Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL AND fiscal_document_number IS NOT NULL AND fiscal_sign IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1) q')).rows[0].count);
  return out;
}

async function main() {
  const before = await counts();
  const docs = await fetchSnapshot();
  const byTuple = new Map();
  const bySource = new Map();
  for (const doc of docs) {
    const tuple = fiscalIdentityKey(fiscalIdentityFromRaw(doc.raw));
    const source = String(doc.summary.id);
    const entry = { ...doc, tuple, source, materialHash: sha(JSON.stringify(material(doc.raw))) };
    if (tuple) (byTuple.get(tuple) ?? byTuple.set(tuple, []).get(tuple)).push(entry);
    (bySource.get(source) ?? bySource.set(source, []).get(source)).push(entry);
  }
  const dbRows = (await pool.query('SELECT id,fns_id,fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts ORDER BY id')).rows;
  const dbByTuple = new Map(dbRows.filter((r) => r.fiscal_drive_number && r.fiscal_document_number && r.fiscal_sign).map((r) => [`${r.fiscal_drive_number}|${r.fiscal_document_number}|${r.fiscal_sign}`, r]));
  const dbRaw = new Map((await pool.query('SELECT receipt_id,payload FROM receipt_raw')).rows.map((r) => [String(r.receipt_id), r.payload]));
  const matched = [];
  const fnsOnly = [];
  for (const [tuple, entries] of byTuple) {
    const db = dbByTuple.get(tuple);
    if (!db) { fnsOnly.push(entries[0]); continue; }
    const firstMaterial = sha(JSON.stringify(material(entries[0].raw)));
    const dbMaterial = sha(JSON.stringify(material(dbRaw.get(String(db.id)))));
    if (firstMaterial !== dbMaterial) throw new Error(`material mismatch for clone tuple ${tuple}`);
    matched.push({ tuple, dbId: db.id, source: entries[0].source, entries });
  }
  const dbOnly = dbRows.filter((r) => !dbByTuple.has(`${r.fiscal_drive_number}|${r.fiscal_document_number}|${r.fiscal_sign}`) || !byTuple.has(`${r.fiscal_drive_number}|${r.fiscal_document_number}|${r.fiscal_sign}`));
  const duplicateGroups = [...bySource.values()].filter((entries) => entries.length > 1).length;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    for (const row of matched) {
      const result = await tx.query('UPDATE receipts SET fns_id=$1 WHERE id=$2', [row.source, row.dbId]);
      if (result.rowCount !== 1) throw new Error(`clone repair row missing: ${row.dbId}`);
    }
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }

  const repo = new ReceiptRepository(pool);
  async function replay() {
    const result = { fetched: docs.length, inserted: 0, replayed: 0, errors: 0 };
    for (const { summary, raw } of docs) {
      try {
        const saved = await repo.upsertBundle({ normalized: normalizeReceiptDetail(raw, { sourceId: summary.id }), raw, listSummary: summary });
        if (saved.created) result.inserted += 1; else result.replayed += 1;
      } catch (error) { result.errors += 1; result.lastError = error.code ?? error.message; }
    }
    return result;
  }
  const firstReplay = await replay();
  const afterFirstReplay = await counts();
  const secondReplay = await replay();
  const afterSecondReplay = await counts();

  const newIds = (await pool.query('SELECT id FROM receipts WHERE id > $1 ORDER BY id', [Math.max(...dbRows.map((r) => Number(r.id)))])).rows.map((r) => Number(r.id));
  const normalization = { processed: 0, issues: 0, statuses: {} };
  for (const id of newIds) {
    const result = await normalizeAndStoreReceipt(pool, id, NORMALIZATION_VERSION);
    normalization.processed += 1;
    normalization.issues += result.issues.length;
    normalization.statuses[result.facts.normalizationStatus] = (normalization.statuses[result.facts.normalizationStatus] ?? 0) + 1;
  }
  const matcher = await dryRunPrepaymentSettlements(pool, { scopeKey: 'clone-validation' });
  const graph = await validateBusinessEventGraph(pool);
  const afterValidation = await counts();
  console.log(JSON.stringify({
    snapshot: { total: docs.length, distinctTuples: byTuple.size, distinctSources: bySource.size, duplicateSourceGroups: duplicateGroups, exactTupleMatches: matched.length, fnsOnly: fnsOnly.length, dbOnly: dbOnly.length, materialEqual: matched.length },
    repair: { updatedRows: matched.length, fnsOnly: fnsOnly.length, dbOnly: dbOnly.length },
    before,
    firstReplay,
    afterFirstReplay,
    secondReplay,
    afterSecondReplay,
    newReceipts: newIds.length,
    normalization,
    matcher: { summary: matcher.summary },
    graph: { validator: graph, counts: { businessEvents: afterValidation.business_events, evidence: afterValidation.business_event_evidence, edges: afterValidation.business_event_edges, allocations: afterValidation.business_event_allocations } },
  }, null, 2));
}

try { await main(); } finally { await pool.end(); }

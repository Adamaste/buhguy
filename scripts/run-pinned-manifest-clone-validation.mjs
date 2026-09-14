import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { FnsClient } from '../src/fns-client.js';
import { SessionStore } from '../src/session-store.js';
import { normalizeReceiptDetail } from '../src/normalize.js';
import { ReceiptRepository } from '../src/database.js';
import { normalizeAndStoreReceipt, NORMALIZATION_VERSION } from '../src/fiscal-normalization.js';
import { dryRunPrepaymentSettlements } from '../src/prepayment-settlement-matcher.js';
import { validateBusinessEventGraph } from '../src/business-event-graph.js';

const [snapshotPath, manifestPath] = process.argv.slice(2);
const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = new FnsClient({ sessionStore: new SessionStore({ stateDir: process.env.RECEIPT_COLLECTOR_STATE_DIR }), logger: {} });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const material = (raw) => ({ sellerInn: raw?.kktOwnerInn ?? raw?.userInn ?? raw?.inn ?? null, dateTime: raw?.dateTime ?? raw?.createdDate ?? raw?.date ?? null, totalSum: raw?.totalSum ?? null, operationType: raw?.operationType ?? null, items: Array.isArray(raw?.items) ? raw.items.map((item) => ({ name: item?.name ?? item?.productName ?? item?.label ?? null, quantity: item?.quantity ?? item?.count ?? item?.amount ?? null, price: item?.price ?? item?.itemPrice ?? item?.sumOfUnit ?? null, sum: item?.sum ?? item?.total ?? item?.amountSum ?? null, paymentType: item?.paymentType ?? null, providerInn: item?.providerInn ?? null, productCode: item?.productCodeNew?.code?.gtin ?? item?.productCode ?? null })) : [] });
const sourceIdentity = (raw) => `${raw?.fiscalDriveNumber}|${raw?.fiscalDocumentNumber}|${raw?.fiscalSign}`;

async function counts() {
  const names = ['receipts', 'receipt_items', 'receipt_raw', 'receipt_fiscal_facts', 'receipt_item_fiscal_facts', 'normalization_issues', 'business_events', 'business_event_evidence', 'business_event_edges', 'business_event_allocations'];
  const out = {};
  for (const name of names) out[name] = Number((await pool.query(`SELECT count(*)::int AS count FROM ${name}`)).rows[0].count);
  out.duplicateFns = Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT fns_id FROM receipts WHERE fns_id IS NOT NULL GROUP BY fns_id HAVING count(*)>1) q')).rows[0].count);
  out.duplicateTuples = Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL AND fiscal_document_number IS NOT NULL AND fiscal_sign IS NOT NULL GROUP BY 1,2,3 HAVING count(*)>1) q')).rows[0].count);
  return out;
}

async function replay(docs, repo) {
  const result = { fetched: docs.length, inserted: 0, replayed: 0, errors: 0, fiscalIdentityConflicts: 0 };
  for (const { sourceKey, raw } of docs) {
    try {
      const saved = await repo.upsertBundle({ normalized: normalizeReceiptDetail(raw, { sourceId: sourceKey }), raw, listSummary: { id: sourceKey } });
      if (saved.created) result.inserted += 1; else result.replayed += 1;
    } catch (error) { result.errors += 1; if (error.code === 'FISCAL_IDENTITY_CONFLICT') result.fiscalIdentityConflicts += 1; result.lastError = error.code ?? error.message; }
  }
  return result;
}

async function main() {
  const before = await counts();
  const baselineMatcher = await dryRunPrepaymentSettlements(pool, { scopeKey: 'pinned-clone' });
  const docs = [];
  for (let offset = 0; offset < snapshot.entries.length; offset += 8) {
    const batch = await Promise.all(snapshot.entries.slice(offset, offset + 8).map(async (entry) => {
      const raw = await client.getReceiptRaw(entry.sourceKey);
      if (sourceIdentity(raw) !== entry.identityKey || hash(material(raw)) !== entry.materialHash) throw new Error('Pinned snapshot detail changed before clone replay');
      return { sourceKey: entry.sourceKey, raw };
    }));
    docs.push(...batch);
  }
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    for (const row of manifest.safeRepair) {
      const [drive, document, sign] = row.tuple.split('|');
      const result = await tx.query('UPDATE receipts SET fns_id=$1 WHERE id=$2 AND fns_id=$3 AND fiscal_drive_number=$4 AND fiscal_document_number=$5 AND fiscal_sign=$6', [row.newSourceKey, row.receiptId, row.oldFnsId, drive, document, sign]);
      if (result.rowCount !== 1) throw new Error(`Pinned repair precondition failed for clone receipt ${row.receiptId}`);
    }
    if (manifest.safeRepair.length !== 1691 && manifest.safeRepair.length <= 0) throw new Error('Invalid empty pinned repair manifest');
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  const afterRepair = await counts();
  const repo = new ReceiptRepository(pool);
  const firstReplay = await replay(docs, repo);
  const afterFirst = await counts();
  const secondReplay = await replay(docs, repo);
  const afterSecond = await counts();
  const newIds = (await pool.query('SELECT id FROM receipts WHERE id > $1 ORDER BY id', [Math.max(...(await pool.query('SELECT id FROM receipts ORDER BY id')).rows.map((r) => Number(r.id))) - 9])).rows.map((r) => Number(r.id));
  const normalization = { processed: 0, ready: 0, blocked: 0, unsupported: 0, issues: 0 };
  for (const id of newIds) { const result = await normalizeAndStoreReceipt(pool, id, NORMALIZATION_VERSION); normalization.processed += 1; normalization[result.facts.normalizationStatus.toLowerCase()] += 1; normalization.issues += result.issues.length; }
  const finalMatcher = await dryRunPrepaymentSettlements(pool, { scopeKey: 'pinned-clone' });
  const graph = await validateBusinessEventGraph(pool);
  console.log(JSON.stringify({ before, manifest: { safeRepairable: manifest.counts.safeRepairable, unresolvedDbOnly: manifest.counts.unresolvedDbOnly, fnsOnly: manifest.counts.fnsOnly, duplicateGroups: manifest.counts.duplicateGroups, ambiguous: manifest.counts.ambiguous }, afterRepair, firstReplay, afterFirst, secondReplay, afterSecond, normalization, matcher: { before: baselineMatcher.summary, after: finalMatcher.summary }, graph: { validator: graph, counts: { businessEvents: afterSecond.business_events, evidence: afterSecond.business_event_evidence, edges: afterSecond.business_event_edges, allocations: afterSecond.business_event_allocations } } }, null, 2));
}

try { await main(); } finally { await pool.end(); }

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { syncReceipts } from '../src/sync.js';
import { isKnownFnsDetailUnavailable } from '../src/fns-detail-errors.js';
import { validateBusinessEventGraph } from '../src/business-event-graph.js';

const db = process.env.TEST_DATABASE_URL;
if (!db) throw new Error('TEST_DATABASE_URL is required');

const listPath = process.env.AUTHORITATIVE_LIST_PATH ?? 'work/fns-source2-current-list.json';
const list = JSON.parse(await fs.readFile(listPath, 'utf8'));
const pool = createPool({ connectionString: db, max: 12 });
const q = (sql, params = []) => pool.query(sql, params);

function remoteDetailScript(ids) {
  return `import { FnsClient } from '/opt/accountant/receipt-collector/src/fns-client.js';
import { SessionStore } from '/opt/accountant/receipt-collector/src/session-store.js';
const client = new FnsClient({ sessionStore: new SessionStore({ stateDir: '/opt/accountant/receipt-collector/.receipt-collector/source-2' }), logger: {} });
const ids = ${JSON.stringify(ids)};
for (const id of ids) {
  try { const raw = await client.getReceiptRaw(id); process.stdout.write(JSON.stringify({ id, kind: 'ok', raw }) + '\\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ id, kind: 'error', status: error.status ?? null, code: error.code ?? null, message: error.message ?? null }) + '\\n'); }
}
`;
}

function quietLogger() { return { info() {}, warn() {}, error() {} }; }

await migrate(pool);
const baseline = (await q(`SELECT
  (SELECT count(*)::int FROM receipts) receipts,
  (SELECT count(*)::int FROM receipt_items) receipt_items,
  (SELECT count(*)::int FROM receipt_raw) receipt_raw,
  (SELECT count(*)::int FROM receipt_source_observations) observations`)).rows[0];
const source = (await q("SELECT id,source_key FROM fns_sources WHERE source_key='fns-source-2'")).rows[0];
if (!source) throw new Error('source #2 is absent from clone');
await q('DELETE FROM fns_source_receipt_refs WHERE fns_source_id=$1', [source.id]);
await q(`INSERT INTO fns_source_receipt_refs
  (fns_source_id,source_receipt_id,receipt_id,status,resolved_at,first_seen_at,last_seen_at)
  SELECT fns_source_id,source_receipt_id,receipt_id,'RESOLVED',now(),now(),now()
  FROM receipt_source_observations WHERE fns_source_id=$1
  ON CONFLICT (fns_source_id,source_receipt_id) DO NOTHING`, [source.id]);

const existing = new Set((await q('SELECT source_receipt_id FROM fns_source_receipt_refs WHERE fns_source_id=$1 AND status=\'RESOLVED\'', [source.id])).rows.map((row) => row.source_receipt_id));
const currentIds = list.ids.map(String);
const unresolved = currentIds.filter((id) => !existing.has(id));
const detailResultsPath = process.env.AUTHORITATIVE_DETAIL_RESULTS_PATH ?? 'work/fns-source2-unresolved-results.json';
const detailMap = new Map((JSON.parse(await fs.readFile(detailResultsPath, 'utf8'))).map((row) => [String(row.id), row]));
if (detailMap.size !== unresolved.length) throw new Error(`detail response count mismatch: ${detailMap.size}/${unresolved.length}`);
const client = {
  async listReceipts() { return { hasMore: false, receipts: currentIds.map((id) => ({ id })) }; },
  async getReceiptRaw(id) {
    const result = detailMap.get(String(id));
    if (!result) throw new Error('detail was not retrieved for unresolved source reference');
    if (result.kind === 'error') throw Object.assign(new Error(result.message ?? 'FNS detail error'), { status: result.status, code: result.code });
    return result.raw;
  },
};
const repository = new ReceiptRepository(pool);
const first = await syncReceipts({ client, repository, sourceContext: { sourceId: source.id, sourceKey: source.source_key }, detailErrorClassifier: isKnownFnsDetailUnavailable, logger: quietLogger(), pageSize: 50 });
const statuses = (await q(`SELECT status,count(*)::int AS count FROM fns_source_receipt_refs WHERE fns_source_id=$1 GROUP BY status ORDER BY status`, [source.id])).rows;
const known422 = [...detailMap.values()].filter((row) => row.kind === 'error' && row.status === 422 && isKnownFnsDetailUnavailable({ status: row.status, code: row.code, message: row.message })).length;
const recoveredTo200 = [...detailMap.values()].filter((row) => row.kind === 'ok').length;
const unavailableSafety = (await q(`SELECT count(*) FILTER (WHERE r.receipt_id IS NOT NULL)::int AS linked,
  count(*) FILTER (WHERE x.id IS NOT NULL)::int AS canonical_rows,
  count(*) FILTER (WHERE raw.receipt_id IS NOT NULL)::int AS raw_rows,
  count(*) FILTER (WHERE n.receipt_id IS NOT NULL)::int AS observation_rows
  FROM fns_source_receipt_refs r
  LEFT JOIN receipts x ON false
  LEFT JOIN receipt_raw raw ON raw.receipt_id=r.receipt_id
  LEFT JOIN receipt_source_observations n ON n.receipt_id=r.receipt_id
  WHERE r.fns_source_id=$1 AND r.status='FNS_DETAIL_UNAVAILABLE'`, [source.id])).rows[0];
const duplicates = (await q(`SELECT
  (SELECT count(*) FROM (SELECT fns_id FROM receipts GROUP BY fns_id HAVING count(*)>1) x) duplicate_fns_id,
  (SELECT count(*) FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL AND fiscal_document_number IS NOT NULL AND fiscal_sign IS NOT NULL GROUP BY 1,2,3 HAVING count(*)>1) x) duplicate_canonical_tuple,
  (SELECT count(*) FROM normalization_issues) normalization_issues`)).rows[0];
const graph = await validateBusinessEventGraph(pool);
const cycleExitCode = first.errors || first.unclassified ? 2 : 0;
const result = { authoritativeList: { count: list.count, distinctCount: list.distinctCount, pages: list.pages, setSha256: list.sourceReceiptIdSetSha256, retrievedAt: list.retrievedAt, minDate: list.minDate, maxDate: list.maxDate }, clone: { baseline, source, existingResolved: existing.size, unresolvedRequested: unresolved.length, firstSync: first, lifecycleStatuses: statuses, known422, recoveredTo200, unavailableSafety, duplicates, graph, cycle: { exitCode: cycleExitCode, derivedFromSameSourceResult: true } }, coverageEquation: { listed: currentIds.length, resolved: statuses.find((row) => row.status === 'RESOLVED')?.count ?? 0, unavailable: statuses.find((row) => row.status === 'FNS_DETAIL_UNAVAILABLE')?.count ?? 0, retryable: statuses.find((row) => row.status === 'RETRYABLE_DETAIL_ERROR')?.count ?? 0, conflict: statuses.find((row) => row.status === 'CONFLICT')?.count ?? 0, unclassified: 0 } };
assert.equal(result.authoritativeList.count, result.authoritativeList.distinctCount);
assert.equal(first.fetched, currentIds.length);
assert.equal(first.errors, 0);
assert.equal(first.unclassified, 0);
assert.equal(result.coverageEquation.listed, result.coverageEquation.resolved + result.coverageEquation.unavailable + result.coverageEquation.retryable + result.coverageEquation.conflict);
assert.equal(cycleExitCode, 0);
await fs.writeFile('artifacts/fns-detail-unavailable-v1-authoritative-cohort.json', `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
await pool.end();

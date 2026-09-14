import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { syncReceipts } from '../src/sync.js';
import { isKnownFnsDetailUnavailable } from '../src/fns-detail-errors.js';
import { runSourceSyncCycle } from '../src/source-sync-cycle.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required');

const pool = createPool({ connectionString, max: 12 });
const q = (sql, params = []) => pool.query(sql, params);
const json = (value) => JSON.stringify(value, null, 2);

function logger() { return { info() {}, warn() {}, error() {} }; }
function detail(id) {
  return {
    key: id,
    dateTime: '2026-01-01T00:00:00Z',
    user: 'Clone seller',
    userInn: '7700000000',
    totalSum: 10,
    operationType: 1,
    fiscalDriveNumber: `fd-${id}`,
    fiscalDocumentNumber: `doc-${id}`,
    fiscalSign: `sign-${id}`,
    items: [{ name: 'Clone item', quantity: 1, price: 10, sum: 10 }],
  };
}

async function run() {
  await migrate(pool);
  const testSourceIds = (await q("SELECT id FROM fns_sources WHERE source_key LIKE 'clone-test-%'")).rows.map((row) => row.id);
  if (testSourceIds.length) await q('DELETE FROM fns_source_receipt_refs WHERE fns_source_id = ANY($1::bigint[])', [testSourceIds]);
  const testReceipts = (await q("SELECT id FROM receipts WHERE fns_id LIKE 'clone-test-%'")).rows.map((row) => row.id);
  if (testReceipts.length) {
    await q('DELETE FROM receipt_source_observations WHERE receipt_id = ANY($1::bigint[])', [testReceipts]);
    await q('DELETE FROM receipt_raw WHERE receipt_id = ANY($1::bigint[])', [testReceipts]);
    await q('DELETE FROM receipt_items WHERE receipt_id = ANY($1::bigint[])', [testReceipts]);
    await q('DELETE FROM receipts WHERE id = ANY($1::bigint[])', [testReceipts]);
  }
  await q("DELETE FROM fns_sources WHERE source_key LIKE 'clone-test-%'");
  const baseline = (await q(`SELECT
    (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM receipt_items) AS receipt_items,
    (SELECT count(*)::int FROM receipt_raw) AS receipt_raw,
    (SELECT count(*)::int FROM receipt_source_observations) AS observations`)).rows[0];

  const sources = (await q('SELECT id, source_key, enabled FROM fns_sources ORDER BY id')).rows;
  const backfill = [];
  for (const source of sources) {
    const result = await q(`INSERT INTO fns_source_receipt_refs
      (fns_source_id, source_receipt_id, receipt_id, status, resolved_at, first_seen_at, last_seen_at)
      SELECT fns_source_id, source_receipt_id, receipt_id, 'RESOLVED', now(), now(), now()
      FROM receipt_source_observations
      WHERE fns_source_id=$1
      ON CONFLICT (fns_source_id, source_receipt_id) DO NOTHING`, [source.id]);
    const count = (await q('SELECT count(*)::int AS count FROM fns_source_receipt_refs WHERE fns_source_id=$1', [source.id])).rows[0].count;
    backfill.push({ sourceId: source.id, sourceKey: source.source_key, inserted: result.rowCount, total: count });
  }

  const backfillAgain = [];
  for (const source of sources) {
    const result = await q(`INSERT INTO fns_source_receipt_refs
      (fns_source_id, source_receipt_id, receipt_id, status, resolved_at, first_seen_at, last_seen_at)
      SELECT fns_source_id, source_receipt_id, receipt_id, 'RESOLVED', now(), now(), now()
      FROM receipt_source_observations
      WHERE fns_source_id=$1
      ON CONFLICT (fns_source_id, source_receipt_id) DO NOTHING`, [source.id]);
    backfillAgain.push({ sourceId: source.id, inserted: result.rowCount });
  }

  const sourceTwo = sources.find((source) => /2|second/i.test(source.source_key)) ?? sources.at(-1);
  const sourceTwoRefs = sourceTwo
    ? Number((await q('SELECT count(*)::int AS count FROM fns_source_receipt_refs WHERE fns_source_id=$1', [sourceTwo.id])).rows[0].count)
    : 0;

  const testRepository = new ReceiptRepository(pool);
  const testSource = await testRepository.ensureSource({
    sourceKey: 'clone-test-fns-detail-unavailable',
    sessionRef: 'clone-only://fns-detail-unavailable',
    personKey: 'clone-test-person',
    enabled: true,
  });

  const unavailableId = 'clone-test-known-422';
  let mode = 'unavailable';
  let detailCalls = 0;
  const client = {
    async listReceipts() { return { hasMore: false, receipts: [{ id: unavailableId }] }; },
    async getReceiptRaw(id) {
      detailCalls += 1;
      if (mode === 'unavailable') throw Object.assign(new Error('known test unavailable'), { status: 422, code: 'CLONE_KNOWN_DETAIL_UNAVAILABLE' });
      return detail(id);
    },
  };
  const classifyKnown = (error) => error.status === 422 && error.code === 'CLONE_KNOWN_DETAIL_UNAVAILABLE';
  const first = await syncReceipts({ client, repository: testRepository, sourceContext: { sourceId: testSource.id }, detailErrorClassifier: classifyKnown, logger: logger() });
  const unavailableState = (await q('SELECT status,receipt_id,detail_attempt_count,detail_next_retry_at FROM fns_source_receipt_refs WHERE fns_source_id=$1 AND source_receipt_id=$2', [testSource.id, unavailableId])).rows[0];
  assert.equal(first.detailUnavailable, 1);
  assert.equal(first.errors, 0);
  assert.equal(unavailableState.status, 'FNS_DETAIL_UNAVAILABLE');
  assert.equal(unavailableState.receipt_id, null);
  assert.equal(Number(unavailableState.detail_attempt_count), 1);
  assert.ok(unavailableState.detail_next_retry_at);

  const callsBeforeSkip = detailCalls;
  const skipped = await syncReceipts({ client, repository: testRepository, sourceContext: { sourceId: testSource.id }, detailErrorClassifier: classifyKnown, logger: logger() });
  assert.equal(skipped.retryPending, 1);
  assert.equal(detailCalls, callsBeforeSkip);

  await q('UPDATE fns_source_receipt_refs SET detail_next_retry_at=now() WHERE fns_source_id=$1 AND source_receipt_id=$2', [testSource.id, unavailableId]);
  mode = 'resolved';
  const recovered = await syncReceipts({ client, repository: testRepository, sourceContext: { sourceId: testSource.id }, detailErrorClassifier: classifyKnown, logger: logger() });
  assert.equal(recovered.inserted, 1);
  assert.equal(recovered.errors, 0);
  const recoveredState = (await q('SELECT status,receipt_id,resolved_at FROM fns_source_receipt_refs WHERE fns_source_id=$1 AND source_receipt_id=$2', [testSource.id, unavailableId])).rows[0];
  assert.equal(recoveredState.status, 'RESOLVED');
  assert.ok(recoveredState.receipt_id);
  assert.ok(recoveredState.resolved_at);
  const replay = await syncReceipts({ client, repository: testRepository, sourceContext: { sourceId: testSource.id }, detailErrorClassifier: classifyKnown, logger: logger() });
  assert.equal(replay.inserted, 0);
  assert.equal(replay.errors, 0);

  const unknownId = 'clone-test-unknown-error';
  const unknownSource = await testRepository.ensureSource({ sourceKey: 'clone-test-unknown-error', sessionRef: 'clone-only://unknown', personKey: 'clone-test-unknown-person', enabled: true });
  const unknownClient = {
    async listReceipts() { return { hasMore: false, receipts: [{ id: unknownId }] }; },
    async getReceiptRaw() { throw Object.assign(new Error('unknown test error'), { status: 422, code: 'CLONE_UNKNOWN_422' }); },
  };
  const unknown = await syncReceipts({ client: unknownClient, repository: testRepository, sourceContext: { sourceId: unknownSource.id }, logger: logger() });
  const unknownState = (await q('SELECT status,detail_attempt_count FROM fns_source_receipt_refs WHERE fns_source_id=$1 AND source_receipt_id=$2', [unknownSource.id, unknownId])).rows[0];
  assert.equal(unknown.unclassified, 1);
  assert.equal(unknownState.status, 'RETRYABLE_DETAIL_ERROR');
  assert.equal(isKnownFnsDetailUnavailable({ status: 422, code: 'CLONE_UNKNOWN_422', message: 'other' }), false);

  const retrySource = await testRepository.ensureSource({ sourceKey: 'clone-test-retry-schedule', sessionRef: 'clone-only://retry', personKey: 'clone-test-retry-person', enabled: true });
  const retryId = 'clone-test-retry-schedule-ref';
  const retryClient = { async listReceipts() { return { hasMore: false, receipts: [{ id: retryId }] }; }, async getReceiptRaw() { throw Object.assign(new Error('known retry test unavailable'), { status: 422, code: 'CLONE_RETRY_422' }); } };
  const classifyRetry = (error) => error.status === 422 && error.code === 'CLONE_RETRY_422';
  const retry1 = await syncReceipts({ client: retryClient, repository: testRepository, sourceContext: { sourceId: retrySource.id }, detailErrorClassifier: classifyRetry, logger: logger() });
  const retryState1 = (await q('SELECT detail_attempt_count,detail_next_retry_at FROM fns_source_receipt_refs WHERE fns_source_id=$1 AND source_receipt_id=$2', [retrySource.id, retryId])).rows[0];
  await q('UPDATE fns_source_receipt_refs SET detail_next_retry_at=now() WHERE fns_source_id=$1 AND source_receipt_id=$2', [retrySource.id, retryId]);
  const retry2 = await syncReceipts({ client: retryClient, repository: testRepository, sourceContext: { sourceId: retrySource.id }, detailErrorClassifier: classifyRetry, logger: logger() });
  const retryState2 = (await q('SELECT detail_attempt_count,detail_next_retry_at FROM fns_source_receipt_refs WHERE fns_source_id=$1 AND source_receipt_id=$2', [retrySource.id, retryId])).rows[0];
  await q('UPDATE fns_source_receipt_refs SET detail_next_retry_at=now() WHERE fns_source_id=$1 AND source_receipt_id=$2', [retrySource.id, retryId]);
  const retry3 = await syncReceipts({ client: retryClient, repository: testRepository, sourceContext: { sourceId: retrySource.id }, detailErrorClassifier: classifyRetry, logger: logger() });
  const retryState3 = (await q('SELECT detail_attempt_count,detail_next_retry_at FROM fns_source_receipt_refs WHERE fns_source_id=$1 AND source_receipt_id=$2', [retrySource.id, retryId])).rows[0];
  assert.equal(Number(retryState1.detail_attempt_count), 1);
  assert.equal(Number(retryState2.detail_attempt_count), 2);
  assert.equal(Number(retryState3.detail_attempt_count), 3);
  const retryHours = (a, b) => (new Date(b).getTime() - Date.now()) / 3600000;
  assert.ok(retryHours(0, retryState1.detail_next_retry_at) > 23);
  assert.ok(retryHours(0, retryState2.detail_next_retry_at) > 24 * 6);
  assert.ok(retryHours(0, retryState3.detail_next_retry_at) > 24 * 29);

  const cycleSourceKey = 'clone-test-cycle-known';
  const cycleConfig = `artifacts/fns-detail-unavailable-v1-cycle-config-${process.pid}.json`;
  await writeFile(cycleConfig, JSON.stringify([{ sourceKey: cycleSourceKey, personKey: 'clone-test-cycle-person', sessionDir: 'clone-only' }]), 'utf8');
  mode = 'unavailable';
  const cycleKnown = await runSourceSyncCycle({
    repository: testRepository,
    configFile: cycleConfig,
    runSource: ({ sourceRow }) => syncReceipts({ client, repository: testRepository, sourceContext: { sourceId: sourceRow.id }, detailErrorClassifier: classifyKnown, logger: logger() }),
    logger: logger(),
  });
  assert.equal(cycleKnown.exitCode, 0);
  const cycleUnknown = await runSourceSyncCycle({
    repository: testRepository,
    configFile: cycleConfig,
    runSource: ({ sourceRow }) => syncReceipts({ client: unknownClient, repository: testRepository, sourceContext: { sourceId: sourceRow.id }, logger: logger() }),
    logger: logger(),
  });
  assert.equal(cycleUnknown.exitCode, 2);

  const final = (await q(`SELECT
    (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM receipt_items) AS receipt_items,
    (SELECT count(*)::int FROM receipt_raw) AS receipt_raw,
    (SELECT count(*)::int FROM receipt_source_observations) AS observations,
    (SELECT count(*)::int FROM fns_source_receipt_refs WHERE status='RESOLVED') AS resolved_refs,
    (SELECT count(*)::int FROM fns_source_receipt_refs WHERE status='FNS_DETAIL_UNAVAILABLE') AS unavailable_refs,
    (SELECT count(*)::int FROM fns_source_receipt_refs WHERE status='RETRYABLE_DETAIL_ERROR') AS retryable_refs`)).rows[0];
  const invariants = (await q(`SELECT
    (SELECT count(*) FROM (SELECT fns_id FROM receipts GROUP BY fns_id HAVING count(*)>1) d) AS duplicate_fns_id,
    (SELECT count(*) FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL AND fiscal_document_number IS NOT NULL AND fiscal_sign IS NOT NULL GROUP BY 1,2,3 HAVING count(*)>1) d) AS duplicate_canonical_tuple`)).rows[0];
  const result = { migration009: true, baseline, sources, backfill, backfillAgain, sourceTwoExistingRefs: sourceTwoRefs, historical141: { authoritativeIdsAvailableInClone: false, action: 'not reconstructed or synthesized' }, tests: { known422: first, unavailableState, skipBeforeDue: skipped, recovery422to200: recovered, replay, unknownError: unknown, unknownState, retryPersistence: { retry1, retry2, retry3, retryState1, retryState2, retryState3 }, sourceCycle: { knownUnavailableExitCode: cycleKnown.exitCode, unexpectedErrorExitCode: cycleUnknown.exitCode }, detailCalls }, final, invariants };
  await writeFile('artifacts/fns-detail-unavailable-v1-clone-results.json', `${json(result)}\n`, 'utf8');
  console.log(json(result));
}

try { await run(); } finally { await pool.end(); }

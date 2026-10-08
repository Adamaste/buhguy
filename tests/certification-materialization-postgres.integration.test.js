import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { materializeCurrentCertificationForTest } from '../src/certification-materialization.js';
import { resolveCurrentSpendingSnapshot } from '../src/canonical-spending-current-snapshot.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
let pool;

before(async () => { if (process.env.TEST_DATABASE_URL) pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
after(async () => { await pool?.end(); });

async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM reconciliation_runs) AS runs,
    (SELECT count(*)::int FROM certification_facts) AS facts,
    (SELECT count(*)::int FROM reconciliation_results) AS results`)).rows[0];
}

async function clearCertification() {
  await pool.query('DELETE FROM reconciliation_results');
  await pool.query('DELETE FROM certification_facts');
  await pool.query('DELETE FROM reconciliation_runs');
}

integration('materializes one full unbounded READY snapshot and reuses it idempotently', { concurrency: false }, async () => {
  await clearCertification();
  const first = await materializeCurrentCertificationForTest(pool, { scopeKey: 'default' });
  assert.equal(first.materialized, true);
  assert.equal(first.reused, false);
  assert.ok(first.runId);
  assert.ok(first.facts > 0);
  assert.ok(first.results > 0);
  const ready = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
  assert.equal(ready.ok, true);
  assert.equal(ready.snapshot.status, 'READY');
  assert.equal(ready.snapshot.runId, first.runId);
  const beforeRetry = await counts();
  const retry = await materializeCurrentCertification(pool, { scopeKey: 'default' });
  assert.deepEqual(retry, { ...first, materialized: false, reused: true });
  assert.deepEqual(await counts(), beforeRetry);
});

integration('injected run, fact and result failures rollback all materialization rows', { concurrency: false }, async () => {
  for (const failAfter of ['run', 'facts', 'results']) {
    await clearCertification();
    const before = await counts();
    await assert.rejects(
      () => materializeCurrentCertificationForTest(pool, { scopeKey: 'default', failAfter }),
      (error) => error.code === 'INJECTED_CERTIFICATION_MATERIALIZATION_FAILURE',
    );
    assert.deepEqual(await counts(), before);
  }
});

integration('serializable materialization rejects a concurrent source change rather than hiding it', { concurrency: false }, async () => {
  await clearCertification();
  const sourceWriter = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let receiptId;
  try {
    await assert.rejects(
      () => materializeCurrentCertificationForTest(pool, {
        scopeKey: 'default',
        afterProjection: async () => {
          receiptId = Number((await sourceWriter.query("INSERT INTO receipts(fns_id,source,total_sum,currency) VALUES($1,'materialization-concurrent',0,'RUB') RETURNING id", [`materialization-${Date.now()}`])).rows[0].id);
        },
      }),
      (error) => ['CERTIFICATION_SOURCE_STATE_CONFLICT', 'CERTIFICATION_MATERIALIZATION_RETRY_REQUIRED'].includes(error.code),
    );
  } finally {
    if (receiptId) await sourceWriter.query('DELETE FROM receipts WHERE id=$1', [receiptId]);
    await sourceWriter.end();
  }
});

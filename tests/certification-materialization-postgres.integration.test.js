import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  materializeCurrentCertification,
  materializeCurrentCertificationForTest,
} from '../src/certification-materialization.js';
import { certificationSourceStateKey } from '../src/certification.js';
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

async function installAnalyticsViewsOnDisposableFixture() {
  await pool.query(readFileSync(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
}

async function currentSourceStateKey() {
  return certificationSourceStateKey(pool, 1);
}

async function summaryTotals(view, runId, sourceStateKey) {
  return (await pool.query(`SELECT currency,
      COALESCE(SUM(gross_spend), 0)::text AS gross_spend,
      COALESCE(SUM(confirmed_returns), 0)::text AS confirmed_returns,
      COALESCE(SUM(net_spend), 0)::text AS net_spend
    FROM ${view}
    WHERE scope_id=1 AND certification_run_id=$1 AND source_state_key=$2
    GROUP BY currency ORDER BY currency`, [runId, sourceStateKey])).rows;
}

integration('materializes one full unbounded READY snapshot and reuses it idempotently', { concurrency: false }, async () => {
  await clearCertification();
  await installAnalyticsViewsOnDisposableFixture();
  const expectedSourceStateKey = await currentSourceStateKey();
  const first = await materializeCurrentCertificationForTest(pool, { scopeKey: 'default', expectedSourceStateKey });
  assert.equal(first.materialized, true);
  assert.equal(first.reused, false);
  assert.ok(first.runId);
  assert.ok(first.facts > 0);
  assert.ok(first.results > 0);
  const ready = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
  assert.equal(ready.ok, true);
  assert.equal(ready.snapshot.status, 'READY');
  assert.equal(ready.snapshot.runId, first.runId);
  assert.equal(first.postCommitCurrent, true);
  const household = await summaryTotals('canonical_spending_household_summary_v1', first.runId, first.sourceStateKey);
  assert.deepEqual(await summaryTotals('canonical_spending_category_summary_v1', first.runId, first.sourceStateKey), household);
  assert.deepEqual(await summaryTotals('canonical_spending_person_summary_v1', first.runId, first.sourceStateKey), household);
  const currentFacts = (await pool.query('SELECT count(*)::int AS count, count(DISTINCT source_state_key)::int AS states FROM certification_facts WHERE run_id=$1', [first.runId])).rows[0];
  assert.equal(currentFacts.count, first.facts);
  assert.equal(currentFacts.states, 1);
  assert.equal((await pool.query('SELECT count(*)::int FROM reconciliation_results WHERE run_id=$1', [first.runId])).rows[0].count, first.results);
  const beforeRetry = await counts();
  const retry = await materializeCurrentCertification(pool, { scopeKey: 'default', expectedSourceStateKey: first.sourceStateKey });
  assert.deepEqual(retry, { ...first, materialized: false, reused: true });
  assert.deepEqual(await counts(), beforeRetry);
});

integration('missing or wrong expected source state fails before certification writes', { concurrency: false }, async () => {
  await clearCertification();
  const before = await counts();
  await assert.rejects(
    () => materializeCurrentCertification(pool, { scopeKey: 'default' }),
    (error) => error.code === 'CERTIFICATION_EXPECTED_SOURCE_STATE_REQUIRED',
  );
  await assert.rejects(
    () => materializeCurrentCertification(pool, { scopeKey: 'default', expectedSourceStateKey: '0'.repeat(64) }),
    (error) => error.code === 'CERTIFICATION_SOURCE_STATE_CONFLICT',
  );
  assert.deepEqual(await counts(), before);
});

integration('injected run, fact and result failures rollback all materialization rows', { concurrency: false }, async () => {
  for (const failAfter of ['run', 'facts', 'results']) {
    await clearCertification();
    const before = await counts();
    const expectedSourceStateKey = await currentSourceStateKey();
    await assert.rejects(
      () => materializeCurrentCertificationForTest(pool, { scopeKey: 'default', expectedSourceStateKey, failAfter }),
      (error) => error.code === 'INJECTED_CERTIFICATION_MATERIALIZATION_FAILURE',
    );
    assert.deepEqual(await counts(), before);
  }
});

integration('serializable materialization rejects a concurrent source change rather than hiding it', { concurrency: false }, async () => {
  await clearCertification();
  const sourceWriter = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let entryId;
  let originalDescription;
  try {
    const expectedSourceStateKey = await currentSourceStateKey();
    const entry = (await sourceWriter.query('SELECT id,description FROM ledger_entries ORDER BY id LIMIT 1')).rows[0];
    assert.ok(entry, 'disposable fixture must contain a ledger entry');
    entryId = entry.id;
    originalDescription = entry.description;
    await assert.rejects(
      () => materializeCurrentCertificationForTest(pool, {
        scopeKey: 'default',
        expectedSourceStateKey,
        afterProjection: async () => {
          await sourceWriter.query(
            'UPDATE ledger_entries SET description=$2 WHERE id=$1',
            [entryId, `${originalDescription ?? ''} concurrent-source-change`],
          );
        },
      }),
      (error) => ['CERTIFICATION_SOURCE_STATE_CONFLICT', 'CERTIFICATION_MATERIALIZATION_RETRY_REQUIRED'].includes(error.code),
    );
  } finally {
    if (entryId !== undefined) await sourceWriter.query('UPDATE ledger_entries SET description=$2 WHERE id=$1', [entryId, originalDescription]);
    await sourceWriter.end();
  }
});

integration('overall materialization timeout rolls back before writing certification rows', { concurrency: false }, async () => {
  await clearCertification();
  const before = await counts();
  const expectedSourceStateKey = await currentSourceStateKey();
  await assert.rejects(
    () => materializeCurrentCertificationForTest(pool, {
      scopeKey: 'default',
      expectedSourceStateKey,
      overallTimeoutMs: 10,
      afterProjection: async () => new Promise((resolve) => setTimeout(resolve, 25)),
    }),
    (error) => error.code === 'CERTIFICATION_MATERIALIZATION_TIMEOUT',
  );
  assert.deepEqual(await counts(), before);
});

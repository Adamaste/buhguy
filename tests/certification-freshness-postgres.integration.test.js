import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { certificationSourceStateKey, CERTIFICATION_MODEL_VERSION } from '../src/certification.js';
import { materializeCurrentCertificationForTest } from '../src/certification-materialization.js';
import { inspectCertificationFreshness, CERTIFICATION_FRESHNESS_STATUS } from '../src/certification-freshness.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
let pool;

before(async () => { if (process.env.TEST_DATABASE_URL) pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
after(async () => { await pool?.end(); });

async function clearCertification() {
  await pool.query('DELETE FROM reconciliation_results');
  await pool.query('DELETE FROM certification_facts');
  await pool.query('DELETE FROM reconciliation_runs');
}

async function persistenceState() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM reconciliation_runs) AS runs,
    (SELECT count(*)::int FROM certification_facts) AS facts,
    (SELECT count(*)::int FROM reconciliation_results) AS results`)).rows[0];
}

async function currentKey() { return certificationSourceStateKey(pool, 1); }

async function seedReady() {
  await clearCertification();
  const sourceStateKey = await currentKey();
  const materialized = await materializeCurrentCertificationForTest(pool, { scopeKey: 'default', expectedSourceStateKey: sourceStateKey });
  return { sourceStateKey, runId: materialized.runId };
}

integration('returns READY only for one coherent exact current run and performs no writes', { concurrency: false }, async () => {
  const seeded = await seedReady();
  const before = await persistenceState();
  const result = await inspectCertificationFreshness(pool);
  assert.equal(result.status, CERTIFICATION_FRESHNESS_STATUS.READY);
  assert.equal(result.currentRunId, seeded.runId);
  assert.equal(result.sourceStateKey, seeded.sourceStateKey);
  assert.deepEqual(await persistenceState(), before);
});

integration('distinguishes missing and stale snapshots after a source change', { concurrency: false }, async () => {
  await clearCertification();
  const missingBefore = await persistenceState();
  const missing = await inspectCertificationFreshness(pool);
  assert.equal(missing.status, CERTIFICATION_FRESHNESS_STATUS.MISSING);
  assert.equal(missing.reasonCode, 'NO_CURRENT_CERTIFICATION');
  assert.deepEqual(await persistenceState(), missingBefore);

  const seeded = await seedReady();
  const row = (await pool.query('SELECT id,description FROM ledger_entries ORDER BY id LIMIT 1')).rows[0];
  assert.ok(row);
  const changed = `${row.description ?? ''} freshness-fixture`;
  await pool.query('UPDATE ledger_entries SET description=$2 WHERE id=$1', [row.id, changed]);
  try {
    const before = await persistenceState();
    const stale = await inspectCertificationFreshness(pool);
    assert.equal(stale.status, CERTIFICATION_FRESHNESS_STATUS.STALE);
    assert.equal(stale.previousRunId, seeded.runId);
    assert.notEqual(stale.sourceStateKey, seeded.sourceStateKey);
    assert.deepEqual(await persistenceState(), before);
  } finally {
    await pool.query('UPDATE ledger_entries SET description=$2 WHERE id=$1', [row.id, row.description]);
  }
});

integration('schema uniqueness prevents exact-run conflicts and non-ready exact runs are rejected', { concurrency: false }, async () => {
  const seeded = await seedReady();
  await assert.rejects(
    () => pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,period_from,period_to,finished_at)
      VALUES(1,$1,$2,'READY',NULL,NULL,NOW())`, [CERTIFICATION_MODEL_VERSION, seeded.sourceStateKey]),
    (error) => error.code === '23505' && error.message.includes('reconciliation_runs_scope_model_state_period_unique'),
  );
  const coherent = await inspectCertificationFreshness(pool);
  assert.equal(coherent.status, CERTIFICATION_FRESHNESS_STATUS.READY);
  await clearCertification();
  const sourceStateKey = await currentKey();
  await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,period_from,period_to)
    VALUES(1,$1,$2,'RUNNING',NULL,NULL)`, [CERTIFICATION_MODEL_VERSION, sourceStateKey]);
  const corrupt = await inspectCertificationFreshness(pool);
  assert.equal(corrupt.status, CERTIFICATION_FRESHNESS_STATUS.CORRUPT);
});

integration('rejects a corrupted exact READY snapshot without changing history', { concurrency: false }, async () => {
  const seeded = await seedReady();
  const fact = (await pool.query('SELECT id,amount FROM certification_facts WHERE run_id=$1 ORDER BY id LIMIT 1', [seeded.runId])).rows[0];
  assert.ok(fact);
  const before = await persistenceState();
  await pool.query('UPDATE certification_facts SET amount=amount+0.01 WHERE id=$1', [fact.id]);
  try {
    const corrupt = await inspectCertificationFreshness(pool);
    assert.equal(corrupt.status, CERTIFICATION_FRESHNESS_STATUS.CORRUPT);
    assert.deepEqual(await persistenceState(), before);
  } finally {
    await pool.query('UPDATE certification_facts SET amount=$2 WHERE id=$1', [fact.id, fact.amount]);
  }
});

integration('runs in a read-only repeatable-read transaction and rejects DB failures safely', { concurrency: false }, async () => {
  const queries = [];
  const failingPool = {
    async connect() {
      return {
        async query(sql) {
          queries.push(String(sql));
          if (/BEGIN|SET LOCAL|ROLLBACK/i.test(String(sql))) return { rows: [] };
          const error = new Error('fixture database failure');
          error.code = 'XX999';
          throw error;
        },
        release() {},
      };
    },
  };
  const result = await inspectCertificationFreshness(failingPool);
  assert.equal(result.status, CERTIFICATION_FRESHNESS_STATUS.TECHNICAL_ERROR);
  assert.ok(queries.some((query) => query.includes('REPEATABLE READ READ ONLY')));
  assert.ok(queries.includes('ROLLBACK'));
});

integration('maps statement timeout to a safe technical status and leaves persisted history unchanged', { concurrency: false }, async () => {
  const before = await persistenceState();
  const timeoutPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          if (/SELECT id,scope_key/.test(String(sql))) {
            const error = new Error('statement timeout');
            error.code = '57014';
            throw error;
          }
          return client.query(sql, params);
        },
        release() { client.release(); },
      };
    },
  };
  const result = await inspectCertificationFreshness(timeoutPool, { statementTimeoutMs: 1, lockTimeoutMs: 1 });
  assert.equal(result.status, CERTIFICATION_FRESHNESS_STATUS.TECHNICAL_ERROR);
  assert.equal(result.reasonCode, 'READ_ONLY_TIMEOUT');
  assert.deepEqual(await persistenceState(), before);
});


integration('exact READY run without finished_at is CORRUPT, not MISSING or READY', { concurrency: false }, async () => {
  const seeded = await seedReady();
  const before = await persistenceState();
  await pool.query('UPDATE reconciliation_runs SET finished_at=NULL WHERE id=$1', [seeded.runId]);
  try {
    const result = await inspectCertificationFreshness(pool);
    assert.equal(result.status, CERTIFICATION_FRESHNESS_STATUS.CORRUPT);
    assert.notEqual(result.status, CERTIFICATION_FRESHNESS_STATUS.MISSING);
    assert.notEqual(result.status, CERTIFICATION_FRESHNESS_STATUS.READY);
    assert.deepEqual(await persistenceState(), before);
  } finally {
    await pool.query('UPDATE reconciliation_runs SET finished_at=NOW() WHERE id=$1', [seeded.runId]);
  }
});

integration('source-state identity corruption is never downgraded to MISSING or STALE', { concurrency: false }, async () => {
  const seeded = await seedReady();
  const fact = (await pool.query('SELECT id,source_state_key FROM certification_facts WHERE run_id=$1 ORDER BY id LIMIT 1', [seeded.runId])).rows[0];
  const before = await persistenceState();
  await pool.query("UPDATE certification_facts SET source_state_key=$2 WHERE id=$1", [fact.id, 'b'.repeat(64)]);
  try {
    const result = await inspectCertificationFreshness(pool);
    assert.equal(result.status, CERTIFICATION_FRESHNESS_STATUS.CORRUPT);
    assert.notEqual(result.status, CERTIFICATION_FRESHNESS_STATUS.MISSING);
    assert.notEqual(result.status, CERTIFICATION_FRESHNESS_STATUS.STALE);
    assert.deepEqual(await persistenceState(), before);
  } finally {
    await pool.query('UPDATE certification_facts SET source_state_key=$2 WHERE id=$1', [fact.id, fact.source_state_key]);
  }
});

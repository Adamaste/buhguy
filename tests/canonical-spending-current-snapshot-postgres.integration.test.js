import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import { certificationSourceStateKey, CERTIFICATION_MODEL_VERSION } from '../src/certification.js';
import {
  currentCategorySummary,
  currentHouseholdSummary,
  currentMonthlySpending,
  currentPersonSummary,
  currentPurchases,
  currentReturns,
  resolveCurrentSpendingSnapshot,
} from '../src/canonical-spending-current-snapshot.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
let pool;

before(async () => {
  if (databaseUrl) {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(await fs.readFile(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
  }
});

after(async () => { await pool?.end(); });

const persistenceCounts = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM reconciliation_runs) AS runs,
  (SELECT count(*)::int FROM certification_facts) AS facts,
  (SELECT count(*)::int FROM reconciliation_results) AS results,
  (SELECT count(*)::int FROM ledger_entries) AS ledger_entries,
  (SELECT count(*)::int FROM ledger_postings) AS postings,
  (SELECT count(*)::int FROM ledger_source_links) AS source_links`)).rows[0];

function observingPool() {
  const seen = [];
  const forbidden = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i;
  return {
    seen,
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          seen.push(text);
          if (forbidden.test(text) && !/^ROLLBACK\b/i.test(text)) throw new Error(`read-only query guard rejected ${text}`);
          return client.query(sql, params);
        },
        release() { client.release(); },
      };
    },
  };
}

integration('current snapshot uses one repeatable-read read-only transaction and exposes only coherent current state', async () => {
  const before = await persistenceCounts();
  const observed = observingPool();
  const resolved = await resolveCurrentSpendingSnapshot(observed, { scopeKey: 'default' });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.snapshot.status, 'READY');
  assert.equal(resolved.snapshot.modelVersion, 'reconciliation-certification-v1');
  assert.match(resolved.snapshot.sourceStateKey, /^[0-9a-f]{64}$/);
  assert.ok(observed.seen.some((query) => query === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(observed.seen.includes('ROLLBACK'));
  assert.ok(observed.seen.every((query) => !/^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP)\b/i.test(query)));

  const [household, monthly, categories, people, purchases, returns] = await Promise.all([
    currentHouseholdSummary(pool, { scopeKey: 'default' }),
    currentMonthlySpending(pool, { scopeKey: 'default', timezone: 'UTC' }),
    currentCategorySummary(pool, { scopeKey: 'default' }),
    currentPersonSummary(pool, { scopeKey: 'default' }),
    currentPurchases(pool, { scopeKey: 'default' }),
    currentReturns(pool, { scopeKey: 'default' }),
  ]);
  for (const result of [household, monthly, categories, people, purchases, returns]) {
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.sourceStateKey, resolved.snapshot.sourceStateKey);
  }
  assert.ok(purchases.rows.every((row) => typeof row.amount === 'string'));
  assert.ok(returns.rows.every((row) => typeof row.return_amount === 'string'));
  assert.ok(household.rows.every((row) => typeof row.gross_spend === 'string' && typeof row.net_spend === 'string'));
  assert.ok(monthly.rows.every((row) => typeof row.gross_spend === 'string' && typeof row.net_spend === 'string'));
  assert.ok(categories.rows.every((row) => typeof row.gross_spend === 'string' && typeof row.net_spend === 'string'));
  assert.ok(people.rows.every((row) => typeof row.gross_spend === 'string' && typeof row.net_spend === 'string'));

  const after = await persistenceCounts();
  assert.deepEqual(after, before);
});

integration('current snapshot rejects stale and corrupt persisted snapshots without latest-ready fallback', async () => {
  const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
  const sourceStateKey = await certificationSourceStateKey(pool, scope.id);
  const run = (await pool.query(`SELECT id FROM reconciliation_runs
    WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
      AND period_from IS NULL AND period_to IS NULL AND status='READY'`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey])).rows;
  assert.equal(run.length, 1);

  const fact = (await pool.query('SELECT id,amount FROM certification_facts WHERE run_id=$1 ORDER BY id LIMIT 1', [run[0].id])).rows[0];
  assert.ok(fact);
  const originalAmount = fact.amount;
  await pool.query('UPDATE certification_facts SET amount=amount+0.01 WHERE id=$1', [fact.id]);
  const corrupt = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reasonCode, 'CORRUPT_SNAPSHOT');
  await pool.query('UPDATE certification_facts SET amount=$2 WHERE id=$1', [fact.id, originalAmount]);

  const rule = (await pool.query('SELECT rule_code,rule_version FROM business_graph_rules ORDER BY rule_code,rule_version LIMIT 1')).rows[0];
  const semanticKey = crypto.createHash('sha256').update('current-snapshot-stale-fixture').digest('hex');
  await pool.query(`INSERT INTO business_events(
      scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
    VALUES($1,'RETURN','CONFIRMED','SYSTEM_DERIVED','current-snapshot-test',$2,$3,$4,0.01,'RUB','stale snapshot fixture')`,
  [scope.id, rule.rule_code, rule.rule_version, semanticKey]);
  const stale = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
  assert.equal(stale.ok, false);
  assert.ok(['NO_CURRENT_CERTIFICATION', 'STALE_SNAPSHOT'].includes(stale.reasonCode));
  assert.notEqual(stale.sourceStateKey, sourceStateKey);
});

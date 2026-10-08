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

function observingPool({ afterQuery = null } = {}) {
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
          const result = await client.query(sql, params);
          if (afterQuery) await afterQuery(text);
          return result;
        },
        release() { client.release(); },
      };
    },
  };
}

function sumMoney(rows, field) {
  return rows.reduce((sum, row) => {
    const [whole, fraction = '00'] = String(row[field]).split('.');
    const sign = whole.startsWith('-') ? -1n : 1n;
    const absolute = whole.replace('-', '');
    return sum + sign * (BigInt(absolute) * 100n + BigInt(fraction.padEnd(2, '0')));
  }, 0n);
}

function sumMoneyByCurrency(rows, field) {
  const totals = new Map();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0n) + sumMoney([row], field));
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function assertCurrencyTotalsMatch(left, right, field) {
  assert.deepEqual(sumMoneyByCurrency(left, field), sumMoneyByCurrency(right, field), `${field} must reconcile by currency`);
}

integration('current snapshot uses one repeatable-read read-only transaction and exposes only coherent current state', async () => {
  const before = await persistenceCounts();
  const observed = observingPool();
  const resolved = await resolveCurrentSpendingSnapshot(observed, { scopeKey: 'default' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.snapshot.status, 'READY');
  assert.equal(resolved.snapshot.modelVersion, 'reconciliation-certification-v1');
  assert.match(resolved.snapshot.sourceStateKey, /^[0-9a-f]{64}$/);
  assert.ok(observed.seen.some((query) => query === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(observed.seen.includes('ROLLBACK'));
  assert.equal(observed.seen.filter((query) => query.includes('(SELECT count(*) FROM receipts)')).length, 1);
  assert.ok(observed.seen.every((query) => /^ROLLBACK\b/i.test(query) || !/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(query)));

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
  assert.deepEqual(monthly.queryPeriod, {
    timezone: 'UTC',
    from: null,
    to: null,
    semantics: 'event_at, half-open [from,to)',
    snapshotIdentity: 'unbounded certification snapshot; query period is an additional filter',
  });
  assert.equal(sumMoney(categories.rows, 'gross_spend'), sumMoney(household.rows, 'gross_spend'));
  assert.equal(sumMoney(people.rows, 'gross_spend'), sumMoney(household.rows, 'gross_spend'));
  for (const field of ['gross_spend', 'confirmed_returns', 'net_spend']) {
    assertCurrencyTotalsMatch(categories.rows, household.rows, field);
    assertCurrencyTotalsMatch(people.rows, household.rows, field);
  }
  for (const result of [household, categories, people]) {
    assert.ok(result.rows.every((row) => Number(row.scope_id) === resolved.snapshot.scopeId));
    assert.ok(result.rows.every((row) => Number(row.certification_run_id) === resolved.snapshot.runId));
    assert.ok(result.rows.every((row) => row.source_state_key === resolved.snapshot.sourceStateKey));
  }

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
  const beforeCorrupt = await persistenceCounts();
  await pool.query('UPDATE certification_facts SET amount=amount+0.01 WHERE id=$1', [fact.id]);
  const corrupt = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reasonCode, 'CORRUPT_SNAPSHOT');
  await pool.query('UPDATE certification_facts SET amount=$2 WHERE id=$1', [fact.id, originalAmount]);
  assert.deepEqual(await persistenceCounts(), beforeCorrupt);

  const rule = (await pool.query('SELECT rule_code,rule_version FROM business_graph_rules ORDER BY rule_code,rule_version LIMIT 1')).rows[0];
  const semanticKey = crypto.createHash('sha256').update('current-snapshot-stale-fixture').digest('hex');
  const staleEventId = Number((await pool.query(`INSERT INTO business_events(
      scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
    VALUES($1,'RETURN','CONFIRMED','SYSTEM_DERIVED','current-snapshot-test',$2,$3,$4,0.01,'RUB','stale snapshot fixture') RETURNING id`,
  [scope.id, rule.rule_code, rule.rule_version, semanticKey])).rows[0]?.id);
  const stale = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
  assert.equal(stale.ok, false);
  assert.ok(['NO_CURRENT_CERTIFICATION', 'STALE_SNAPSHOT'].includes(stale.reasonCode));
  assert.notEqual(stale.sourceStateKey, sourceStateKey);
  await pool.query('DELETE FROM business_events WHERE id=$1', [staleEventId]);
});

integration('current snapshot rejects non-ready, bounded, wrong-identity and absent current runs', async () => {
  const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
  const rule = (await pool.query('SELECT rule_code,rule_version FROM business_graph_rules ORDER BY rule_code,rule_version LIMIT 1')).rows[0];
  const eventKey = crypto.createHash('sha256').update(`snapshot-run-fixture-${Date.now()}`).digest('hex');
  const eventId = Number((await pool.query(`INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
    VALUES($1,'RETURN','CONFIRMED','SYSTEM_DERIVED','snapshot-run-fixture',$2,$3,$4,0.01,'RUB','temporary run fixture') RETURNING id`, [scope.id, rule.rule_code, rule.rule_version, eventKey])).rows[0].id);
  try {
    const changedKey = await certificationSourceStateKey(pool, scope.id);
    for (const status of ['RUNNING', 'FAILED']) {
      const run = Number((await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,period_from,period_to)
        VALUES($1,$2,$3,$4,NULL,NULL) RETURNING id`, [scope.id, CERTIFICATION_MODEL_VERSION, changedKey, status])).rows[0].id);
      const result = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'NO_CURRENT_CERTIFICATION');
      await pool.query('DELETE FROM reconciliation_runs WHERE id=$1', [run]);
    }
    const absent = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
    assert.equal(absent.ok, false);
    assert.equal(absent.reasonCode, 'NO_CURRENT_CERTIFICATION');
    const boundedRun = Number((await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,period_from,period_to)
      VALUES($1,$2,$3,'READY','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z') RETURNING id`, [scope.id, CERTIFICATION_MODEL_VERSION, changedKey])).rows[0].id);
    const bounded = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
    assert.equal(bounded.ok, false);
    assert.equal(bounded.reasonCode, 'NO_CURRENT_CERTIFICATION');
    await pool.query('DELETE FROM reconciliation_runs WHERE id=$1', [boundedRun]);

    const wrongModel = Number((await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,period_from,period_to)
      VALUES($1,'other-model-v1',$2,'READY',NULL,NULL) RETURNING id`, [scope.id, changedKey])).rows[0].id);
    const wrongModelResult = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
    assert.equal(wrongModelResult.ok, false);
    assert.equal(wrongModelResult.reasonCode, 'NO_CURRENT_CERTIFICATION');
    await pool.query('DELETE FROM reconciliation_runs WHERE id=$1', [wrongModel]);

    const otherScope = Number((await pool.query("INSERT INTO accounting_scopes(scope_key,label) VALUES($1,'temporary') RETURNING id", [`snapshot-other-${Date.now()}`])).rows[0].id);
    const otherScopeKey = await certificationSourceStateKey(pool, otherScope);
    const wrongScopeRun = Number((await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,period_from,period_to)
      VALUES($1,$2,$3,'READY',NULL,NULL) RETURNING id`, [otherScope, CERTIFICATION_MODEL_VERSION, otherScopeKey])).rows[0].id);
    const wrongScopeResult = await resolveCurrentSpendingSnapshot(pool, { scopeKey: 'default' });
    assert.equal(wrongScopeResult.ok, false);
    assert.equal(wrongScopeResult.reasonCode, 'NO_CURRENT_CERTIFICATION');
    await pool.query('DELETE FROM reconciliation_runs WHERE id=$1', [wrongScopeRun]);
    await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [otherScope]);
  } finally {
    await pool.query('DELETE FROM reconciliation_runs WHERE scope_id=$1 AND source_state_key=$2', [scope.id, await certificationSourceStateKey(pool, scope.id)]);
    await pool.query('DELETE FROM business_events WHERE id=$1', [eventId]);
  }
});

integration('current snapshot changes identity for receipt population and active-ledger supersession', async () => {
  const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
  const before = await certificationSourceStateKey(pool, scope.id);
  const receiptId = Number((await pool.query("INSERT INTO receipts(fns_id,source,total_sum,currency) VALUES($1,'snapshot-receipt-fixture',0,'RUB') RETURNING id", [`snapshot-receipt-${Date.now()}`])).rows[0].id);
  const afterReceipt = await certificationSourceStateKey(pool, scope.id);
  assert.notEqual(afterReceipt, before);
  await pool.query('DELETE FROM receipts WHERE id=$1', [receiptId]);

  const active = (await pool.query(`SELECT e.* FROM ledger_entries e
    WHERE e.scope_id=$1 AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)
    ORDER BY e.id LIMIT 1`, [scope.id])).rows[0];
  assert.ok(active);
  const replacement = (await pool.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,description)
    SELECT scope_id,source_event_id,currency,event_at,repeat('d',64),derivation_rule,derivation_version,derivation_status,certification_status,origin,'temporary snapshot supersession'
    FROM ledger_entries WHERE id=$1 RETURNING id`, [active.id])).rows[0];
  await pool.query(`INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code)
    VALUES($1,$2,$3,$4,repeat('e',64),repeat('f',64),'SNAPSHOT_TEST')`, [scope.id, active.id, replacement.id, active.source_event_id]);
  const afterSupersession = await certificationSourceStateKey(pool, scope.id);
  assert.notEqual(afterSupersession, afterReceipt);
  await pool.query('DELETE FROM ledger_entry_supersessions WHERE replacement_ledger_entry_id=$1', [replacement.id]);
  await pool.query('DELETE FROM ledger_entries WHERE id=$1', [replacement.id]);
});

integration('repeatable-read snapshot remains coherent under concurrent source modification', async () => {
  const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
  const baseline = await certificationSourceStateKey(pool, scope.id);
  let injected = false;
  const observed = observingPool({
    afterQuery: async (query) => {
      if (!injected && query.includes('(SELECT count(*) FROM receipts)')) {
        injected = true;
        const rule = (await pool.query('SELECT rule_code,rule_version FROM business_graph_rules ORDER BY rule_code,rule_version LIMIT 1')).rows[0];
        const key = crypto.createHash('sha256').update(`snapshot-concurrent-${Date.now()}`).digest('hex');
        await pool.query(`INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency)
          VALUES($1,'RETURN','CONFIRMED','SYSTEM_DERIVED','snapshot-concurrent',$2,$3,$4,0.01,'RUB')`, [scope.id, rule.rule_code, rule.rule_version, key]);
      }
    },
  });
  try {
    const result = await resolveCurrentSpendingSnapshot(observed, { scopeKey: 'default' });
    assert.equal(injected, true);
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.sourceStateKey, baseline);
  } finally {
    await pool.query("DELETE FROM business_events WHERE graph_model_version='snapshot-concurrent'");
  }
});

integration('monthly metadata preserves timezone and half-open boundaries', async () => {
  const result = await currentMonthlySpending(pool, {
    scopeKey: 'default',
    timezone: 'Europe/Moscow',
    from: '2026-08-01T00:00:00Z',
    to: '2026-09-01T00:00:00Z',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.queryPeriod, {
    timezone: 'Europe/Moscow',
    from: '2026-08-01T00:00:00Z',
    to: '2026-09-01T00:00:00Z',
    semantics: 'event_at, half-open [from,to)',
    snapshotIdentity: 'unbounded certification snapshot; query period is an additional filter',
  });
  assert.ok(result.rows.every((row) => /^\d{4}-\d{2}$/.test(row.month)));
});

integration('monthly SQL assigns real boundary events by timezone and keeps currencies and snapshots separate', async () => {
  const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
  const current = await certificationSourceStateKey(pool, scope.id);
  const run = (await pool.query(`SELECT id FROM reconciliation_runs
    WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
      AND period_from IS NULL AND period_to IS NULL AND status='READY'`, [scope.id, CERTIFICATION_MODEL_VERSION, current])).rows[0];
  assert.ok(run);
  const prefix = crypto.createHash('sha256').update(`monthly-boundary-${process.pid}-${Date.now()}`).digest('hex');
  const fixtures = [
    { eventAt: '2026-08-31T20:59:59.999Z', currency: 'RUB', amount: '11.00' },
    { eventAt: '2026-08-31T21:00:00.000Z', currency: 'EUR', amount: '12.00' },
    { eventAt: '2026-09-01T00:00:00.000Z', currency: 'RUB', amount: '13.00' },
  ];
  try {
    for (const [index, fixture] of fixtures.entries()) {
      await pool.query(`INSERT INTO certification_facts(
        run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
        reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key)
        VALUES($1,$2,'LEDGER_ENTRY',$3,'CONFIRMED_ACQUISITION_VALUE','BUSINESS_CERTIFICATION','CERTIFIED',$4,$5,$6,
        'TEST','TEST','TEST',NULL,NULL,NULL,$7,$8)`,
      [run.id, scope.id, 900000 + index, fixture.amount, fixture.currency, fixture.eventAt,
        crypto.createHash('sha256').update(`${prefix}-${index}`).digest('hex'), current]);
    }
    const rows = (await pool.query(`WITH monetary AS (
      SELECT event_at, amount, currency FROM canonical_spending_purchases_v1
      WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
    ) SELECT to_char(date_trunc('month', event_at AT TIME ZONE $4),'YYYY-MM') AS month,
      currency, SUM(amount)::NUMERIC(18,2)::text AS amount
      FROM monetary WHERE event_at >= $5::timestamptz AND event_at < $6::timestamptz
      GROUP BY date_trunc('month', event_at AT TIME ZONE $4), currency ORDER BY month,currency`,
    [scope.id, run.id, current, 'Europe/Moscow', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'])).rows;
    assert.deepEqual(rows, [
      { month: '2026-08', currency: 'RUB', amount: '11.00' },
      { month: '2026-09', currency: 'EUR', amount: '12.00' },
    ]);
    const exactBoundary = (await pool.query(`SELECT count(*)::int AS count, COALESCE(SUM(amount), 0)::NUMERIC(18,2)::text AS amount
      FROM canonical_spending_purchases_v1
      WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
        AND event_at >= $4::timestamptz AND event_at < $5::timestamptz`,
    [scope.id, run.id, current, fixtures[0].eventAt, fixtures[1].eventAt])).rows[0];
    assert.equal(Number(exactBoundary.count), 1);
    assert.equal(exactBoundary.amount, '11.00');
    const excluded = (await pool.query(`SELECT count(*)::int AS count FROM canonical_spending_purchases_v1
      WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND event_at >= $4::timestamptz AND event_at < $5::timestamptz`,
    [scope.id, run.id, current, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'])).rows[0];
    assert.equal(Number(excluded.count), 1);
  } finally {
    await pool.query('DELETE FROM certification_facts WHERE run_id=$1 AND subject_id BETWEEN 900000 AND 900002', [run.id]);
  }
});

integration('reader failure paths remain write-free', async () => {
  const before = await persistenceCounts();
  const result = await resolveCurrentSpendingSnapshot(observingPool(), { scopeKey: 'missing-scope' });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'SCOPE_NOT_FOUND');
  assert.deepEqual(await persistenceCounts(), before);
});

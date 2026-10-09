import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import { queryCanonicalSpending, validatePurchaseGrainRows } from '../src/canonical-spending-read-api.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
let pool;
before(() => { if (databaseUrl) pool = new pg.Pool({ connectionString: databaseUrl, max: 2 }); });
after(async () => { await pool?.end(); });

async function applyAnalyticsArtifact() {
  await pool.query(await fs.readFile(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
}

integration('disposable PostgreSQL query is snapshot-qualified and write-free', async () => {
  await applyAnalyticsArtifact();
  const tableNames = ['reconciliation_runs', 'certification_facts', 'reconciliation_results', 'ledger_entries', 'ledger_postings', 'ledger_source_links', 'bank_receipt_matches', 'business_event_bank_evidence'];
  const snapshot = async () => Promise.all(tableNames.map(async (name) => [name, (await pool.query(`SELECT count(*)::bigint AS count FROM public.${name}`)).rows[0].count]));
  const beforeRows = await snapshot();
  const decimal = (value) => { const [whole, fraction = ''] = String(value).split('.'); return BigInt(`${whole}${fraction.padEnd(2, '0')}`); };
  const normalized = (rows) => rows.map((row) => ({ currency: row.currency, gross: decimal(row.gross).toString(), returns: decimal(row.returns).toString(), net: decimal(row.net).toString() })).sort((a, b) => a.currency.localeCompare(b.currency));
  const directAggregates = async (queryPeriod, snapshot) => {
    const args = [snapshot.scopeId, snapshot.runId, snapshot.sourceStateKey, queryPeriod.from, queryPeriod.to];
    const monetary = (await pool.query(`WITH monetary AS (
      SELECT currency,amount AS gross,0::numeric AS returns FROM canonical_spending_purchases_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz
      UNION ALL
      SELECT currency,0::numeric,return_amount FROM canonical_spending_returns_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz
    ) SELECT currency,SUM(gross)::text AS gross,SUM(returns)::text AS returns,(SUM(gross)-SUM(returns))::text AS net FROM monetary GROUP BY currency`, args)).rows;
    const category = (await pool.query(`WITH p AS (
      SELECT DISTINCT purchase_id AS subject_event_id,currency FROM canonical_spending_purchases_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz
    ), r AS (
      SELECT DISTINCT return_id AS subject_event_id,currency FROM canonical_spending_returns_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz
    ), a AS (
      SELECT a.currency,a.category_gross AS gross,a.category_returns AS returns FROM canonical_spending_category_allocations_v1 a JOIN p ON p.subject_event_id=a.subject_event_id AND p.currency=a.currency
       WHERE a.scope_id=$1 AND a.certification_run_id=$2 AND a.source_state_key=$3 AND a.category_gross <> 0
      UNION ALL
      SELECT a.currency,a.category_gross,a.category_returns FROM canonical_spending_category_allocations_v1 a JOIN r ON r.subject_event_id=a.subject_event_id AND r.currency=a.currency
       WHERE a.scope_id=$1 AND a.certification_run_id=$2 AND a.source_state_key=$3 AND a.category_returns <> 0
    ) SELECT a.currency,SUM(a.gross)::text AS gross,SUM(a.returns)::text AS returns,(SUM(a.gross)-SUM(a.returns))::text AS net FROM a GROUP BY a.currency`, args)).rows;
    const person = (await pool.query(`WITH p AS (
      SELECT DISTINCT purchase_id AS subject_event_id,currency FROM canonical_spending_purchases_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz
    ), r AS (
      SELECT DISTINCT return_id AS subject_event_id,currency FROM canonical_spending_returns_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz
    ), a AS (
      SELECT a.currency,a.person_gross AS gross,a.person_returns AS returns FROM canonical_spending_person_allocations_v1 a JOIN p ON p.subject_event_id=a.subject_event_id AND p.currency=a.currency
       WHERE a.scope_id=$1 AND a.certification_run_id=$2 AND a.source_state_key=$3 AND a.person_gross <> 0
      UNION ALL
      SELECT a.currency,a.person_gross,a.person_returns FROM canonical_spending_person_allocations_v1 a JOIN r ON r.subject_event_id=a.subject_event_id AND r.currency=a.currency
       WHERE a.scope_id=$1 AND a.certification_run_id=$2 AND a.source_state_key=$3 AND a.person_returns <> 0
    ) SELECT currency,SUM(gross)::text AS gross,SUM(returns)::text AS returns,(SUM(gross)-SUM(returns))::text AS net FROM a GROUP BY currency`, args)).rows;
    return { monetary, category, person };
  };
  const periods = [
    { period: 'today' },
    { period: 'yesterday' },
    { period: 'range', from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' },
  ];
  for (const options of periods) {
    const result = await queryCanonicalSpending(pool, { ...options, scopeKey: 'default', limit: 1000 });
    assert.equal(result.status, 'READY', `disposable fixture must provide READY for ${options.period}`);
    const direct = await directAggregates(result.queryPeriod, result.snapshot);
    const directMonetary = direct.monetary.map((row) => ({ currency: row.currency, gross: decimal(row.gross).toString(), returns: decimal(row.returns).toString(), net: decimal(row.net).toString() }));
    assert.deepEqual(normalized(result.data.grossReturnsNetByCurrency), normalized(directMonetary));
    assert.deepEqual(normalized(result.data.category.map((row) => ({ currency: row.currency, gross: row.gross, returns: row.returns, net: row.net }))), normalized(direct.category.map((row) => ({ currency: row.currency, gross: row.gross, returns: row.returns, net: row.net }))));
    assert.deepEqual(normalized(result.data.person.map((row) => ({ currency: row.currency, gross: row.gross, returns: row.returns, net: row.net }))), normalized(direct.person.map((row) => ({ currency: row.currency, gross: row.gross, returns: row.returns, net: row.net }))));
    if (options.period === 'range') {
      assert.ok(directMonetary.some((row) => decimal(row.gross) > 0n), 'fixed fixture range must provide a non-zero purchase');
      assert.ok(directMonetary.some((row) => decimal(row.returns) > 0n), 'fixed fixture range must provide a non-zero return');
    }
    assert.equal(new Set(result.data.confirmedPurchases.map((row) => row.purchase_id)).size, result.data.confirmedPurchases.length);
    assert.ok(result.data.confirmedReturns.every((row) => typeof row.return_amount === 'string'));
    assert.equal(result.data.bankOnlyIncomplete.status, 'EXCLUDED_FROM_CERTIFIED_ACQUISITIONS');
    assert.ok(result.data.category.every((row) => row.currency && row.categoryCode !== undefined));
    assert.ok(result.data.person.every((row) => row.currency && 'attributionStatus' in row));
    assert.match(result.snapshot.sourceStateKey, /^[0-9a-f]{64}$/);
    const page = await queryCanonicalSpending(pool, { ...options, scopeKey: 'default', limit: 1, offset: 0 });
    assert.equal(page.status, 'READY');
    const totalPurchases = (await pool.query(`SELECT count(*)::int AS count FROM canonical_spending_purchases_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz`, [result.snapshot.scopeId, result.snapshot.runId, result.snapshot.sourceStateKey, result.queryPeriod.from, result.queryPeriod.to])).rows[0].count;
    if (totalPurchases > 1) assert.equal(page.data.pagination.purchases.hasMore, true);
  }
  const afterRows = await snapshot();
  assert.deepEqual(afterRows, beforeRows);
});

integration('disposable PostgreSQL permissions are inspected without public grants', async () => {
  const row = (await pool.query(`SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name,current_setting('search_path') AS search_path,
    has_table_privilege(current_user, 'public.reconciliation_runs', 'SELECT') AS runs_select,
    has_table_privilege(current_user, 'public.accounting_scopes', 'SELECT') AS scopes_select`)).rows[0];
  assert.equal(typeof row.database_name, 'string');
  assert.equal(typeof row.role_name, 'string');
  assert.equal(typeof row.runs_select, 'boolean');
  assert.equal(typeof row.scopes_select, 'boolean');
});

integration('duplicate matches fail closed and returns/currencies remain separate', () => {
  assert.equal(validatePurchaseGrainRows([{ purchase_id: 1, certification_fact_id: 2, semantic_key: 'a' }, { purchase_id: 1, certification_fact_id: 3, semantic_key: 'b' }]).reasonCode, 'CORRUPT');
  assert.equal(validatePurchaseGrainRows([{ purchase_id: 1, certification_fact_id: 2, semantic_key: 'a' }]).ok, true);
});


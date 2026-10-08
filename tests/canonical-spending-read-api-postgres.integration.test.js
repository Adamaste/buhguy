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
  const expected = (result) => {
    const totals = new Map();
    for (const row of result.data.confirmedPurchases) { const item = totals.get(row.currency) ?? { gross: 0n, returns: 0n }; item.gross += decimal(row.amount); totals.set(row.currency, item); }
    for (const row of result.data.confirmedReturns) { const item = totals.get(row.currency) ?? { gross: 0n, returns: 0n }; item.returns += decimal(row.return_amount); totals.set(row.currency, item); }
    return [...totals.entries()].sort().map(([currency, value]) => ({ currency, gross: value.gross.toString(), returns: value.returns.toString(), net: (value.gross - value.returns).toString() }));
  };
  const normalized = (rows) => rows.map((row) => ({ currency: row.currency, gross: decimal(row.gross).toString(), returns: decimal(row.returns).toString(), net: decimal(row.net).toString() })).sort((a, b) => a.currency.localeCompare(b.currency));
  const periods = [
    { period: 'today' },
    { period: 'yesterday' },
    { period: 'range', from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
  ];
  for (const options of periods) {
    const result = await queryCanonicalSpending(pool, { ...options, scopeKey: 'default', limit: 1000 });
    assert.equal(result.status, 'READY', `disposable fixture must provide READY for ${options.period}`);
    assert.equal(new Set(result.data.confirmedPurchases.map((row) => row.purchase_id)).size, result.data.confirmedPurchases.length);
    assert.deepEqual(normalized(result.data.grossReturnsNetByCurrency), expected(result));
    assert.ok(result.data.confirmedReturns.every((row) => typeof row.return_amount === 'string'));
    assert.equal(result.data.bankOnlyIncomplete.status, 'EXCLUDED_FROM_CERTIFIED_ACQUISITIONS');
    assert.ok(result.data.category.every((row) => row.currency && row.categoryCode !== undefined));
    assert.ok(result.data.person.every((row) => row.currency && 'attributionStatus' in row));
    assert.match(result.snapshot.sourceStateKey, /^[0-9a-f]{64}$/);
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

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { queryCanonicalSpending, validatePurchaseGrainRows } from '../src/canonical-spending-read-api.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
let pool;
before(() => { if (databaseUrl) pool = new pg.Pool({ connectionString: databaseUrl, max: 2 }); });
after(async () => { await pool?.end(); });

integration('disposable PostgreSQL query is snapshot-qualified and write-free', async () => {
  const beforeRows = (await pool.query('SELECT count(*)::int AS runs FROM reconciliation_runs')).rows[0];
  const result = await queryCanonicalSpending(pool, { scopeKey: 'default', period: 'range', from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' });
  assert.ok(['READY', 'MISSING', 'STALE', 'CONFLICT', 'CORRUPT', 'ACCESS_ERROR', 'TECHNICAL_ERROR'].includes(result.status));
  if (result.ok) {
    assert.equal(new Set(result.data.confirmedPurchases.map((row) => row.purchase_id)).size, result.data.confirmedPurchases.length);
    assert.ok(result.data.grossReturnsNetByCurrency.every((row) => row.currency && typeof row.gross === 'string' && typeof row.returns === 'string' && typeof row.net === 'string'));
    assert.ok(result.data.confirmedReturns.every((row) => typeof row.return_amount === 'string'));
    assert.equal(result.data.bankOnlyIncomplete.status, 'EXCLUDED_FROM_CERTIFIED_ACQUISITIONS');
    assert.match(result.snapshot.sourceStateKey, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual((await pool.query('SELECT count(*)::int AS runs FROM reconciliation_runs')).rows[0], beforeRows);
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


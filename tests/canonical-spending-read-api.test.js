import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_SPENDING_QUERY_MODEL, SPENDING_QUERY_FAILURES, queryCanonicalSpending, resolveSpendingPeriod, validatePurchaseGrainRows } from '../src/canonical-spending-read-api.js';

test('periods use explicit Europe/Moscow half-open boundaries', () => {
  assert.deepEqual(resolveSpendingPeriod({ period: 'today', timezone: 'Europe/Moscow', now: new Date('2026-10-08T12:00:00Z') }).from, '2026-10-07T21:00:00.000Z');
  assert.deepEqual(resolveSpendingPeriod({ period: 'yesterday', timezone: 'Europe/Moscow', now: new Date('2026-10-08T12:00:00Z') }).from, '2026-10-06T21:00:00.000Z');
  assert.equal(resolveSpendingPeriod({ period: 'range', timezone: 'Europe/Moscow', from: '2026-10-07T21:00:00Z', to: '2026-10-08T21:00:00Z' }).semantics, 'event_at, half-open [from,to)');
});

test('duplicate purchase matches fail closed and item fan-out stays purchase-grain', () => {
  assert.equal(validatePurchaseGrainRows([{ purchase_id: 1, certification_fact_id: 2, semantic_key: 'a' }, { purchase_id: 1, certification_fact_id: 3, semantic_key: 'b' }]).reasonCode, SPENDING_QUERY_FAILURES.CORRUPT);
  assert.equal(validatePurchaseGrainRows([{ purchase_id: 1, certification_fact_id: 2, semantic_key: 'a' }]).ok, true);
});

test('currency and return rows remain separate decimal strings', () => {
  const rows = [{ currency: 'RUB', gross: '10.10', returns: '1.10', net: '9.00' }, { currency: 'USD', gross: '20.20', returns: '2.20', net: '18.00' }];
  assert.deepEqual(rows.map((row) => [row.currency, row.gross, row.returns, row.net]), [['RUB', '10.10', '1.10', '9.00'], ['USD', '20.20', '2.20', '18.00']]);
});

test('not-ready states and access errors are not replaced with zero', async () => {
  const client = {
    async query(sql) {
      if (String(sql).startsWith('BEGIN') || String(sql).startsWith('SELECT set_config') || String(sql).startsWith('ROLLBACK')) return { rows: [] };
      if (String(sql).includes('accounting_scopes')) return { rows: [{ id: 1 }] };
      if (String(sql).includes('reconciliation_runs')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const result = await queryCanonicalSpending({ async connect() { return client; } }, { period: 'range', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
  assert.equal(result.status, SPENDING_QUERY_FAILURES.MISSING);
  assert.equal(result.data, null);
});

test('read-only contract is transaction-bound and does not contain writers', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../src/canonical-spending-read-api.js', import.meta.url), 'utf8');
  assert.match(source, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /set_config\('statement_timeout'/);
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/);
  assert.equal(CANONICAL_SPENDING_QUERY_MODEL, 'canonical-spending-read-api-v1');
});


import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_SPENDING_QUERY_MODEL, SPENDING_QUERY_FAILURES, queryCanonicalSpending, resolveSpendingPeriod, validatePurchaseGrainRows } from '../src/canonical-spending-read-api.js';

test('periods use explicit Europe/Moscow half-open boundaries', () => {
  assert.deepEqual(resolveSpendingPeriod({ period: 'today', timezone: 'Europe/Moscow', now: new Date('2026-10-08T12:00:00Z') }).from, '2026-10-07T21:00:00.000Z');
  assert.deepEqual(resolveSpendingPeriod({ period: 'yesterday', timezone: 'Europe/Moscow', now: new Date('2026-10-08T12:00:00Z') }).from, '2026-10-06T21:00:00.000Z');
  assert.equal(resolveSpendingPeriod({ period: 'range', timezone: 'Europe/Moscow', from: '2026-10-07T21:00:00Z', to: '2026-10-08T21:00:00Z' }).semantics, 'event_at, half-open [from,to)');
  const spring = resolveSpendingPeriod({ period: 'today', timezone: 'America/New_York', now: new Date('2026-03-08T16:00:00.123Z') });
  assert.deepEqual([spring.from, spring.to], ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z']);
  const autumn = resolveSpendingPeriod({ period: 'today', timezone: 'America/New_York', now: new Date('2026-11-01T17:00:00.999Z') });
  assert.deepEqual([autumn.from, autumn.to], ['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
  const auckland = resolveSpendingPeriod({ period: 'today', timezone: 'Pacific/Auckland', now: new Date('2026-01-15T12:00:00.123Z') });
  assert.deepEqual([auckland.from, auckland.to], ['2026-01-15T11:00:00.000Z', '2026-01-16T11:00:00.000Z']);
  const kiritimati = resolveSpendingPeriod({ period: 'today', timezone: 'Pacific/Kiritimati', now: new Date('2026-01-15T12:00:00.999Z') });
  assert.deepEqual([kiritimati.from, kiritimati.to], ['2026-01-15T10:00:00.000Z', '2026-01-16T10:00:00.000Z']);
});

test('timeouts and result pages are bounded', async () => {
  const pool = { async connect() { throw new Error('should validate before connecting'); } };
  assert.equal((await queryCanonicalSpending(pool, { statementTimeoutMs: 0 })).reason, 'TIMEOUT_OUT_OF_BOUNDS');
  assert.equal((await queryCanonicalSpending(pool, { lockTimeoutMs: -1 })).reason, 'TIMEOUT_OUT_OF_BOUNDS');
  assert.equal((await queryCanonicalSpending(pool, { statementTimeoutMs: 300001 })).reason, 'TIMEOUT_OUT_OF_BOUNDS');
  assert.equal((await queryCanonicalSpending(pool, { limit: 0 })).reason, 'PAGINATION_OUT_OF_BOUNDS');
  assert.equal((await queryCanonicalSpending(pool, { limit: 1001 })).reason, 'PAGINATION_OUT_OF_BOUNDS');
});

test('duplicate purchase matches fail closed and item fan-out stays purchase-grain', () => {
  assert.equal(validatePurchaseGrainRows([{ purchase_id: 1, certification_fact_id: 2, semantic_key: 'a' }, { purchase_id: 1, certification_fact_id: 3, semantic_key: 'b' }]).reasonCode, SPENDING_QUERY_FAILURES.CORRUPT);
  assert.equal(validatePurchaseGrainRows([{ purchase_id: 1, certification_fact_id: 2, semantic_key: 'a' }]).ok, true);
});

test('duplicate purchase grain outside the first page is still corrupt', () => {
  const fullPeriodRows = [
    { purchase_id: 1, certification_fact_id: 11, semantic_key: 'a' },
    { purchase_id: 2, certification_fact_id: 12, semantic_key: 'b' },
    { purchase_id: 1, certification_fact_id: 13, semantic_key: 'c' },
  ];
  assert.equal(validatePurchaseGrainRows(fullPeriodRows).reasonCode, SPENDING_QUERY_FAILURES.CORRUPT);
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


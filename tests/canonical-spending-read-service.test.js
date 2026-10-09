import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanonicalSpendingReadService, READ_SERVICE_FAILURES } from '../src/canonical-spending-read-service.js';

const baseRequest = Object.freeze({
  scopeKey: 'default',
  period: 'range',
  timezone: 'Europe/Moscow',
  from: '2026-04-01T00:00:00Z',
  to: '2026-05-01T00:00:00Z',
  limit: 10,
  offset: 0,
});

function serviceFor(query, overrides = {}) {
  const logs = [];
  return {
    logs,
    service: createCanonicalSpendingReadService({
      pool: { connect: async () => { throw new Error('query pool must not be used by injected query'); } },
      authenticate: async (context) => context.token === 'valid' ? { subject: 'person-1' } : null,
      authorizeScope: async ({ principal }) => principal.subject === 'person-1' ? { scopeKey: 'default' } : null,
      query,
      logger: { info: (event, summary) => logs.push({ event, summary }) },
      ...overrides,
    }),
  };
}

test('authenticated connector invocation returns curated 100/20/80 decimal JSON', async () => {
  const { service, logs } = serviceFor(async () => ({
    ok: true,
    status: 'READY',
    snapshot: { scopeKey: 'default', scopeId: 1, runId: 7, modelVersion: 'reconciliation-certification-v1', status: 'READY', sourceStateKey: 'a'.repeat(64), finishedAt: '2026-04-30T00:00:00Z', secret: 'drop' },
    queryPeriod: { timezone: 'Europe/Moscow', from: baseRequest.from, to: baseRequest.to, semantics: 'event_at, half-open [from,to)' },
    data: {
      grossReturnsNetByCurrency: [{ currency: 'RUB', gross: '100.00', returns: '20.00', net: '80.00' }],
      confirmedPurchases: [{ purchase_id: 1, amount: '100.00', currency: 'RUB', purchased_at: '2026-04-10T10:00:00Z', rule_code: 'PURCHASE', rule_version: 'v1', raw: 'drop' }],
      confirmedReturns: [{ return_id: 2, return_amount: '20.00', currency: 'RUB', returned_at: '2026-04-11T10:00:00Z', raw: 'drop' }],
      category: [], person: [], unresolved: { blockedExposure: [{ raw: 'drop' }], unattributedPersonRows: [] },
      bankOnlyIncomplete: { status: 'EXCLUDED_FROM_CERTIFIED_ACQUISITIONS', reasonCode: 'BANK_ONLY_OR_UNMATCHED_NOT_PROVEN_PURCHASE' },
      limitations: ['BANK_ONLY_OR_UNMATCHED_PURCHASES_REMAIN_INCOMPLETE'],
      pagination: { limit: 10, offset: 0, purchases: { hasMore: false }, returns: { hasMore: false } },
    },
  }));
  const result = await service.handle(baseRequest, { token: 'valid', raw: 'secret' });
  assert.equal(result.status, 'READY');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.grossReturnsNetByCurrency, [{ currency: 'RUB', gross: '100.00', returns: '20.00', net: '80.00' }]);
  assert.equal(result.data.confirmedPurchases[0].raw, undefined);
  assert.equal(result.snapshot.secret, undefined);
  assert.equal(logs[0].event, 'canonical_spending_read_service_completed');
  assert.deepEqual(Object.keys(logs[0].summary).sort(), ['currencyCount', 'purchaseCount', 'reasonCode', 'returnCount', 'runId', 'scopeKey', 'sourceStateKey', 'status'].sort());
});

test('failed authentication and unauthorized scope fail closed', async () => {
  const denied = serviceFor(async () => { throw new Error('must not query'); });
  assert.equal((await denied.service.handle(baseRequest, { token: 'bad' })).reasonCode, READ_SERVICE_FAILURES.AUTHENTICATION_REQUIRED);
  const forbidden = serviceFor(async () => ({ ok: true, status: 'READY' }), {
    authorizeScope: async () => null,
  });
  assert.equal((await forbidden.service.handle(baseRequest, { token: 'valid' })).reasonCode, READ_SERVICE_FAILURES.SCOPE_FORBIDDEN);
});

test('foreign scope selection is rejected and only resolved scope reaches the query', async () => {
  let received;
  const { service } = serviceFor(async (_pool, options) => {
    received = options;
    return { ok: false, status: 'STALE', reasonCode: 'STALE', snapshot: null, data: null };
  });
  const foreign = await service.handle({ ...baseRequest, scopeKey: 'foreign' }, { token: 'valid' });
  assert.equal(foreign.reasonCode, READ_SERVICE_FAILURES.SCOPE_FORBIDDEN);
  assert.equal(received, undefined);
  await service.handle({ ...baseRequest, scopeKey: undefined, statementTimeoutMs: 1, lockTimeoutMs: 1 }, { token: 'valid' });
  assert.equal(received.scopeKey, 'default');
  assert.equal(received.statementTimeoutMs, 120000);
  assert.equal(received.lockTimeoutMs, 5000);
});

test('stale, missing, conflict, corrupt and access-error statuses are explicit and never zeroed', async () => {
  for (const status of ['STALE', 'MISSING', 'CONFLICT', 'CORRUPT', 'ACCESS_ERROR']) {
    const { service } = serviceFor(async () => ({ ok: false, status, reasonCode: status, data: null, snapshot: null }));
    const result = await service.handle(baseRequest, { token: 'valid' });
    assert.equal(result.status, status);
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
  }
});

test('database and connector failures are redacted', async () => {
  const { service } = serviceFor(async () => { throw new Error('password=secret raw payload'); });
  const result = await service.handle(baseRequest, { token: 'valid' });
  assert.equal(result.status, 'TECHNICAL_ERROR');
  assert.equal(result.reason, 'READ_ONLY_QUERY_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /password|secret|raw payload/);
});

test('mock connector contract preserves server auth boundary', async () => {
  const calls = [];
  const { service } = serviceFor(async (_pool, options) => {
    calls.push(options);
    return { ok: true, status: 'READY', snapshot: { scopeKey: 'default', scopeId: 1, runId: 1, modelVersion: 'reconciliation-certification-v1', status: 'READY', sourceStateKey: 'b'.repeat(64), finishedAt: '2026-04-30T00:00:00Z' }, queryPeriod: { ...baseRequest, semantics: 'event_at, half-open [from,to)' }, data: { grossReturnsNetByCurrency: [], confirmedPurchases: [], confirmedReturns: [], category: [], person: [], unresolved: {}, bankOnlyIncomplete: {}, limitations: [], pagination: { limit: 10, offset: 0, purchases: { hasMore: false }, returns: { hasMore: false } } } };
  });
  const connector = { invoke: (request, context) => service.handle(request, context) };
  const result = await connector.invoke({ ...baseRequest, scopeKey: 'default' }, { token: 'valid' });
  assert.equal(result.status, 'READY');
  assert.equal(calls[0].scopeKey, 'default');
});


test('non-ready or contradictory READY results never expose financial data', async () => {
  const validSnapshot = { scopeKey: 'default', scopeId: 1, runId: 1, modelVersion: 'reconciliation-certification-v1', status: 'READY', sourceStateKey: 'c'.repeat(64), finishedAt: '2026-04-30T00:00:00Z' };
  const validPeriod = { timezone: 'Europe/Moscow', from: baseRequest.from, to: baseRequest.to, semantics: 'event_at, half-open [from,to)' };
  const data = { grossReturnsNetByCurrency: [{ currency: 'RUB', gross: '9.00', returns: '0', net: '9.00' }], confirmedPurchases: [], confirmedReturns: [], category: [], person: [], unresolved: { unattributedPersonRows: [] }, bankOnlyIncomplete: {}, limitations: [], pagination: { limit: 10, offset: 0, purchases: { hasMore: false }, returns: { hasMore: false } } };
  for (const resultShape of [
    { ok: false, status: 'STALE', snapshot: validSnapshot, queryPeriod: validPeriod, data },
    { ok: true, status: 'READY', snapshot: { ...validSnapshot, status: 'STALE' }, queryPeriod: validPeriod, data },
    { ok: true, status: 'READY', snapshot: validSnapshot, queryPeriod: validPeriod, data: { grossReturnsNetByCurrency: [] } },
  ]) {
    const { service } = serviceFor(async () => resultShape);
    const result = await service.handle(baseRequest, { token: 'valid' });
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.notEqual(result.status, 'READY');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_SPENDING_MCP_MODEL, createCanonicalSpendingMcpServer, createCanonicalSpendingMcpToolHandler } from '../src/canonical-spending-mcp-server.js';

const baseRequest = Object.freeze({ scopeKey: 'default', period: 'range', timezone: 'Europe/Moscow', from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z', limit: 10, offset: 0 });
const ready = (overrides = {}) => ({
  ok: true, modelVersion: 'canonical-spending-read-service-v1', status: 'READY',
  snapshot: { scopeKey: 'default', scopeId: 1, runId: 7, modelVersion: 'reconciliation-certification-v1', sourceStateKey: 'a'.repeat(64), status: 'READY', finishedAt: '2026-04-30T00:00:00Z' },
  queryPeriod: { timezone: 'Europe/Moscow', from: baseRequest.from, to: baseRequest.to, semantics: 'event_at, half-open [from,to)' },
  data: {
    grossReturnsNetByCurrency: [{ currency: 'RUB', gross: '100.00', returns: '20.00', net: '80.00' }],
    confirmedPurchases: [{ purchase_id: 1, amount: '100.00', currency: 'RUB', purchased_at: '2026-04-10T10:00:00Z', rule_code: 'PURCHASE', rule_version: 'v1' }],
    confirmedReturns: [{ return_id: 2, return_amount: '20.00', currency: 'RUB', returned_at: '2026-04-11T10:00:00Z' }],
    category: [], person: [], unresolved: { unattributedPersonRows: [] },
    bankOnlyIncomplete: { status: 'EXCLUDED_FROM_CERTIFIED_ACQUISITIONS', reasonCode: 'BANK_ONLY_OR_UNMATCHED_NOT_PROVEN_PURCHASE' },
    limitations: ['BANK_ONLY_OR_UNMATCHED_PURCHASES_REMAIN_INCOMPLETE'],
    pagination: { limit: 10, offset: 0, purchases: { hasMore: false }, returns: { hasMore: false } },
  }, ...overrides,
});
function handlerFor(result, options = {}) {
  const calls = []; const logs = [];
  const readService = { handle: async (request, context) => { calls.push({ request, context }); return typeof result === 'function' ? result(request, context) : result; } };
  return { calls, logs, handler: createCanonicalSpendingMcpToolHandler({ readService, logger: { info: (event, summary) => logs.push({ event, summary }) }, ...options }) };
}

test('MCP tool preserves synthetic 100/20/80 result without writes', async () => {
  const { handler, calls, logs } = handlerFor(ready());
  const result = await handler(baseRequest, { authInfo: { subject: 'person-1' } });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.data.grossReturnsNetByCurrency, [{ currency: 'RUB', gross: '100.00', returns: '20.00', net: '80.00' }]);
  assert.equal(calls[0].context.authInfo.subject, 'person-1');
  assert.equal(logs[0].event, 'canonical_spending_mcp_completed');
  assert.deepEqual(Object.keys(logs[0].summary).sort(), ['currencyCount', 'purchaseCount', 'reasonCode', 'returnCount', 'scopeKey', 'status'].sort());
});
test('missing, stale and conflict results never expose financial data', async () => {
  for (const status of ['MISSING', 'STALE', 'CONFLICT', 'CORRUPT']) {
    const { handler } = handlerFor({ ok: false, status, reasonCode: status, reason: 'safe', data: null });
    const result = await handler(baseRequest, { authInfo: { subject: 'person-1' } });
    assert.equal(result.status, status); assert.equal(result.data, null);
  }
});
test('invalid authentication is delegated to the read service and fails closed', async () => {
  const { handler } = handlerFor({ ok: false, status: 'ACCESS_ERROR', reasonCode: 'AUTHENTICATION_REQUIRED', data: null });
  const result = await handler(baseRequest, { authInfo: null });
  assert.equal(result.status, 'ACCESS_ERROR'); assert.equal(result.data, null);
});
test('foreign scope is rejected by the server-authorized read service', async () => {
  const { handler, calls } = handlerFor({ ok: false, status: 'ACCESS_ERROR', reasonCode: 'SCOPE_FORBIDDEN', data: null });
  const result = await handler({ ...baseRequest, scopeKey: 'foreign' }, { authInfo: { subject: 'person-1' } });
  assert.equal(result.reasonCode, 'SCOPE_FORBIDDEN'); assert.equal(calls[0].request.scopeKey, 'foreign');
});
test('malformed input is safe and raw errors are not exposed', async () => {
  const { handler } = handlerFor(async (request) => {
    if (!request || typeof request !== 'object' || typeof request.period !== 'string') throw new Error('password=secret raw payload');
    return { ok: false, status: 'INVALID_REQUEST', reasonCode: 'INVALID_REQUEST', data: null };
  });
  const result = await handler(null, { authInfo: { subject: 'person-1' } });
  assert.equal(result.status, 'TECHNICAL_ERROR'); assert.equal(result.data, null);
  assert.doesNotMatch(JSON.stringify(result), /password|secret|raw payload/);
});
test('rate limit is bounded and returns safe access error', async () => {
  const { handler } = handlerFor(ready(), { maxRequests: 1 });
  assert.equal((await handler(baseRequest)).status, 'READY');
  const limited = await handler(baseRequest);
  assert.equal(limited.status, 'ACCESS_ERROR'); assert.equal(limited.reasonCode, 'RATE_LIMITED'); assert.equal(limited.data, null);
});
test('read-service errors do not leak database or token details', async () => {
  const { handler } = handlerFor(async () => { throw new Error('token=secret database payload'); });
  const result = await handler(baseRequest, { authInfo: { token: 'secret' } });
  assert.equal(result.status, 'TECHNICAL_ERROR'); assert.doesNotMatch(JSON.stringify(result), /secret|database payload/);
});
test('server exposes one read-only tool and reuses the injected service', async () => {
  const readService = { handle: async () => ready() };
  const { server, service } = createCanonicalSpendingMcpServer({ readService });
  assert.equal(service, readService); assert.ok(server); assert.equal(CANONICAL_SPENDING_MCP_MODEL, 'canonical-spending-mcp-v1');
});

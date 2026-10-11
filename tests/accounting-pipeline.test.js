import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccountingCatchup } from '../src/accounting-pipeline.js';

test('accounting catch-up is source-agnostic and idempotent at orchestration boundary', async () => {
  const calls = [];
  const step = (name, result = {}) => async (_pool, options) => {
    calls.push([name, options.scopeKey]);
    return result;
  };
  const first = await runAccountingCatchup({}, {
    scopeKey: 'household',
    prepaymentMatcher: step('prepayment', { created: { purchases: 1 } }),
    standaloneMatcher: step('standalone', { created: 1 }),
    returnMatcher: step('returns', { created: { returns: 0 } }),
    ledgerBuilder: step('ledger', { created: { entries: 1 } }),
    certificationBuilder: async (_pool, options) => { calls.push(['certification', options.scopeKey, options.replace, options.reuseUnchanged]); return { facts: [{ id: 1 }] }; },
    logger: { info() {} },
  });
  const second = await runAccountingCatchup({}, {
    scopeKey: 'household',
    prepaymentMatcher: step('prepayment-replay'),
    standaloneMatcher: step('standalone-replay'),
    returnMatcher: step('returns-replay'),
    ledgerBuilder: step('ledger-replay'),
    certificationBuilder: step('certification-replay'),
    logger: { info() {} },
  });
  assert.equal(first.standalone.created, 1);
  assert.equal(second.standalone.created, undefined);
  assert.deepEqual(calls.slice(0, 5).map(([name]) => name), ['prepayment', 'standalone', 'returns', 'ledger', 'certification']);
  assert.equal(calls[4][2], true);
  assert.equal(calls[4][3], true);
  assert.deepEqual(calls.slice(5).map(([name]) => name), ['prepayment-replay', 'standalone-replay', 'returns-replay', 'ledger-replay', 'certification-replay']);
  assert.ok(calls.every(([, scope]) => scope === 'household'));
});

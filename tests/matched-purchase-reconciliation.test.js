import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV,
  MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV,
  MATCHED_PURCHASE_RECONCILIATION_MAX_WRITES,
  matchedPurchaseReconciliationWindow,
  readMatchedPurchaseReconciliationOptIn,
  runAccountingCatchupsWithMatchedPurchaseCanary,
  runBoundedMatchedPurchaseReconciliation,
} from '../src/matched-purchase-reconciliation.js';
import { MATCHED_PURCHASE_ORCHESTRATION_VERSION } from '../src/matched-purchase-orchestration.js';

const now = new Date('2026-10-12T12:00:00.000Z');
const window = matchedPurchaseReconciliationWindow(now);
const decision = (action, matchKey = 'a'.repeat(64)) => ({ scopeKey: 'canary-scope', matchKey, orchestrationAction: action });
function readOnlyPool() {
  const statements = [];
  return {
    statements,
    async connect() {
      return {
        async query(sql) {
          statements.push(sql);
          return sql.includes('current_setting') ? { rows: [{ value: 'on' }] } : { rows: [] };
        },
        release() {},
      };
    },
  };
}
const projection = (overrides = {}) => ({
  modelVersion: MATCHED_PURCHASE_ORCHESTRATION_VERSION,
  readiness: 'READY',
  decisions: [],
  summary: {
    persistRequired: 0, alreadyPersisted: 0, blockedMatchedPairs: 0,
    ambiguousBankPurchases: 0, ambiguousReceipts: 0,
    unmatchedBankPurchases: 0, unmatchedReceipts: 0,
    ineligibleBankEntries: 0, ineligibleReceipts: 0,
  },
  ...overrides,
});

test('canary opt-in is exact and defaults to disabled', () => {
  assert.deepEqual(readMatchedPurchaseReconciliationOptIn({}), { enabled: false, canaryScopeKey: null });
  assert.deepEqual(readMatchedPurchaseReconciliationOptIn({
    [MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV]: 'TRUE',
    [MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV]: ' scope-a ',
  }), { enabled: false, canaryScopeKey: 'scope-a' });
  assert.deepEqual(readMatchedPurchaseReconciliationOptIn({
    [MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV]: 'true',
    [MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV]: ' scope-a ',
  }), { enabled: true, canaryScopeKey: 'scope-a' });
});

test('rolling reconciliation window is bounded to the existing approved maximum', () => {
  assert.equal(Date.parse(window.to) - Date.parse(window.from), 60 * 24 * 60 * 60 * 1000);
});

test('default-off reconciliation performs no preview or writer call', async () => {
  let calls = 0;
  const result = await runBoundedMatchedPurchaseReconciliation({}, {
    enabled: false,
    preview: async () => { calls += 1; throw new Error('must not be called'); },
    persist: async () => { calls += 1; throw new Error('must not be called'); },
  });
  assert.equal(result.status, 'DISABLED');
  assert.equal(result.persisted, 0);
  assert.equal(calls, 0);
});

test('runner requires an exact canary scope and a finite period no longer than the policy', async () => {
  let calls = 0;
  const base = { enabled: true, scopeKey: 'scope-a', canaryScopeKey: 'scope-b', ...window };
  const mismatch = await runBoundedMatchedPurchaseReconciliation({}, { ...base, preview: async () => { calls += 1; } });
  assert.equal(mismatch.reasonCode, 'CANARY_SCOPE_MISMATCH');
  const tooWide = await runBoundedMatchedPurchaseReconciliation({}, {
    ...base,
    canaryScopeKey: 'scope-a',
    from: new Date(Date.parse(window.to) - 61 * 24 * 60 * 60 * 1000).toISOString(),
    preview: async () => { calls += 1; },
  });
  assert.equal(tooWide.reasonCode, 'BOUNDED_PERIOD_INVALID');
  assert.equal(calls, 0);
});

test('only one deterministic PERSIST_REQUIRED decision is sent to the transactional writer', async () => {
  const pool = readOnlyPool();
  const persistedKeys = [];
  const result = await runBoundedMatchedPurchaseReconciliation(pool, {
    enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', ...window,
    preview: async (_pool, options) => {
      assert.equal(options.scopeKey, 'canary-scope');
      assert.equal(options.receiptMaxTimeDeltaMs, 300000);
      return projection({
        decisions: [decision('PERSIST_REQUIRED', 'b'.repeat(64)), decision('PERSIST_REQUIRED', 'a'.repeat(64)), decision('BLOCKED', 'c'.repeat(64))],
        summary: { ...projection().summary, persistRequired: 2, blockedMatchedPairs: 1 },
      });
    },
    persist: async (_pool, options) => { persistedKeys.push(options.matchKey); return { outcome: 'PERSISTED' }; },
  });
  assert.deepEqual(persistedKeys, ['a'.repeat(64)]);
  assert.equal(result.persisted, 1);
  assert.equal(result.blocked, 1);
  assert.equal(result.deferred, 1);
  assert.equal(MATCHED_PURCHASE_RECONCILIATION_MAX_WRITES, 1);
  assert.equal(pool.statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.statements.at(-1), 'ROLLBACK');
});

test('reused and ambiguous decisions never reach the writer', async () => {
  const pool = readOnlyPool();
  let writes = 0;
  const result = await runBoundedMatchedPurchaseReconciliation(pool, {
    enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', ...window,
    preview: async () => projection({
      readiness: 'REVIEW_REQUIRED',
      decisions: [decision('NOOP_ALREADY_PERSISTED')],
      summary: { ...projection().summary, alreadyPersisted: 1, ambiguousBankPurchases: 1, ambiguousReceipts: 2 },
    }),
    persist: async () => { writes += 1; },
  });
  assert.equal(result.reused, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.ambiguousReceipts, 2);
  assert.equal(result.status, 'REVIEW_REQUIRED');
  assert.equal(writes, 0);
});

test('invalid preview or inconsistent counts fail closed without a writer call', async () => {
  let writes = 0;
  const base = { enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', ...window };
  const invalidModel = await runBoundedMatchedPurchaseReconciliation(readOnlyPool(), {
    ...base,
    preview: async () => projection({ modelVersion: 'unexpected' }),
    persist: async () => { writes += 1; },
  });
  const inconsistent = await runBoundedMatchedPurchaseReconciliation(readOnlyPool(), {
    ...base,
    preview: async () => projection({ decisions: [decision('PERSIST_REQUIRED')] }),
    persist: async () => { writes += 1; },
  });
  assert.equal(invalidModel.reasonCode, 'PREVIEW_CONTRACT_INVALID');
  assert.equal(inconsistent.reasonCode, 'PREVIEW_CONTRACT_INVALID');
  assert.equal(writes, 0);
});

test('writer failure is classified without exposing free-form error text', async () => {
  const result = await runBoundedMatchedPurchaseReconciliation(readOnlyPool(), {
    enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', ...window,
    preview: async () => projection({
      decisions: [decision('PERSIST_REQUIRED')],
      summary: { ...projection().summary, persistRequired: 1 },
    }),
    persist: async () => { throw Object.assign(new Error('secret SQL and account data'), { code: 'MATCH_PERSISTENCE_CONFLICT' }); },
  });
  assert.equal(result.errors, 1);
  assert.equal(result.reasonCode, 'MATCH_PERSISTENCE_CONFLICT');
  assert.doesNotMatch(JSON.stringify(result), /secret SQL|account data/);
});

test('preview rollback failure destroys the read-only PostgreSQL client', async () => {
  let releasedWithError = false;
  let rollbacks = 0;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('current_setting')) return { rows: [{ value: 'on' }] };
          if (sql === 'ROLLBACK') {
            rollbacks += 1;
            throw new Error('synthetic rollback failure');
          }
          return { rows: [] };
        },
        release(error) { releasedWithError = Boolean(error); },
      };
    },
  };
  const result = await runBoundedMatchedPurchaseReconciliation(pool, {
    enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', ...window,
    preview: async () => projection(),
  });
  assert.equal(result.errors, 1);
  assert.equal(result.reasonCode, 'RECONCILIATION_ERROR');
  assert.equal(releasedWithError, true);
  assert.equal(rollbacks, 1);
});

test('accounting catch-up precedes reconciliation and the default path remains writer-free', async () => {
  const order = [];
  const defaultResult = await runAccountingCatchupsWithMatchedPurchaseCanary({
    pool: {}, sources: [{ enabled: true, scopeKey: 'scope-a' }], now,
    runCatchup: async (scope) => order.push(`catchup:${scope}`),
    reconcile: async () => { order.push('reconcile'); },
  });
  assert.deepEqual(order, ['catchup:scope-a']);
  assert.deepEqual(defaultResult.reconciliations, []);
  order.length = 0;
  await runAccountingCatchupsWithMatchedPurchaseCanary({
    pool: {}, sources: [{ enabled: true, scopeKey: 'scope-a' }], canary: { enabled: true, canaryScopeKey: 'scope-a' }, now,
    runCatchup: async (scope) => order.push(`catchup:${scope}`),
    reconcile: async (_pool, options) => { order.push(`reconcile:${options.scopeKey}`); return { status: 'COMPLETED', persisted: 1, reused: 0, blocked: 0, ambiguous: 0, ambiguousReceipts: 0, errors: 0, deferred: 0, unmatchedBankPurchases: 0, unmatchedReceipts: 0 }; },
  });
  assert.deepEqual(order, ['catchup:scope-a', 'reconcile:scope-a']);
});

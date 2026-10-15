import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV,
  MATCHED_PURCHASE_RECONCILIATION_APPROVED_MATCH_KEY_ENV,
  MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV,
  MATCHED_PURCHASE_RECONCILIATION_MAX_WRITES,
  MATCHED_PURCHASE_RECONCILIATION_AUTO_MAX_WRITES,
  MATCHED_PURCHASE_RECONCILIATION_AUTO_POLICY_ENV,
  MATCHED_PURCHASE_RECONCILIATION_START_AT_ENV,
  matchedPurchaseReconciliationWindow,
  readMatchedPurchaseReconciliationOptIn,
  runAccountingCatchupsWithMatchedPurchaseCanary,
  runBoundedMatchedPurchaseReconciliation,
} from '../src/matched-purchase-reconciliation.js';
import { MATCHED_PURCHASE_ORCHESTRATION_VERSION } from '../src/matched-purchase-orchestration.js';
import { MATCHED_PURCHASE_AUTO_POLICY } from '../src/matched-purchase-orchestration.js';
import { BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES } from '../src/bank-receipt-matching.js';
import { persistMatchedPurchase } from '../src/matched-purchase-persistence.js';

const now = new Date('2026-10-12T12:00:00.000Z');
const window = matchedPurchaseReconciliationWindow(now);
const approvedMatchKey = 'a'.repeat(64);
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
  assert.deepEqual(readMatchedPurchaseReconciliationOptIn({}), {
    enabled: false, canaryScopeKey: null, approvedMatchKey: null, automaticPolicy: null, bankIngestedAfter: null,
  });
  assert.deepEqual(readMatchedPurchaseReconciliationOptIn({
    [MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV]: 'TRUE',
    [MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV]: ' scope-a ',
  }), { enabled: false, canaryScopeKey: 'scope-a', approvedMatchKey: null, automaticPolicy: null, bankIngestedAfter: null });
  assert.deepEqual(readMatchedPurchaseReconciliationOptIn({
    [MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV]: 'true',
    [MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV]: ' scope-a ',
    [MATCHED_PURCHASE_RECONCILIATION_APPROVED_MATCH_KEY_ENV]: ` ${approvedMatchKey.toUpperCase()} `,
  }), { enabled: true, canaryScopeKey: 'scope-a', approvedMatchKey, automaticPolicy: null, bankIngestedAfter: null });
  assert.deepEqual(readMatchedPurchaseReconciliationOptIn({
    [MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV]: 'true',
    [MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV]: 'scope-a',
    [MATCHED_PURCHASE_RECONCILIATION_AUTO_POLICY_ENV]: MATCHED_PURCHASE_AUTO_POLICY,
    [MATCHED_PURCHASE_RECONCILIATION_START_AT_ENV]: '2026-10-01T00:00:00.000Z',
  }), {
    enabled: true, canaryScopeKey: 'scope-a', approvedMatchKey: null,
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY, bankIngestedAfter: '2026-10-01T00:00:00.000Z',
  });
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
  const base = { enabled: true, scopeKey: 'scope-a', canaryScopeKey: 'scope-b', approvedMatchKey, ...window };
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

test('enabled runner without an explicitly approved match key stops before preview or writer', async () => {
  let calls = 0;
  const result = await runBoundedMatchedPurchaseReconciliation({}, {
    enabled: true, scopeKey: 'scope-a', canaryScopeKey: 'scope-a', ...window,
    preview: async () => { calls += 1; },
    persist: async () => { calls += 1; },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reasonCode, 'APPROVED_MATCH_KEY_REQUIRED');
  assert.equal(calls, 0);
});

test('automatic policy requires explicit activation scope and a canonical new-bank cutoff', async () => {
  const base = {
    enabled: true,
    scopeKey: 'scope-a',
    canaryScopeKey: 'scope-a',
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    ...window,
  };
  const missingCutoff = await runBoundedMatchedPurchaseReconciliation({}, {
    ...base,
    preview: async () => projection(),
  });
  assert.equal(missingCutoff.reasonCode, 'AUTOMATION_START_AT_REQUIRED');
  const invalidCutoff = await runBoundedMatchedPurchaseReconciliation({}, {
    ...base,
    bankIngestedAfter: '2026-10-01',
    preview: async () => projection(),
  });
  assert.equal(invalidCutoff.reasonCode, 'AUTOMATION_START_AT_REQUIRED');
  const noKey = await runBoundedMatchedPurchaseReconciliation(readOnlyPool(), {
    ...base,
    bankIngestedAfter: '2026-10-01T00:00:00.000Z',
    preview: async () => projection(),
  });
  assert.equal(noKey.status, 'COMPLETED');
  assert.equal(noKey.persisted, 0);
  assert.equal(MATCHED_PURCHASE_RECONCILIATION_AUTO_MAX_WRITES, 25);
});

test('automatic policy refuses widened matching windows before preview or persistence', async () => {
  let previews = 0;
  const options = {
    enabled: true,
    scopeKey: 'scope-a',
    canaryScopeKey: 'scope-a',
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: '2026-10-01T00:00:00.000Z',
    ...window,
    internalTransferMaxTimeDeltaMs: 5000,
    receiptMaxTimeDeltaMs: 3600000,
    preview: async () => { previews += 1; return projection(); },
  };
  const result = await runBoundedMatchedPurchaseReconciliation({}, options);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reasonCode, 'AUTOMATION_WINDOW_POLICY_MISMATCH');
  assert.equal(previews, 0);

  let connections = 0;
  await assert.rejects(() => persistMatchedPurchase({
    connect: async () => { connections += 1; throw new Error('must not acquire a writer connection'); },
  }, {
    ...options,
    assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.NEAREST_DETERMINISTIC,
    requireSourceProviderBinding: true,
  }), (error) => error.code === 'AUTO_POLICY_INVALID');
  assert.equal(connections, 0);
});

test('approved automatic policy writes multiple verified decisions without per-purchase keys', async () => {
  const pool = readOnlyPool();
  const cutoff = '2026-10-01T00:00:00.000Z';
  const keys = ['a'.repeat(64), 'b'.repeat(64)];
  const persisted = [];
  const result = await runBoundedMatchedPurchaseReconciliation(pool, {
    enabled: true,
    scopeKey: 'canary-scope',
    canaryScopeKey: 'canary-scope',
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: cutoff,
    ...window,
    preview: async (_pool, options) => {
      assert.equal(options.matchKey, null);
      assert.equal(options.approvedMatchKey, null);
      assert.equal(options.automaticPolicy, MATCHED_PURCHASE_AUTO_POLICY);
      assert.equal(options.bankIngestedAfter, cutoff);
      return projection({
        decisions: keys.map((matchKey) => ({
          ...decision('PERSIST_REQUIRED', matchKey),
          approvalBasis: MATCHED_PURCHASE_AUTO_POLICY,
          automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
          assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.NEAREST_DETERMINISTIC,
          sourceProviderBindingVerified: true,
        })),
        summary: { ...projection().summary, persistRequired: 2 },
      });
    },
    persist: async (_pool, options) => {
      assert.equal(options.approvedMatchKey, null);
      assert.equal(options.automaticPolicy, MATCHED_PURCHASE_AUTO_POLICY);
      assert.equal(options.assignmentPolicy, BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.NEAREST_DETERMINISTIC);
      assert.equal(options.requireSourceProviderBinding, true);
      assert.equal(options.bankIngestedAfter, cutoff);
      persisted.push(options.matchKey);
      return { outcome: 'PERSISTED' };
    },
  });
  assert.deepEqual(persisted, keys);
  assert.equal(result.persisted, 2);
  assert.equal(result.errors, 0);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(pool.statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.statements.at(-1), 'ROLLBACK');
});

test('automatic policy rejects a candidate missing binding proof and keeps processing other candidates', async () => {
  const persisted = [];
  const result = await runBoundedMatchedPurchaseReconciliation(readOnlyPool(), {
    enabled: true, scopeKey: 'scope-a', canaryScopeKey: 'scope-a',
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: '2026-10-01T00:00:00.000Z', ...window,
    preview: async () => projection({
      decisions: [
        { ...decision('PERSIST_REQUIRED', 'c'.repeat(64)), approvalBasis: MATCHED_PURCHASE_AUTO_POLICY, automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY, assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.NEAREST_DETERMINISTIC, sourceProviderBindingVerified: false },
        { ...decision('PERSIST_REQUIRED', 'd'.repeat(64)), approvalBasis: MATCHED_PURCHASE_AUTO_POLICY, automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY, assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.NEAREST_DETERMINISTIC, sourceProviderBindingVerified: true },
      ],
      summary: { ...projection().summary, persistRequired: 2 },
    }),
    persist: async (_pool, options) => { persisted.push(options.matchKey); return { outcome: 'PERSISTED' }; },
  });
  assert.equal(result.reasonCode, 'PREVIEW_CONTRACT_INVALID');
  assert.deepEqual(persisted, []);
});

test('only one deterministic PERSIST_REQUIRED decision is sent to the transactional writer', async () => {
  const pool = readOnlyPool();
  const persistedKeys = [];
  const result = await runBoundedMatchedPurchaseReconciliation(pool, {
    enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', approvedMatchKey, ...window,
    preview: async (_pool, options) => {
      assert.equal(options.scopeKey, 'canary-scope');
      assert.equal(options.matchKey, approvedMatchKey);
      assert.equal(options.approvedMatchKey, approvedMatchKey);
      assert.equal(options.receiptMaxTimeDeltaMs, 300000);
      return projection({
        decisions: [decision('PERSIST_REQUIRED', approvedMatchKey), decision('BLOCKED', 'b'.repeat(64)), decision('BLOCKED', 'c'.repeat(64))],
        summary: { ...projection().summary, persistRequired: 1, blockedMatchedPairs: 2 },
      });
    },
    persist: async (_pool, options) => { persistedKeys.push(options.matchKey); return { outcome: 'PERSISTED' }; },
  });
  assert.deepEqual(persistedKeys, [approvedMatchKey]);
  assert.equal(result.persisted, 1);
  assert.equal(result.blocked, 2);
  assert.equal(result.deferred, 0);
  assert.equal(MATCHED_PURCHASE_RECONCILIATION_MAX_WRITES, 1);
  assert.equal(pool.statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.statements.at(-1), 'ROLLBACK');
});

test('reused and ambiguous decisions never reach the writer', async () => {
  const pool = readOnlyPool();
  let writes = 0;
  const result = await runBoundedMatchedPurchaseReconciliation(pool, {
    enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', approvedMatchKey, ...window,
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
  base.approvedMatchKey = approvedMatchKey;
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
    enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', approvedMatchKey, ...window,
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
    enabled: true, scopeKey: 'canary-scope', canaryScopeKey: 'canary-scope', approvedMatchKey, ...window,
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
    pool: {}, sources: [{ enabled: true, scopeKey: 'scope-a' }], canary: { enabled: true, canaryScopeKey: 'scope-a', approvedMatchKey }, now,
    runCatchup: async (scope) => order.push(`catchup:${scope}`),
    reconcile: async (_pool, options) => { order.push(`reconcile:${options.scopeKey}`); return { status: 'COMPLETED', persisted: 1, reused: 0, blocked: 0, ambiguous: 0, ambiguousReceipts: 0, errors: 0, deferred: 0, unmatchedBankPurchases: 0, unmatchedReceipts: 0 }; },
  });
  assert.deepEqual(order, ['catchup:scope-a', 'reconcile:scope-a']);
});

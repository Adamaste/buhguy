import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANK_CASH_FLOW_PROJECTION_VERSION,
  MOVEMENT_TYPES,
  loadBankCashFlowProjection,
  projectBankCashFlowTransaction,
  projectBankCashFlowTransactions,
} from '../src/bank-cash-flow-projection.js';

const base = (overrides = {}) => ({
  bankTransactionId: 10,
  occurredAt: '2026-10-04T10:00:00Z',
  amount: '100.00',
  currency: 'RUB',
  sourceEventType: 'PURCHASE',
  direction: 'DEBIT',
  normalizationStatus: 'READY',
  evidenceQuality: 'EXACT',
  sourceScopeKeys: ['scope-a'],
  accountResolutionState: 'UNKNOWN',
  ...overrides,
});

test('projects proven PURCHASE/DEBIT without inventing business-event persistence', () => {
  const result = projectBankCashFlowTransaction(base());
  assert.equal(result.modelVersion, BANK_CASH_FLOW_PROJECTION_VERSION);
  assert.equal(result.movementType, MOVEMENT_TYPES.PURCHASE);
  assert.equal(result.projectionStatus, 'PROJECTED');
  assert.equal(result.reasonCode, 'PROVEN_PURCHASE_DEBIT');
});

test('projects proven outgoing and incoming pairs independently without internal transfer matching', () => {
  const result = projectBankCashFlowTransactions([
    base({ bankTransactionId: 11, sourceEventType: 'OUTGOING_TRANSFER', financialAccountId: 77, accountResolutionState: 'EXACT', financialAccountScopeKey: 'scope-a' }),
    base({ bankTransactionId: 12, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT', financialAccountId: 88, accountResolutionState: 'EXACT', financialAccountScopeKey: 'scope-a' }),
  ]);
  assert.deepEqual(result.projections.map((row) => row.movementType), ['OUTGOING_TRANSFER', 'INCOMING_TRANSFER']);
  assert.deepEqual(result.projections.map((row) => row.reasonCode), ['PROVEN_OUTGOING_TRANSFER_DEBIT', 'PROVEN_INCOMING_TRANSFER_CREDIT']);
  assert.deepEqual(result.projections.map((row) => row.financialAccountId), [77, 88]);
  assert.equal(result.projections.length, 2);
  assert.equal(result.summary.outgoingTransfers, 1);
  assert.equal(result.summary.incomingTransfers, 1);
  assert.equal(result.projections.some((row) => row.movementType === 'INTERNAL_TRANSFER'), false);
});

test('unknown event or direction never promotes', () => {
  for (const overrides of [
    { sourceEventType: 'UNKNOWN' },
    { sourceEventType: 'PURCHASE', direction: 'UNKNOWN' },
    { sourceEventType: 'OUTGOING_TRANSFER', direction: 'CREDIT' },
    { sourceEventType: 'INCOMING_TRANSFER', direction: 'DEBIT' },
    { sourceEventType: 'REFUND', direction: 'CREDIT' },
  ]) {
    const row = projectBankCashFlowTransaction(base(overrides));
    assert.equal(row.projectionStatus, 'UNRESOLVED');
    assert.equal(row.movementType, 'UNRESOLVED');
  }
});

test('not-ready, non-exact and incomplete facts fail closed', () => {
  assert.equal(projectBankCashFlowTransaction(base({ normalizationStatus: 'PARTIAL' })).reasonCode, 'NORMALIZATION_NOT_READY');
  assert.equal(projectBankCashFlowTransaction(base({ evidenceQuality: 'PARTIAL' })).reasonCode, 'EVIDENCE_NOT_EXACT');
  assert.equal(projectBankCashFlowTransaction(base({ amount: null })).reasonCode, 'CASH_FLOW_FACTS_INCOMPLETE');
  assert.equal(projectBankCashFlowTransaction(base({ currency: null })).reasonCode, 'CASH_FLOW_FACTS_INCOMPLETE');
  assert.equal(projectBankCashFlowTransaction(base({ occurredAt: null })).reasonCode, 'CASH_FLOW_FACTS_INCOMPLETE');
});

test('account identity is concrete only from explicit resolved account evidence', () => {
  for (const state of ['EXACT', 'MANUAL', 'RECONCILED']) {
    const resolved = projectBankCashFlowTransaction(base({ financialAccountId: 77, accountResolutionState: state, accountResolutionProvenance: 'EXPLICIT_TEST_EVIDENCE', financialAccountScopeKey: 'scope-a' }));
    assert.equal(resolved.accountIdentityStatus, 'CONCRETE');
    assert.equal(resolved.financialAccountId, 77);
  }
  const unknown = projectBankCashFlowTransaction(base({ financialAccountId: 77, accountResolutionState: 'UNKNOWN' }));
  assert.equal(unknown.accountIdentityStatus, 'UNRESOLVED');
  assert.equal(unknown.financialAccountId, null);
});

test('canonicalizes NUMERIC(18,2) money as a string without IEEE-754 rounding', () => {
  const result = projectBankCashFlowTransaction(base({ amount: '99999999999999.99' }));
  assert.equal(result.amount, '99999999999999.99');
  assert.equal(projectBankCashFlowTransaction(base({ amount: '1' })).amount, '1.00');
  assert.equal(projectBankCashFlowTransaction(base({ amount: '1.2' })).amount, '1.20');
  assert.equal(projectBankCashFlowTransaction(base({ amount: '0001.20' })).amount, '1.20');
  assert.equal(projectBankCashFlowTransaction(base({ amount: '0' })).amount, '0.00');
});

test('source context is not account ownership proof and account scope conflicts fail closed', () => {
  const contextOnly = projectBankCashFlowTransaction(base({ accountResolutionState: 'UNKNOWN' }));
  assert.equal(contextOnly.accountIdentityStatus, 'UNRESOLVED');
  const conflict = projectBankCashFlowTransaction(base({ financialAccountId: 77, accountResolutionState: 'EXACT', financialAccountScopeKey: 'scope-b' }));
  assert.equal(conflict.projectionStatus, 'UNRESOLVED');
  assert.equal(conflict.reasonCode, 'ACCOUNT_SCOPE_CONFLICT');
});

test('ambiguous source scopes fail closed', () => {
  const row = projectBankCashFlowTransaction(base({ sourceScopeKeys: ['scope-a', 'scope-b'] }));
  assert.equal(row.projectionStatus, 'UNRESOLVED');
  assert.equal(row.reasonCode, 'SOURCE_SCOPE_AMBIGUOUS');
});

test('deterministic keys and collection invariant are stable', () => {
  const first = projectBankCashFlowTransactions([base({ bankTransactionId: 13 }), base({ bankTransactionId: 14, sourceEventType: 'UNKNOWN' })]);
  const second = projectBankCashFlowTransactions([base({ bankTransactionId: 13 }), base({ bankTransactionId: 14, sourceEventType: 'UNKNOWN' })]);
  assert.deepEqual(first, second);
  assert.equal(first.summary.totalTransactions, first.summary.projectedTransactions + first.summary.unresolvedTransactions);
  assert.equal(first.summary.unresolvedByReason.EVENT_TYPE_UNKNOWN, 1);
});

test('loader uses SELECT-only query and half-open period parameters', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [base({ bankTransactionId: 15 })] };
  } };
  const result = await loadBankCashFlowProjection(pool, { scopeKey: 'scope-a', from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' });
  assert.equal(result.summary.projectedTransactions, 1);
  assert.match(calls[0].sql, /SELECT/);
  assert.doesNotMatch(calls[0].sql, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
  assert.deepEqual(calls[0].params, ['scope-a', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z']);
});

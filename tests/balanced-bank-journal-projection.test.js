import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_ACCOUNT_TYPES,
  projectBalancedBankJournal,
  projectBalancedBankJournals,
  UNRESOLVED_BANK_ACCOUNT,
} from '../src/balanced-bank-journal-projection.js';
import { projectBankCashFlowTransaction } from '../src/bank-cash-flow-projection.js';

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

const source = (overrides = {}) => projectBankCashFlowTransaction(base(overrides));

function assertBalanced(result) {
  assert.equal(result.projectionStatus, 'PROJECTED');
  assert.equal(result.postings.length, 2);
  assert.deepEqual(result.postings.map((posting) => posting.side), ['DEBIT', 'CREDIT']);
  assert.equal(result.postings[0].amount, result.postings[1].amount);
  assert.equal(result.postings[0].currency, result.postings[1].currency);
  assert.equal(result.postings[0].account.type === JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT
    || result.postings[0].account.type === JOURNAL_ACCOUNT_TYPES.SYMBOLIC, true);
  assert.equal(result.postings[1].account.type === JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT
    || result.postings[1].account.type === JOURNAL_ACCOUNT_TYPES.SYMBOLIC, true);
  assert.equal(result.postings.some((posting) => posting.account.code === 'INTERNAL_TRANSFER'), false);
}

test('PURCHASE + DEBIT creates one balanced entry with concrete account side', () => {
  const result = projectBalancedBankJournal(source({ financialAccountId: 42, accountResolutionState: 'EXACT', financialAccountScopeKey: 'scope-a' }));
  assertBalanced(result);
  assert.deepEqual(result.postings.map((posting) => posting.account.code ?? posting.account.financialAccountId), ['UNCLASSIFIED_PURCHASE', 42]);
});

test('PURCHASE + DEBIT uses symbolic unresolved bank account without inventing identity', () => {
  const result = projectBalancedBankJournal(source());
  assertBalanced(result);
  assert.deepEqual(result.postings[1].account, { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code: UNRESOLVED_BANK_ACCOUNT });
});

test('account refinement changes the content-sensitive journal key', () => {
  const unresolved = projectBalancedBankJournal(source());
  const concrete = projectBalancedBankJournal(source({
    financialAccountId: 42,
    accountResolutionState: 'EXACT',
    accountResolutionProvenance: 'OBSERVED_PROVIDER_REFERENCE',
    financialAccountScopeKey: 'scope-a',
  }));
  assertBalanced(unresolved);
  assertBalanced(concrete);
  assert.notEqual(unresolved.journalKey, concrete.journalKey);
  assert.notDeepEqual(unresolved.postings, concrete.postings);
});

test('journal output preserves source and account-resolution provenance', () => {
  const src = source({
    financialAccountId: 42,
    accountResolutionState: 'MANUAL',
    accountResolutionProvenance: 'USER_CONFIRMED',
    financialAccountScopeKey: 'scope-a',
  });
  const result = projectBalancedBankJournal(src);
  assert.deepEqual(result.sourceProvenance, {
    projectionVersion: 'bank-cash-flow-projection-v1',
    projectionKey: src.projectionKey,
    sourceReasonCode: 'PROVEN_PURCHASE_DEBIT',
    bankTransactionId: 10,
    sourceProjectionStatus: 'PROJECTED',
    sourceMovementType: 'PURCHASE',
    accountIdentityStatus: 'CONCRETE',
    accountResolutionState: 'MANUAL',
    accountResolutionProvenance: 'USER_CONFIRMED',
  });
});

test('OUTGOING_TRANSFER + DEBIT maps to unclassified outgoing and bank credit', () => {
  const result = projectBalancedBankJournal(source({ sourceEventType: 'OUTGOING_TRANSFER' }));
  assertBalanced(result);
  assert.equal(result.postings[0].account.code, 'UNCLASSIFIED_OUTGOING');
  assert.equal(result.postings[1].side, 'CREDIT');
});

test('INCOMING_TRANSFER + CREDIT maps to bank debit and unclassified incoming', () => {
  const result = projectBalancedBankJournal(source({ sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT' }));
  assertBalanced(result);
  assert.equal(result.postings[0].account.code, UNRESOLVED_BANK_ACCOUNT);
  assert.equal(result.postings[1].account.code, 'UNCLASSIFIED_INCOMING');
});

test('exact UNKNOWN + DEBIT remains monetary and becomes unclassified outgoing', () => {
  const result = projectBalancedBankJournal(source({ sourceEventType: 'UNKNOWN' }));
  assertBalanced(result);
  assert.equal(result.reasonCode, 'PROVEN_MONETARY_MOVEMENT_EVENT_TYPE_UNKNOWN');
  assert.equal(result.postings[0].account.code, 'UNCLASSIFIED_OUTGOING');
});

test('exact UNKNOWN + CREDIT remains monetary and becomes unclassified incoming', () => {
  const result = projectBalancedBankJournal(source({ sourceEventType: 'UNKNOWN', direction: 'CREDIT' }));
  assertBalanced(result);
  assert.equal(result.reasonCode, 'PROVEN_MONETARY_MOVEMENT_EVENT_TYPE_UNKNOWN');
  assert.equal(result.postings[1].account.code, 'UNCLASSIFIED_INCOMING');
});

test('UNKNOWN direction creates no postings', () => {
  const result = projectBalancedBankJournal(source({ sourceEventType: 'UNKNOWN', direction: 'UNKNOWN' }));
  assert.equal(result.projectionStatus, 'UNRESOLVED');
  assert.deepEqual(result.postings, []);
});

test('ambiguous scope and account scope conflict fail closed', () => {
  const ambiguous = projectBalancedBankJournal(source({ sourceScopeKeys: ['scope-a', 'scope-b'] }));
  assert.equal(ambiguous.reasonCode, 'SOURCE_SCOPE_AMBIGUOUS');
  assert.deepEqual(ambiguous.postings, []);
  const conflict = projectBalancedBankJournal(source({ financialAccountId: 42, accountResolutionState: 'EXACT', financialAccountScopeKey: 'scope-b' }));
  assert.equal(conflict.reasonCode, 'ACCOUNT_SCOPE_CONFLICT');
  assert.deepEqual(conflict.postings, []);
});

test('non-ready, non-exact and incomplete facts remain unresolved', () => {
  for (const overrides of [
    { normalizationStatus: 'PARTIAL' },
    { evidenceQuality: 'PARTIAL' },
    { amount: null },
    { currency: null },
    { occurredAt: null },
  ]) {
    const result = projectBalancedBankJournal(source(overrides));
    assert.equal(result.projectionStatus, 'UNRESOLVED');
    assert.deepEqual(result.postings, []);
  }
});

test('direction conflicts and unsupported known event types remain unresolved', () => {
  const conflict = projectBalancedBankJournal(source({ sourceEventType: 'PURCHASE', direction: 'CREDIT' }));
  assert.equal(conflict.reasonCode, 'EVENT_DIRECTION_CONFLICT');
  assert.deepEqual(conflict.postings, []);
  const unsupported = projectBalancedBankJournal(source({ sourceEventType: 'REFUND', direction: 'CREDIT' }));
  assert.equal(unsupported.reasonCode, 'EVENT_TYPE_UNSUPPORTED');
  assert.deepEqual(unsupported.postings, []);
});

test('money remains an exact decimal string beyond JavaScript safe integers', () => {
  const result = projectBalancedBankJournal(source({ amount: '99999999999999.99' }));
  assertBalanced(result);
  assert.equal(result.amount, '99999999999999.99');
  assert.equal(result.postings[0].amount, '99999999999999.99');
  assert.equal(result.postings[1].amount, '99999999999999.99');
});

test('journal keys and results are deterministic and collection invariant holds', () => {
  const rows = [
    source({ bankTransactionId: 20 }),
    source({ bankTransactionId: 21, sourceEventType: 'UNKNOWN' }),
    source({ bankTransactionId: 22, sourceEventType: 'UNKNOWN', direction: 'UNKNOWN' }),
  ];
  const first = projectBalancedBankJournals(rows);
  const second = projectBalancedBankJournals(rows);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.projections.map((row) => row.journalKey),
    second.projections.map((row) => row.journalKey),
  );
  assert.equal(first.summary.totalTransactions, first.summary.projectedTransactions + first.summary.unresolvedTransactions);
  assert.equal(first.summary.projectedTransactions, 2);
  assert.equal(first.summary.unresolvedTransactions, 1);
  assert.equal(first.projections.some((row) => row.postings.some((posting) => posting.account.code === 'INTERNAL_TRANSFER')), false);
});

test('loader delegates to the SELECT-only bank cash-flow path', async () => {
  const { loadBalancedBankJournalProjection } = await import('../src/balanced-bank-journal-projection.js');
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [base({ bankTransactionId: 30 })] };
  } };
  const result = await loadBalancedBankJournalProjection(pool, { scopeKey: 'scope-a' });
  assert.equal(result.summary.projectedTransactions, 1);
  assert.match(calls[0].sql, /SELECT/);
  assert.doesNotMatch(calls[0].sql, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
});

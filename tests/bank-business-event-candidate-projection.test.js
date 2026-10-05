import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSINESS_EVENT_CANDIDATE_KINDS,
  BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES,
  BANK_BUSINESS_EVENT_CANDIDATE_PROJECTION_VERSION,
  loadBankBusinessEventCandidateProjection,
  projectBankBusinessEventCandidate,
  projectBankBusinessEventCandidates,
  TRANSFER_DIRECTIONS,
} from '../src/bank-business-event-candidate-projection.js';
import { projectBankCashFlowTransaction } from '../src/bank-cash-flow-projection.js';
import { projectBalancedBankJournal } from '../src/balanced-bank-journal-projection.js';

const bankRow = (overrides = {}) => ({
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

const journal = (overrides = {}) => projectBalancedBankJournal(
  projectBankCashFlowTransaction(bankRow(overrides)),
);

const project = (overrides = {}) => projectBankBusinessEventCandidate(journal(overrides));

function assertProjected(candidate) {
  assert.equal(candidate.projectionStatus, BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.PROJECTED);
  assert.match(candidate.candidateKey, /^[0-9a-f]{64}$/);
  assert.equal(candidate.modelVersion, BANK_BUSINESS_EVENT_CANDIDATE_PROJECTION_VERSION);
}

test('PURCHASE/DEBIT becomes a purchase candidate without persistence fields', () => {
  const result = project();
  assertProjected(result);
  assert.equal(result.candidateKind, BUSINESS_EVENT_CANDIDATE_KINDS.PURCHASE);
  assert.equal(result.businessEventType, 'PURCHASE');
  assert.equal(result.transferDirection, null);
  assert.equal('postings' in result, false);
  assert.equal('receiptId' in result, false);
  assert.equal('receiptItemId' in result, false);
  assert.equal('ledgerEntryId' in result, false);
  assert.equal('businessEventId' in result, false);
});

test('unresolved and concrete bank identities are preserved', () => {
  const unresolved = project();
  const concrete = project({ financialAccountId: 42, accountResolutionState: 'EXACT', accountResolutionProvenance: 'EXPLICIT_TEST', financialAccountScopeKey: 'scope-a' });
  assert.deepEqual(unresolved.bankSide, { type: 'SYMBOLIC', code: 'UNRESOLVED_BANK_ACCOUNT' });
  assert.deepEqual(concrete.bankSide, { type: 'FINANCIAL_ACCOUNT', financialAccountId: 42 });
  assert.notEqual(unresolved.journalKey, concrete.journalKey);
  assert.notEqual(unresolved.candidateKey, concrete.candidateKey);
  assert.equal(concrete.sourceProvenance.accountResolutionState, 'EXACT');
});

test('outgoing and incoming transfers become directional transfer candidates', () => {
  const outgoing = project({ sourceEventType: 'OUTGOING_TRANSFER' });
  const incoming = project({ sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT' });
  assert.equal(outgoing.candidateKind, BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER);
  assert.equal(outgoing.businessEventType, 'TRANSFER');
  assert.equal(outgoing.transferDirection, TRANSFER_DIRECTIONS.OUTGOING);
  assert.equal(incoming.candidateKind, BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER);
  assert.equal(incoming.transferDirection, TRANSFER_DIRECTIONS.INCOMING);
});

test('exact UNKNOWN monetary movement remains unclassified in both directions', () => {
  const debit = project({ sourceEventType: 'UNKNOWN' });
  const credit = project({ sourceEventType: 'UNKNOWN', direction: 'CREDIT' });
  for (const result of [debit, credit]) {
    assertProjected(result);
    assert.equal(result.candidateKind, BUSINESS_EVENT_CANDIDATE_KINDS.UNCLASSIFIED_MONETARY_MOVEMENT);
    assert.equal(result.businessEventType, null);
    assert.equal(result.transferDirection, null);
  }
});

test('no path emits INTERNAL_TRANSFER', () => {
  const results = projectBankBusinessEventCandidates([
    journal(),
    journal({ sourceEventType: 'OUTGOING_TRANSFER' }),
    journal({ sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT' }),
    journal({ sourceEventType: 'UNKNOWN' }),
  ]);
  assert.equal(results.projections.some((row) => JSON.stringify(row).includes('INTERNAL_TRANSFER')), false);
});

test('unresolved upstream journal fails closed', () => {
  const result = projectBankBusinessEventCandidate(projectBalancedBankJournal(
    projectBankCashFlowTransaction(bankRow({ normalizationStatus: 'PARTIAL' })),
  ));
  assert.equal(result.projectionStatus, 'UNRESOLVED');
  assert.equal(result.candidateKey, null);
  assert.equal(result.candidateKind, null);
  assert.equal(result.businessEventType, null);
});

test('journal contract rejects malformed version, key, and posting cardinality', () => {
  const valid = journal();
  for (const malformed of [
    { modelVersion: 'other-version' },
    { journalKey: 'bad' },
    { postings: [valid.postings[0]] },
    { postings: [{ ...valid.postings[0], side: 'DEBIT' }, { ...valid.postings[1], side: 'DEBIT' }] },
  ]) {
    const result = projectBankBusinessEventCandidate({ ...valid, ...malformed });
    assert.equal(result.reasonCode, 'JOURNAL_CONTRACT_INVALID');
    assert.equal(result.candidateKey, null);
  }
});

test('journal contract rejects amount/currency mismatches and wrong account orientation', () => {
  const valid = journal();
  const variants = [
    { postings: valid.postings.map((row, index) => index === 0 ? { ...row, amount: '101.00' } : row) },
    { postings: valid.postings.map((row, index) => index === 0 ? { ...row, currency: 'USD' } : row) },
    { postings: [{ ...valid.postings[0], account: valid.postings[1].account }, { ...valid.postings[1], account: valid.postings[0].account }] },
    { sourceEventType: 'PURCHASE', direction: 'CREDIT' },
    { sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT', postings: [{ ...valid.postings[0], account: valid.postings[1].account }, { ...valid.postings[1], account: valid.postings[0].account }] },
  ];
  for (const variant of variants) {
    const result = projectBankBusinessEventCandidate({ ...valid, ...variant });
    assert.equal(result.projectionStatus, 'UNRESOLVED');
    assert.equal(result.reasonCode === 'JOURNAL_CONTRACT_INVALID' || result.reasonCode === 'JOURNAL_SEMANTIC_MISMATCH', true);
  }
});

test('journal contract rejects provenance and semantic tampering', () => {
  const valid = journal();
  const tamperedProvenance = { ...valid, sourceProvenance: { ...valid.sourceProvenance, bankTransactionId: 999 } };
  const tamperedKey = { ...valid, sourceProvenance: { ...valid.sourceProvenance, projectionKey: 'f'.repeat(64) } };
  const unknownWithWrongReason = { ...journal({ sourceEventType: 'UNKNOWN' }), sourceProvenance: { ...journal({ sourceEventType: 'UNKNOWN' }).sourceProvenance, sourceReasonCode: 'OTHER' } };
  const knownWithWrongMovement = { ...valid, sourceProvenance: { ...valid.sourceProvenance, sourceMovementType: 'INCOMING_TRANSFER' } };
  assert.equal(projectBankBusinessEventCandidate(tamperedProvenance).reasonCode, 'JOURNAL_CONTRACT_INVALID');
  assert.equal(projectBankBusinessEventCandidate(tamperedKey).reasonCode, 'JOURNAL_CONTRACT_INVALID');
  assert.equal(projectBankBusinessEventCandidate(unknownWithWrongReason).reasonCode, 'JOURNAL_SEMANTIC_MISMATCH');
  assert.equal(projectBankBusinessEventCandidate(knownWithWrongMovement).reasonCode, 'JOURNAL_SEMANTIC_MISMATCH');
});

test('large exact decimal and source object remain unchanged', () => {
  const source = journal({ amount: '99999999999999.99' });
  const before = structuredClone(source);
  const result = projectBankBusinessEventCandidate(source);
  assertProjected(result);
  assert.equal(result.amount, '99999999999999.99');
  assert.deepEqual(source, before);
});

test('candidate output preserves full provenance chain and journal key deterministically', () => {
  const first = project();
  const second = project();
  assert.deepEqual(first, second);
  assert.equal(first.sourceProvenance.journalProjectionVersion, 'balanced-bank-journal-projection-v1');
  assert.equal(first.sourceProvenance.journalKey, first.journalKey);
  assert.equal(first.sourceProvenance.cashFlowProjectionVersion, 'bank-cash-flow-projection-v1');
  assert.equal(first.sourceProvenance.cashFlowProjectionKey, journal().sourceProvenance.projectionKey);
  assert.equal(first.sourceProvenance.bankTransactionId, first.bankTransactionId);
});

test('collection summary is deterministic and balanced', () => {
  const result = projectBankBusinessEventCandidates([
    journal(),
    journal({ bankTransactionId: 11, sourceEventType: 'UNKNOWN' }),
    projectBalancedBankJournal(projectBankCashFlowTransaction(bankRow({ bankTransactionId: 12, normalizationStatus: 'PARTIAL' }))),
  ]);
  assert.equal(result.summary.totalJournals, 3);
  assert.equal(result.summary.projectedCandidates, 2);
  assert.equal(result.summary.unresolvedCandidates, 1);
  assert.equal(result.summary.totalJournals, result.summary.projectedCandidates + result.summary.unresolvedCandidates);
});

test('loader delegates to the existing SELECT-only journal loader', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [bankRow()] };
  } };
  const result = await loadBankBusinessEventCandidateProjection(pool, { scopeKey: 'scope-a' });
  assert.equal(result.summary.projectedCandidates, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /SELECT/);
  assert.doesNotMatch(calls[0].sql, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBankInternalTransferOwnershipSnapshot } from '../src/bank-internal-transfer-matching.js';
import { projectBalancedBankJournal } from '../src/balanced-bank-journal-projection.js';
import { projectBankCashFlowTransaction } from '../src/bank-cash-flow-projection.js';
import { projectBankBusinessEventCandidate } from '../src/bank-business-event-candidate-projection.js';
import {
  BANK_RECEIPT_MATCHING_STATUSES,
  BANK_RECEIPT_MATCHING_VERSION,
  loadBankReceiptMatching,
  matchBankReceipts,
  projectBankReceiptCandidate,
} from '../src/bank-receipt-matching.js';

const owner = (financialAccountId, personId = 7, accountScopeKey = 'scope-a') => ({
  financialAccountId,
  accountScopeKey,
  personId,
  personScopeKey: accountScopeKey,
  relationType: 'OWNER',
  provenance: 'EXPLICIT_TEST',
});

const ownership = (rows = [owner(1)]) => buildBankInternalTransferOwnershipSnapshot(rows);

function bankEntry(overrides = {}) {
  const row = {
    bankTransactionId: 10,
    occurredAt: '2026-10-05T10:00:00.000Z',
    amount: '100.00',
    currency: 'RUB',
    sourceEventType: 'PURCHASE',
    direction: 'DEBIT',
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    sourceScopeKeys: ['scope-a'],
    accountResolutionState: 'EXACT',
    financialAccountId: 1,
    financialAccountScopeKey: 'scope-a',
    ...overrides,
  };
  const journal = projectBalancedBankJournal(projectBankCashFlowTransaction(row));
  return { journal, candidate: projectBankBusinessEventCandidate(journal) };
}

function receiptRow(overrides = {}) {
  return {
    receiptId: 20,
    dateTime: '2026-10-05T10:00:05.000Z',
    currency: 'RUB',
    normalizationVersion: 'fiscal-normalizer-v1',
    normalizedContentSha256: 'a'.repeat(64),
    normalizationStatus: 'READY',
    fiscalOperationType: 1,
    householdCashDirection: 'OUT',
    paymentComponentsStatus: 'RECONCILED',
    paymentStage: 'SETTLEMENT_ONLY',
    correctionStatus: 'UNKNOWN',
    itemPaymentTypeCodes: [4],
    ecashTotalSum: '100.00',
    ecashTotalState: 'PRESENT_VALUE',
    cashTotalSum: '0.00',
    cashTotalState: 'EXPLICIT_ZERO',
    prepaidSum: '0.00',
    prepaidState: 'EXPLICIT_ZERO',
    creditSum: '0.00',
    creditState: 'EXPLICIT_ZERO',
    provisionSum: '0.00',
    provisionState: 'EXPLICIT_ZERO',
    totalSum: '100.00',
    scopeKeys: ['scope-a'],
    ...overrides,
  };
}

function match(bank = bankEntry(), receipt = receiptRow(), bankOwnership = ownership(), options = {}) {
  return matchBankReceipts([bank], bankOwnership, [receipt], {
    internalTransferMaxTimeDeltaMs: 60_000,
    receiptMaxTimeDeltaMs: 60_000,
    ...options,
  });
}

test('exact PURCHASE and full electronic receipt produce one evidence match without postings', () => {
  const input = bankEntry();
  const before = structuredClone(input);
  const result = match(input);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].modelVersion, BANK_RECEIPT_MATCHING_VERSION);
  assert.equal(result.matches[0].matchStatus, BANK_RECEIPT_MATCHING_STATUSES.MATCHED);
  assert.equal(result.matches[0].relationshipType, 'RECEIPT_EVIDENCE_FOR_BANK_PURCHASE');
  assert.equal(result.matches[0].amount, '100.00');
  assert.equal(result.matches[0].receipt.amountBasis, 'ECASH_TOTAL_SUM');
  assert.equal(result.matches[0].bank.financialAccountId, 1);
  assert.equal(Object.hasOwn(result.matches[0], 'postings'), false);
  assert.equal(JSON.stringify(result).includes('ledgerEntryId'), false);
  assert.deepEqual(input, before);
});

test('concrete bank account requires explicit OWNER in the same scope', () => {
  assert.equal(match(bankEntry(), receiptRow(), ownership([])).bankStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  assert.equal(match(bankEntry(), receiptRow(), ownership([owner(1, 7, 'other-scope')])).bankStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  assert.equal(match(bankEntry(), receiptRow(), ownership([owner(1)])).matches.length, 1);
  assert.equal(match(bankEntry(), receiptRow(), ownership([owner(1), { ...owner(1), relationType: 'AUTHORIZED_USER' }])).matches.length, 1);
  assert.equal(match(bankEntry(), receiptRow(), ownership([{ ...owner(1), relationType: 'AUTHORIZED_USER' }])).bankStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
});

test('unresolved bank account and every non-purchase movement are ineligible', () => {
  for (const overrides of [
    { accountResolutionState: 'UNKNOWN', financialAccountId: null, financialAccountScopeKey: null },
    { sourceEventType: 'OUTGOING_TRANSFER', direction: 'DEBIT' },
    { sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT' },
    { sourceEventType: 'UNKNOWN', direction: 'DEBIT' },
  ]) {
    const result = match(bankEntry(overrides));
    assert.equal(result.matches.length, 0);
    assert.equal(result.bankStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  }
});

test('receipt candidate requires strict electronic settlement evidence', () => {
  const invalid = [
    { cashTotalSum: '10.00', cashTotalState: 'PRESENT_VALUE' },
    { paymentStage: 'PREPAYMENT_ONLY' },
    { paymentStage: 'ADVANCE_ONLY' },
    { creditSum: '1.00', creditState: 'PRESENT_VALUE' },
    { fiscalOperationType: 2 },
    { correctionStatus: 'CORRECTION' },
    { currency: null },
    { scopeKeys: [] },
    { itemPaymentTypeCodes: [1] },
    { totalSum: '101.00' },
    { ecashTotalSum: null, ecashTotalState: 'FIELD_MISSING' },
  ];
  for (const overrides of invalid) assert.equal(projectBankReceiptCandidate(receiptRow(overrides)).status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  assert.equal(projectBankReceiptCandidate(receiptRow()).status, BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED);
});

test('amount basis is exact ecash amount and total alone cannot match', () => {
  assert.equal(match(bankEntry(), receiptRow({ totalSum: '100.00', ecashTotalSum: '99.99' })).matches.length, 0);
  assert.equal(match(bankEntry({ amount: '99.99' }), receiptRow({ totalSum: '100.00', ecashTotalSum: '99.99' })).matches.length, 0);
  assert.equal(match(bankEntry({ amount: '99.99' }), receiptRow({ totalSum: '99.99', ecashTotalSum: '99.99' })).matches.length, 1);
});

test('exact currency and inclusive time boundary are required', () => {
  assert.equal(match(bankEntry(), receiptRow({ currency: 'USD' })).matches.length, 0);
  assert.equal(match(bankEntry(), receiptRow({ dateTime: '2026-10-05T10:01:00.000Z' }), ownership(), { receiptMaxTimeDeltaMs: 60_000 }).matches.length, 1);
  assert.equal(match(bankEntry(), receiptRow({ dateTime: '2026-10-05T10:01:00.001Z' }), ownership(), { receiptMaxTimeDeltaMs: 60_000 }).matches.length, 0);
  assert.equal(match(bankEntry(), receiptRow({ dateTime: '2026-10-05T09:59:30.000Z' }), ownership(), { receiptMaxTimeDeltaMs: 30_000 }).matches.length, 1);
});

test('same-scope observations remain one receipt, cross-scope observations fail closed', () => {
  const same = receiptRow({ scopeKeys: ['scope-a', 'scope-a'] });
  assert.equal(match(bankEntry(), same).matches.length, 1);
  assert.equal(match(bankEntry(), receiptRow({ scopeKeys: ['scope-a', 'scope-b'] })).receiptStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  assert.equal(match(bankEntry(), receiptRow({ scopeKeys: [] })).receiptStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
});

test('one-to-one matching fails closed for ambiguity and preserves independent pairs', () => {
  const firstBank = bankEntry({ bankTransactionId: 10 });
  const secondBank = bankEntry({ bankTransactionId: 11, amount: '101.00', occurredAt: '2026-10-05T10:00:10.000Z' });
  const firstReceipt = receiptRow({ receiptId: 20, dateTime: '2026-10-05T10:00:00.000Z' });
  const ambiguousReceipt = receiptRow({ receiptId: 22, dateTime: '2026-10-05T10:00:10.000Z', normalizedContentSha256: 'c'.repeat(64) });
  const secondReceipt = receiptRow({ receiptId: 21, dateTime: '2026-10-05T10:00:10.000Z', totalSum: '101.00', ecashTotalSum: '101.00', normalizedContentSha256: 'b'.repeat(64) });
  const ambiguous = matchBankReceipts([firstBank], ownership(), [firstReceipt, ambiguousReceipt], { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 });
  assert.equal(ambiguous.matches.length, 0);
  assert.equal(ambiguous.bankStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS);
  const two = matchBankReceipts([firstBank, secondBank], ownership(), [firstReceipt, secondReceipt], { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 2_000 });
  assert.equal(two.matches.length, 2);
  assert.equal(new Set(two.matches.map((row) => row.receipt.receiptId)).size, 2);
});

test('match keys and complete results are deterministic and input-order independent', () => {
  const a = bankEntry({ bankTransactionId: 10 });
  const b = bankEntry({ bankTransactionId: 11, amount: '101.00', occurredAt: '2026-10-05T11:00:00.000Z' });
  const first = matchBankReceipts([a, b], ownership(), [receiptRow(), receiptRow({ receiptId: 21, amount: undefined, totalSum: '101.00', ecashTotalSum: '101.00', dateTime: '2026-10-05T11:00:00.000Z', normalizedContentSha256: 'b'.repeat(64) })], { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 });
  const second = matchBankReceipts([b, a], ownership(), [receiptRow({ receiptId: 21, totalSum: '101.00', ecashTotalSum: '101.00', dateTime: '2026-10-05T11:00:00.000Z', normalizedContentSha256: 'b'.repeat(64) }), receiptRow()], { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 });
  assert.deepEqual(second, first);
  assert.notEqual(first.matches[0].matchKey, matchBankReceipts([a], ownership(), [receiptRow({ normalizedContentSha256: 'c'.repeat(64) })], { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 }).matches[0]?.matchKey);
});

test('duplicate receipt ids are rejected and output contains no raw evidence', () => {
  assert.throws(() => matchBankReceipts([bankEntry()], ownership(), [receiptRow(), receiptRow()], { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 }), /duplicate receiptId/);
  const result = match(bankEntry(), receiptRow());
  assert.equal(JSON.stringify(result).includes('seller'), false);
  assert.equal(JSON.stringify(result).includes('payload'), false);
});

test('loader reads bank, ownership, and receipt evidence once with SELECT-only SQL', async () => {
  const calls = [];
  const pool = {
    query: async (sql) => {
      calls.push(sql);
      if (/FROM bank_transactions bt/i.test(sql)) return { rows: [{
        bankTransactionId: 10,
        occurredAt: '2026-10-05T10:00:00.000Z',
        amount: '100.00',
        currency: 'RUB',
        sourceEventType: 'PURCHASE',
        direction: 'DEBIT',
        normalizationStatus: 'READY',
        evidenceQuality: 'EXACT',
        sourceScopeKeys: ['scope-a'],
        accountResolutionState: 'EXACT',
        financialAccountId: 1,
        financialAccountScopeKey: 'scope-a',
      }] };
      if (/FROM financial_accounts a/i.test(sql)) return { rows: [owner(1)] };
      if (/FROM receipts r/i.test(sql)) return { rows: [receiptRow()] };
      throw new Error('unexpected query');
    },
  };
  const result = await loadBankReceiptMatching(pool, { scopeKey: 'scope-a', internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 });
  assert.equal(result.matches.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls.every((sql) => !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)), true);
  assert.equal(calls.some((sql) => /fns_source_person/i.test(sql)), false);
});

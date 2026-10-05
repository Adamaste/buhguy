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
    receiptItemCount: 1,
    normalizedItemFactCount: 1,
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

test('zero-edge eligible bank and receipt are both UNMATCHED', () => {
  for (const receipt of [
    receiptRow({ ecashTotalSum: '101.00', totalSum: '101.00' }),
    receiptRow({ currency: 'USD' }),
    receiptRow({ dateTime: '2026-10-05T10:02:00.000Z' }),
  ]) {
    const result = match(bankEntry(), receipt);
    assert.equal(result.matches.length, 0);
    assert.equal(result.bankStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED);
    assert.equal(result.receiptStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED);
  }
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

  const twoBanksOneReceipt = matchBankReceipts(
    [firstBank, bankEntry({ bankTransactionId: 12, occurredAt: '2026-10-05T10:00:10.000Z' })],
    ownership(),
    [firstReceipt],
    { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 },
  );
  assert.equal(twoBanksOneReceipt.bankStatuses.every((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS), true);
  assert.equal(twoBanksOneReceipt.receiptStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS);
});

test('receipt statuses preserve ids and matcher-owned reasons at every status', () => {
  const matched = match(bankEntry(), receiptRow());
  assert.deepEqual(matched.receiptStatuses[0], {
    receiptId: 20,
    receiptCandidateKey: matched.receiptStatuses[0].receiptCandidateKey,
    status: BANK_RECEIPT_MATCHING_STATUSES.MATCHED,
    reasonCode: 'PROVEN_EXACT_ECASH_RECEIPT_BANK_PURCHASE_MATCH',
  });
  const unmatched = match(bankEntry(), receiptRow({ ecashTotalSum: '101.00', totalSum: '101.00' }));
  assert.equal(unmatched.receiptStatuses[0].receiptId, 20);
  assert.equal(unmatched.receiptStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED);
  assert.equal(unmatched.receiptStatuses[0].reasonCode, 'NO_COMPATIBLE_BANK_PURCHASE');
  const ambiguous = matchBankReceipts(
    [bankEntry()],
    ownership(),
    [receiptRow(), receiptRow({ receiptId: 21, normalizedContentSha256: 'b'.repeat(64) })],
    { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 },
  );
  assert.deepEqual(ambiguous.receiptStatuses.map((row) => row.receiptId).sort((a, b) => a - b), [20, 21]);
  assert.equal(ambiguous.receiptStatuses.every((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS), true);
  assert.equal(ambiguous.receiptStatuses.every((row) => row.reasonCode === 'AMBIGUOUS_COMPATIBLE_BANK_PURCHASES'), true);
  const ineligible = match(bankEntry(), receiptRow({ scopeKeys: ['scope-a', 'scope-b'] }));
  assert.equal(ineligible.receiptStatuses[0].receiptId, 20);
  assert.equal(ineligible.receiptStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  assert.equal(ineligible.receiptStatuses[0].reasonCode, 'RECEIPT_EVIDENCE_INELIGIBLE');
});

test('bank statuses are ledger-entry level and summary partitions are exact', () => {
  const result = matchBankReceipts(
    [bankEntry(), bankEntry({ bankTransactionId: 11, amount: '101.00' }), bankEntry({ bankTransactionId: 12, sourceEventType: 'OUTGOING_TRANSFER', direction: 'DEBIT' })],
    ownership(),
    [receiptRow(), receiptRow({ receiptId: 21, ecashTotalSum: '999.00', totalSum: '999.00' })],
    { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 },
  );
  assert.equal(result.bankStatuses.length, result.summary.totalBankLedgerEntries);
  assert.equal(result.bankStatuses.find((row) => row.economicKind === 'OUTGOING_TRANSFER').reasonCode, 'BANK_NOT_PURCHASE');
  assert.equal(result.bankStatuses.find((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.MATCHED).reasonCode, 'PROVEN_EXACT_ECASH_RECEIPT_BANK_PURCHASE_MATCH');
  assert.equal(result.bankStatuses.find((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED).reasonCode, 'NO_COMPATIBLE_RECEIPT');
  assert.equal(result.summary.totalBankLedgerEntries, result.summary.eligibleBankPurchases + result.summary.ineligibleBankEntries);
  assert.equal(result.summary.eligibleBankPurchases, result.summary.matchedBankPurchases + result.summary.unmatchedBankPurchases + result.summary.ambiguousBankPurchases);
  assert.equal(result.summary.matchedBankPurchases, result.summary.matchedPairs);
  const internal = matchBankReceipts(
    [
      bankEntry({ bankTransactionId: 30, sourceEventType: 'OUTGOING_TRANSFER', direction: 'DEBIT', financialAccountId: 1 }),
      bankEntry({ bankTransactionId: 31, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT', financialAccountId: 2, occurredAt: '2026-10-05T10:00:05.000Z' }),
    ],
    ownership([owner(1), owner(2)]),
    [],
    { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 },
  );
  assert.equal(internal.summary.totalBankLedgerEntries, 1);
  assert.equal(internal.bankStatuses.length, 1);
  assert.equal(internal.bankStatuses[0].reasonCode, 'BANK_NOT_PURCHASE');
  assert.equal(internal.summary.ineligibleBankEntries, 1);
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

test('malformed receipt identities are ineligible uncertainty, while real duplicate ids throw', () => {
  const malformed = [receiptRow({ receiptId: undefined, id: undefined }), receiptRow({ receiptId: undefined, id: undefined, normalizedContentSha256: 'b'.repeat(64) })];
  assert.doesNotThrow(() => matchBankReceipts([bankEntry()], ownership(), malformed, { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 }));
  const result = matchBankReceipts([bankEntry()], ownership(), malformed, { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 });
  assert.equal(result.receiptStatuses.every((row) => row.receiptId === null && row.status === BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE), true);
  assert.throws(() => matchBankReceipts([bankEntry()], ownership(), [receiptRow({ receiptId: 20 }), receiptRow({ receiptId: 20, normalizedContentSha256: 'b'.repeat(64) })], { internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 }), /duplicate receiptId/);
});

test('current fiscal v1 requires exact UNKNOWN non-correction state', () => {
  assert.equal(projectBankReceiptCandidate(receiptRow({ correctionStatus: 'UNKNOWN' })).status, BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED);
  for (const correctionStatus of ['CORRECTION', null, 'UNSUPPORTED']) {
    assert.equal(projectBankReceiptCandidate(receiptRow({ correctionStatus })).status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  }
});

test('all receipt items require normalized payment facts with type 4', () => {
  assert.equal(projectBankReceiptCandidate(receiptRow({ receiptItemCount: 2, normalizedItemFactCount: 2, itemPaymentTypeCodes: [4, 4] })).status, BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED);
  assert.equal(projectBankReceiptCandidate(receiptRow({ receiptItemCount: 2, normalizedItemFactCount: 1, itemPaymentTypeCodes: [4] })).status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  assert.equal(projectBankReceiptCandidate(receiptRow({ receiptItemCount: 2, normalizedItemFactCount: 2, itemPaymentTypeCodes: [4, 5] })).status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
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

test('loader preserves cross-scope receipt evidence before requested-scope selection', async () => {
  const pool = {
    query: async (sql) => {
      if (/FROM bank_transactions bt/i.test(sql)) return { rows: [bankEntry().candidate] };
      if (/FROM financial_accounts a/i.test(sql)) return { rows: [owner(1)] };
      if (/FROM receipts r/i.test(sql)) return { rows: [receiptRow({ scopeKeys: ['scope-a', 'scope-b'] })] };
      throw new Error('unexpected query');
    },
  };
  const result = await loadBankReceiptMatching(pool, { scopeKey: 'scope-a', internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 });
  assert.equal(result.matches.length, 0);
  assert.equal(result.receiptStatuses[0].status, BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE);
  assert.equal(result.summary.ineligibleReceipts, 1);
});

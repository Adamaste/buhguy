import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findPreliminaryBankReceiptCandidates,
  PRELIMINARY_BANK_RECEIPT_WINDOW_MS,
} from '../src/bank-receipt-provisional-candidates.js';

const at = '2026-10-10T10:00:00.000Z';
function bank(id, overrides = {}) {
  return {
    bankTransactionId: String(id), occurredAt: at, amount: '100.00', currency: 'RUB',
    eventType: 'PURCHASE', direction: 'DEBIT', normalizationStatus: 'READY', evidenceQuality: 'EXACT',
    accountResolutionState: 'EXACT', sourceProviderBindingVerified: true, ownerProven: true,
    scopeKey: 'default', merchant: 'Bank Shop', projectionStatus: 'PROJECTED',
    ...overrides,
  };
}
function receipt(id, overrides = {}) {
  return {
    receiptId: String(id), dateTime: at, amount: '100.00', currency: 'RUB', merchant: 'FNS Shop',
    operationType: 1, normalizationStatus: 'READY', paymentStage: 'SETTLEMENT_ONLY',
    paymentComponentsStatus: 'RECONCILED', householdCashDirection: 'OUT', fnsSourceProven: true,
    scopeKeys: ['default'], ...overrides,
  };
}

test('preliminary matching uses exact amount and five-minute window only', () => {
  const result = findPreliminaryBankReceiptCandidates({
    bankRows: [bank(1, { currency: null, accountResolutionState: 'UNKNOWN', sourceProviderBindingVerified: false, ownerProven: false, scopeKey: null })],
    receiptRows: [receipt(2, { currency: null, operationType: 3, paymentStage: 'ADVANCE_ONLY', scopeKeys: [] })],
    cohortStartAt: '2026-10-11T00:00:00Z',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].candidateStatus, 'UNIQUE_AMOUNT_TIME_CANDIDATE');
  assert.equal(result[0].ledgerWritesAllowed, false);
  assert.ok(result[0].bookkeepingReasonCodes.includes('BANK_ACCOUNT_UNRESOLVED'));
  assert.ok(result[0].bookkeepingReasonCodes.includes('FNS_PAYMENT_STAGE_NOT_SETTLED_PURCHASE'));
  assert.ok(result[0].bookkeepingReasonCodes.includes('AUTO_BANK_EVENT_OUTSIDE_COHORT'));
  assert.equal(result[0].bank.currency, null);
  assert.equal(result[0].receipt.currency, null);
});

test('merchant differences are information only and exact numeric decimal values match', () => {
  const result = findPreliminaryBankReceiptCandidates({
    bankRows: [bank(1, { amount: '1e2', merchant: 'Different bank label' })],
    receiptRows: [receipt(2, { amount: '100.000', merchant: 'Different receipt seller' })],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].amount, '100');
  assert.equal(result[0].bank.merchant, 'Different bank label');
  assert.equal(result[0].receipt.merchant, 'Different receipt seller');
});

test('the five-minute boundary is inclusive and candidates beyond it are excluded', () => {
  const boundary = new Date(Date.parse(at) + PRELIMINARY_BANK_RECEIPT_WINDOW_MS).toISOString();
  const outside = new Date(Date.parse(at) + PRELIMINARY_BANK_RECEIPT_WINDOW_MS + 1).toISOString();
  const result = findPreliminaryBankReceiptCandidates({
    bankRows: [bank(1, { occurredAt: boundary }), bank(2, { occurredAt: outside })],
    receiptRows: [receipt(3)],
  });
  assert.deepEqual(result.map((row) => row.bankTransactionId), ['1']);
  assert.equal(result[0].timeDeltaMs, PRELIMINARY_BANK_RECEIPT_WINDOW_MS);
});

test('two purchases with equal amount inside the window remain ambiguous, never auto-selected', () => {
  const result = findPreliminaryBankReceiptCandidates({
    bankRows: [bank(1), bank(2, { occurredAt: '2026-10-10T10:00:01.000Z' })],
    receiptRows: [receipt(3), receipt(4, { dateTime: '2026-10-10T10:00:02.000Z' })],
    strictDecisions: [{ bankTransactionId: '1', receiptId: '3', orchestrationAction: 'PERSIST_REQUIRED' }],
  });
  assert.equal(result.length, 4);
  assert.ok(result.every((row) => row.candidateStatus === 'AMBIGUOUS'));
  const previewedPair = result.find((row) => row.bankTransactionId === '1' && row.receiptId === '3');
  assert.equal(previewedPair.automaticAccountingAction, 'PERSIST_REQUIRED');
  assert.equal(previewedPair.passesAutomaticAccountingPolicy, false);
  assert.ok(result.filter((row) => row !== previewedPair).every((row) => row.automaticAccountingAction === 'NOT_EVALUATED'));
  assert.ok(result.every((row) => row.ledgerWritesAllowed === false));
});

test('two bank records with the same amount and time stay ambiguous against one receipt', () => {
  const result = findPreliminaryBankReceiptCandidates({
    bankRows: [bank(1), bank(2, { occurredAt: '2026-10-10T10:00:02.000Z' })],
    receiptRows: [receipt(3)],
    strictDecisions: [
      { bankTransactionId: '1', receiptId: '3', orchestrationAction: 'PERSIST_REQUIRED' },
      { bankTransactionId: '2', receiptId: '3', orchestrationAction: 'PERSIST_REQUIRED' },
    ],
  });
  assert.equal(result.length, 2);
  assert.ok(result.every((row) => row.candidateStatus === 'AMBIGUOUS'));
  assert.ok(result.every((row) => row.bookkeepingReasonCodes.includes('AMBIGUOUS_AMOUNT_TIME_CANDIDATES')));
  assert.ok(result.every((row) => row.passesAutomaticAccountingPolicy === false));
  assert.ok(result.every((row) => row.ledgerWritesAllowed === false));
});

test('saved match is shown without creating a second association', () => {
  const result = findPreliminaryBankReceiptCandidates({
    bankRows: [bank(1)], receiptRows: [receipt(2)],
    persistedMatches: [{ bankTransactionId: '1', receiptId: '2', reasonCode: 'PROVEN_EXACT_ECASH_RECEIPT_BANK_PURCHASE_MATCH' }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].linkStatus, 'SAVED_EXACT');
  assert.equal(result[0].ledgerWritesAllowed, false);
});

test('known transfer or refund shape is displayed as a candidate with a blocker, not as a purchase', () => {
  const result = findPreliminaryBankReceiptCandidates({
    bankRows: [bank(1, { eventType: 'TRANSFER' })],
    receiptRows: [receipt(2, { fiscalOperationType: 3 })],
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].bookkeepingReasonCodes.includes('BANK_NOT_PURCHASE'));
  assert.ok(result[0].bookkeepingReasonCodes.includes('FNS_OPERATION_NOT_PURCHASE'));
  assert.equal(result[0].bank.eventType, 'TRANSFER');
  assert.equal(result[0].ledgerWritesAllowed, false);
});

test('candidate analysis does not mutate source rows or expose raw event content', () => {
  const sourceBank = bank(1, { payload: 'not part of report' });
  const sourceReceipt = receipt(2, { raw: 'not part of report' });
  const beforeBank = structuredClone(sourceBank);
  const beforeReceipt = structuredClone(sourceReceipt);
  const [row] = findPreliminaryBankReceiptCandidates({ bankRows: [sourceBank], receiptRows: [sourceReceipt] });
  assert.deepEqual(sourceBank, beforeBank);
  assert.deepEqual(sourceReceipt, beforeReceipt);
  assert.equal(JSON.stringify(row).includes('payload'), false);
  assert.equal(JSON.stringify(row).includes('raw'), false);
});

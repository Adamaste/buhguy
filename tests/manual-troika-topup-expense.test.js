import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmTroikaTopupExpense, attachTroikaTopupReceipt, confirmTroikaTopupExpenseAgainstExistingStandalone } from '../src/manual-troika-topup-expense.js';

const unavailablePool = { connect() { throw new Error('validation must finish before opening a database connection'); } };

test('manual Troika expense requires an explicit amount, account, card, owner, and user-confirmed basis', async () => {
  const base = {
    bankTransactionId: 9001,
    financialAccountId: 2,
    paymentInstrumentId: 2,
    personId: 1,
    scopeKey: 'default',
    amount: '21.00',
    evidenceBasis: 'BANK_DOCUMENT_AND_USER_CONFIRMATION',
    reason: 'Synthetic user-confirmed Troika top-up',
  };
  await assert.rejects(() => confirmTroikaTopupExpense(unavailablePool, { ...base, amount: '21' }), (error) => error.code === 'AMOUNT_INVALID');
  await assert.rejects(() => confirmTroikaTopupExpense(unavailablePool, { ...base, paymentInstrumentId: 0 }), (error) => error.code === 'PAYMENT_INSTRUMENT_ID_INVALID');
  await assert.rejects(() => confirmTroikaTopupExpense(unavailablePool, { ...base, evidenceBasis: 'OBSERVED_EXACT' }), (error) => error.code === 'EVIDENCE_BASIS_INVALID');
  await assert.rejects(() => attachTroikaTopupReceipt(unavailablePool, { bankTransactionId: 9001, receiptId: 0, reason: 'Synthetic user confirmation' }), (error) => error.code === 'RECEIPT_ID_INVALID');
  await assert.rejects(() => attachTroikaTopupReceipt(unavailablePool, {
    bankTransactionId: 9001, receiptId: 9002, reason: 'Synthetic user confirmation',
  }), (error) => error.code === 'TOPUP_RECEIPT_USER_CONFIRMATION_REQUIRED');
  await assert.rejects(() => confirmTroikaTopupExpenseAgainstExistingStandalone(unavailablePool, {
    bankTransactionId: 9001, receiptId: 9002, businessEventId: 9003, standaloneLedgerEntryId: 9004,
    financialAccountId: 2, paymentInstrumentId: 2, personId: 1, scopeKey: 'default', amount: '34.00',
    evidenceBasis: 'USER_CONFIRMATION', reason: 'Synthetic explicit receipt-to-top-up confirmation',
    userConfirmedReceiptForTopup: false,
  }), (error) => error.code === 'TOPUP_RECEIPT_USER_CONFIRMATION_REQUIRED');
});

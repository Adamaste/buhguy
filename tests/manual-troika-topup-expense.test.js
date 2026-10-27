import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED,
  attachTroikaTopupReceipt,
  confirmTroikaTopupExpense,
  confirmTroikaTopupExpenseAgainstExistingStandalone,
} from '../src/manual-troika-topup-expense.js';

test('legacy Troika write API is disabled before opening a database connection', async () => {
  const pool = { connect() { throw new Error('disabled API must not access the database'); } };
  for (const invoke of [
    () => confirmTroikaTopupExpense(pool, {}),
    () => confirmTroikaTopupExpenseAgainstExistingStandalone(pool, {}),
    () => attachTroikaTopupReceipt(pool, {}),
  ]) {
    await assert.rejects(invoke, (error) => error.code === SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED);
  }
});

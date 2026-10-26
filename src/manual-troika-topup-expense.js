// Kept as a stable API boundary for old callers. New Troika top-ups use the
// ordinary bank-only purchase writer; historic rows remain read-only inputs
// to ledger/certification/analytics compatibility checks.
export const MANUAL_TROIKA_TOPUP_RULE = 'MANUAL_TROIKA_TOPUP_EXPENSE_V1';
export const MANUAL_TROIKA_TOPUP_VERSION = 'v1';
export const ALFA_PROVIDER = 'ru.alfabank.mobile.android';
export const ALFA_DEBIT_CARD_REFERENCE = '****5580';
export const TROIKA_EXPENSE_CATEGORY = 'PUBLIC_TRANSPORT';
export const SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED = 'SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED';

function disabled() {
  const error = new Error(SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED);
  error.code = SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED;
  throw error;
}

export async function confirmTroikaTopupExpense() { return disabled(); }
export async function confirmTroikaTopupExpenseAgainstExistingStandalone() { return disabled(); }
export async function attachTroikaTopupReceipt() { return disabled(); }

import { persistPrepaymentSettlementMatches } from './prepayment-settlement-matcher.js';
import { persistReturnRefundMatches } from './return-refund-matcher.js';
import { persistStandalonePurchases } from './standalone-purchase.js';
import { rebuildLedger } from './ledger.js';
import { rebuildCertification } from './certification.js';
import { readBankOnlyPurchaseLedgerOptIn, runBankOnlyPurchaseCatchup } from './bank-only-purchase.js';

// Downstream accounting is scope-wide because receipts from multiple FNS
// sources can participate in one household business graph.
export async function runAccountingCatchup(pool, {
  scopeKey = 'default',
  logger = console,
  prepaymentMatcher = persistPrepaymentSettlementMatches,
  standaloneMatcher = persistStandalonePurchases,
  returnMatcher = persistReturnRefundMatches,
  ledgerBuilder = rebuildLedger,
  certificationBuilder = rebuildCertification,
  bankOnlyPurchaseRunner = runBankOnlyPurchaseCatchup,
  bankOnlyPurchaseOptIn = readBankOnlyPurchaseLedgerOptIn(),
  now = new Date(),
} = {}) {
  const prepayments = await prepaymentMatcher(pool, { scopeKey });
  const standalone = await standaloneMatcher(pool, { scopeKey });
  const returns = await returnMatcher(pool, { scopeKey });
  const bankOnlyPurchases = await bankOnlyPurchaseRunner(pool, { scopeKey, optIn: bankOnlyPurchaseOptIn, now, logger });
  const ledger = await ledgerBuilder(pool, { scopeKey });
  // Reuse an exact READY snapshot, but replace the current snapshot when the
  // source state changes so routine catch-up cannot accumulate old full runs.
  const certification = await certificationBuilder(pool, { scopeKey, persist: true, replace: true, reuseUnchanged: true });
  const result = { prepayments, standalone, returns, bankOnlyPurchases, ledger, certification };
  logger.info?.('accounting_catchup_completed', {
    scopeKey,
    prepaymentPurchases: prepayments?.created?.purchases ?? 0,
    standalonePurchases: standalone?.created ?? 0,
    returnEvents: returns?.created?.returns ?? 0,
    bankOnlyPurchaseStatus: bankOnlyPurchases?.status ?? 'UNKNOWN',
    bankOnlyPurchaseExamined: bankOnlyPurchases?.examined ?? 0,
    bankOnlyPurchaseWrites: bankOnlyPurchases?.persisted ?? 0,
    bankOnlyPurchaseReused: bankOnlyPurchases?.reused ?? 0,
    bankOnlyPurchaseBlocked: bankOnlyPurchases?.blocked ?? 0,
    bankOnlyPurchaseErrors: bankOnlyPurchases?.errors ?? 0,
    bankOnlyPurchaseReasonCode: bankOnlyPurchases?.reasonCode ?? null,
    ledgerEntries: ledger?.created?.entries ?? 0,
    certificationFacts: certification?.facts?.length ?? 0,
  });
  return result;
}

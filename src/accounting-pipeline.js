import { persistPrepaymentSettlementMatches } from './prepayment-settlement-matcher.js';
import { persistReturnRefundMatches } from './return-refund-matcher.js';
import { persistStandalonePurchases } from './standalone-purchase.js';
import { rebuildLedger } from './ledger.js';
import { rebuildCertification } from './certification.js';

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
} = {}) {
  const prepayments = await prepaymentMatcher(pool, { scopeKey });
  const standalone = await standaloneMatcher(pool, { scopeKey });
  const returns = await returnMatcher(pool, { scopeKey });
  const ledger = await ledgerBuilder(pool, { scopeKey });
  // Reuse an exact READY snapshot, but replace the current snapshot when the
  // source state changes so routine catch-up cannot accumulate old full runs.
  const certification = await certificationBuilder(pool, { scopeKey, persist: true, replace: true, reuseUnchanged: true });
  const result = { prepayments, standalone, returns, ledger, certification };
  logger.info?.('accounting_catchup_completed', {
    scopeKey,
    prepaymentPurchases: prepayments?.created?.purchases ?? 0,
    standalonePurchases: standalone?.created ?? 0,
    returnEvents: returns?.created?.returns ?? 0,
    ledgerEntries: ledger?.created?.entries ?? 0,
    certificationFacts: certification?.facts?.length ?? 0,
  });
  return result;
}

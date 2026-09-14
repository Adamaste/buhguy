export const COVERAGE_VERSION = 'business-resolution-coverage-v1';
export const TOP_LEVEL_STATES = ['CONFIRMED', 'AMBIGUOUS', 'CANDIDATE_ONLY', 'UNRESOLVED', 'UNKNOWN_PATTERN', 'BLOCKED'];

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function paymentTypeSignature(items = []) {
  return `[${[...new Set(items.map((item) => Number(item.paymentTypeCode)).filter(Number.isInteger))].sort((a, b) => a - b).join(',')}]`;
}

export function paymentComponentSignature(fact) {
  const parts = [];
  if (numeric(fact.cashTotalSum) > 0 || numeric(fact.ecashTotalSum) > 0) parts.push('NEW_MONEY');
  if (numeric(fact.prepaidSum) > 0) parts.push('PREPAID');
  if (numeric(fact.creditSum) > 0) parts.push('CREDIT');
  if (numeric(fact.provisionSum) > 0) parts.push('PROVISION');
  return parts.length ? parts.join('_PLUS_') : 'ZERO_COMPONENTS';
}

export function componentTotals(fact) {
  const cash = numeric(fact.cashTotalSum);
  const ecash = numeric(fact.ecashTotalSum);
  const prepaid = numeric(fact.prepaidSum);
  const credit = numeric(fact.creditSum);
  const provision = numeric(fact.provisionSum);
  return {
    fiscalFaceValue: numeric(fact.totalSum),
    newMoney: cash === null || ecash === null ? null : cash + ecash,
    prepaidUsed: prepaid,
    creditUsed: credit,
    provisionUsed: provision,
    componentSum: [cash, ecash, prepaid, credit, provision].every((value) => value !== null) ? cash + ecash + prepaid + credit + provision : null,
  };
}

export function classifyCoverage(receipt, context = {}) {
  const fact = receipt.fact ?? {};
  if (fact.normalizationStatus !== 'READY') return { state: 'BLOCKED', scenarioClass: 'BLOCKED_NORMALIZATION' };
  if (context.graphConfirmed) return { state: 'CONFIRMED', scenarioClass: context.confirmedScenario ?? 'PREPAYMENT_SETTLEMENT_CONFIRMED' };
  if (context.matcherState === 'AMBIGUOUS') return { state: 'AMBIGUOUS', scenarioClass: context.scenarioClass ?? 'PREPAYMENT_AMBIGUOUS' };
  if (context.matcherState === 'CANDIDATE') return { state: 'CANDIDATE_ONLY', scenarioClass: context.scenarioClass ?? 'PREPAYMENT_CANDIDATE' };
  if (context.returnState === 'AMBIGUOUS') return { state: 'AMBIGUOUS', scenarioClass: 'RETURN_AMBIGUOUS' };
  if (context.returnState === 'EXACT_UNIQUE') return { state: 'CANDIDATE_ONLY', scenarioClass: 'RETURN_EXACT_CANDIDATE' };
  if (context.returnState === 'PARTIAL') return { state: 'CANDIDATE_ONLY', scenarioClass: 'RETURN_PARTIAL_ITEM_CANDIDATE' };
  if (context.returnState === 'UNMATCHED') return { state: 'UNRESOLVED', scenarioClass: 'RETURN_UNMATCHED' };
  if (fact.paymentStage === 'ADVANCE_ONLY') return { state: 'UNRESOLVED', scenarioClass: 'ADVANCE_UNRESOLVED' };
  if (fact.paymentStage === 'PREPAYMENT_ONLY') return { state: 'UNRESOLVED', scenarioClass: 'PREPAYMENT_WITHOUT_SETTLEMENT' };
  if (fact.paymentStage === 'SETTLEMENT_ONLY') return { state: 'UNRESOLVED', scenarioClass: 'STANDALONE_FULL_SETTLEMENT' };
  if (fact.paymentStage === 'MIXED') return { state: 'UNRESOLVED', scenarioClass: 'MIXED_PAYMENT_TYPE' };
  if (fact.paymentStage === 'CREDIT_ONLY') return { state: 'UNRESOLVED', scenarioClass: 'CREDIT' };
  if (Number(receipt.operationType) === 3) return { state: 'UNRESOLVED', scenarioClass: 'OPERATION_TYPE_3' };
  if (Number(receipt.operationType) === 4) return { state: 'UNRESOLVED', scenarioClass: 'OPERATION_TYPE_4' };
  return { state: 'UNKNOWN_PATTERN', scenarioClass: context.unknownSignature ?? 'UNKNOWN_NORMALIZED_SIGNATURE' };
}

export function aggregateCoverage(rows) {
  const output = Object.fromEntries(TOP_LEVEL_STATES.map((state) => [state, { receipts: 0, fiscalFaceValue: 0, newMoney: 0, prepaidUsed: 0, creditUsed: 0, provisionUsed: 0, unknownDimensions: 0 }]));
  for (const row of rows) {
    const bucket = output[row.state];
    const totals = componentTotals({ ...row.fact, totalSum: row.totalSum });
    bucket.receipts += 1;
    for (const [key, value] of [['fiscalFaceValue', totals.fiscalFaceValue], ['newMoney', totals.newMoney], ['prepaidUsed', totals.prepaidUsed], ['creditUsed', totals.creditUsed], ['provisionUsed', totals.provisionUsed]]) {
      if (value === null) bucket.unknownDimensions += 1;
      else bucket[key] += value;
    }
  }
  return output;
}

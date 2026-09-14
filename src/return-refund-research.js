export const RETURN_RESEARCH_VERSION = 'return-refund-model-identification-v1';

const money = (value) => Number(value ?? 0);
const normalizedItems = (items = []) => items.map((item) => ({
  name: item.name ?? null,
  quantity: item.quantity ?? null,
  price: item.price ?? null,
  itemSum: item.itemSum ?? null,
  providerInn: item.providerInn ?? null,
  gtin: item.gtin ?? null,
  rawProductCode: item.rawProductCode ?? null,
}));

export function itemFingerprint(items = []) {
  return JSON.stringify(normalizedItems(items));
}

export function sameItemFingerprint(left, right) {
  return itemFingerprint(left) === itemFingerprint(right);
}

export function itemOverlap(returnItems = [], saleItems = []) {
  const saleNames = new Set(saleItems.map((item) => String(item.name ?? '').trim()).filter(Boolean));
  return returnItems.filter((item) => saleNames.has(String(item.name ?? '').trim())).length;
}

export function itemSubsetCompatible(returnItems = [], saleItems = []) {
  return returnItems.every((returned) => {
    const matches = saleItems.filter((sale) => String(sale.name ?? '').trim() === String(returned.name ?? '').trim());
    if (!matches.length) return false;
    return matches.some((sale) => Number(returned.quantity ?? 0) <= Number(sale.quantity ?? 0) + 0.000001
      && Number(returned.itemSum ?? 0) <= Number(sale.itemSum ?? 0) + 0.005);
  });
}

export function candidatePredicates(returnReceipt, saleReceipt, options = {}) {
  const returnTime = new Date(returnReceipt.dateTime).getTime();
  const saleTime = new Date(saleReceipt.dateTime).getTime();
  const chronology = Number.isFinite(returnTime) && Number.isFinite(saleTime) && saleTime < returnTime;
  const sameSeller = returnReceipt.sellerInn !== null && returnReceipt.sellerInn !== undefined && returnReceipt.sellerInn === saleReceipt.sellerInn;
  const amountEquality = Math.abs(money(returnReceipt.totalSum) - money(saleReceipt.totalSum)) < 0.005;
  const exactItems = sameItemFingerprint(returnReceipt.items, saleReceipt.items);
  const overlapCount = itemOverlap(returnReceipt.items, saleReceipt.items);
  const subsetCompatible = itemSubsetCompatible(returnReceipt.items, saleReceipt.items);
  const priorReturns = options.priorReturnsBySaleId?.get(String(saleReceipt.id)) ?? 0;
  const priorReturnedAmount = options.priorReturnedAmountBySaleId?.get(String(saleReceipt.id)) ?? 0;
  const noOverReturn = priorReturnedAmount + money(returnReceipt.totalSum) <= money(saleReceipt.totalSum) + 0.005;
  return {
    operationTypeCompatible: Number(returnReceipt.operationType) === 2 && Number(saleReceipt.operationType) === 1,
    sellerIdentity: sameSeller,
    amountEquality,
    chronology,
    exactItemFingerprint: exactItems,
    itemOverlap: overlapCount > 0,
    itemSubsetCompatible: subsetCompatible,
    overlapCount,
    priorReturnCount: priorReturns,
    priorReturnedAmount,
    noOverReturn,
    noExistingReturnAllocation: !(options.allocatedSaleIds?.has(String(saleReceipt.id))),
    paymentTypeCompatible: options.paymentTypeCompatible ?? null,
    paymentComponentsCompatible: options.paymentComponentsCompatible ?? null,
    fiscalIdentityEvidence: options.fiscalIdentityEvidence ?? null,
  };
}

export function classifyReturnResearch(returnReceipt, sales, options = {}) {
  const priorSales = sales.filter((sale) => new Date(sale.dateTime).getTime() < new Date(returnReceipt.dateTime).getTime());
  const evaluated = priorSales.map((sale) => ({ sale, predicates: candidatePredicates(returnReceipt, sale, options) }));
  const sameSellerAmount = evaluated.filter(({ predicates }) => predicates.sellerIdentity && predicates.amountEquality && predicates.chronology);
  const exact = sameSellerAmount.filter(({ predicates }) => predicates.exactItemFingerprint);
  const partial = evaluated.filter(({ predicates }) => predicates.sellerIdentity && predicates.chronology && predicates.itemSubsetCompatible && predicates.itemOverlap && !predicates.exactItemFingerprint);
  const amountAnySeller = evaluated.filter(({ predicates }) => predicates.amountEquality && predicates.chronology);
  const itemAnySeller = evaluated.filter(({ predicates }) => predicates.itemOverlap && predicates.chronology);
  const strictSafety = exact.length === 1 && exact[0].predicates.noExistingReturnAllocation && exact[0].predicates.priorReturnCount === 0 && exact[0].predicates.noOverReturn;

  let classification;
  let reason;
  if (exact.length === 1) {
    classification = strictSafety ? 'EXACT_UNIQUE_SAFE' : 'EXACT_UNIQUE_BLOCKED';
    reason = strictSafety ? 'one prior seller/amount/exact-item sale with no known competing return allocation or over-return' : 'exact candidate has existing return/allocation or cumulative amount evidence';
  } else if (exact.length > 1) {
    classification = 'AMBIGUOUS_EXACT_COMPETITION';
    reason = 'multiple prior sales satisfy seller, amount, chronology and exact item fingerprint';
  } else if (sameSellerAmount.length > 1) {
    classification = 'AMBIGUOUS_SAME_SELLER_AMOUNT';
    reason = 'multiple prior same-seller same-amount sales remain after chronology';
  } else if (partial.length > 0) {
    classification = 'PARTIAL_ITEM_CANDIDATE';
    reason = 'item overlap exists but full item fingerprint/amount equality is not proven';
  } else if (sameSellerAmount.length === 1) {
    classification = 'SAME_SELLER_AMOUNT_NO_EXACT_ITEM';
    reason = 'one seller/amount candidate exists but exact item identity is not proven';
  } else if (itemAnySeller.length > 0 && amountAnySeller.length === 0) {
    classification = 'ITEM_MATCH_SELLER_OR_AMOUNT_MISMATCH';
    reason = 'prior item overlap exists without compatible seller and amount evidence';
  } else if (amountAnySeller.length > 0 && sameSellerAmount.length === 0) {
    classification = 'AMOUNT_MATCH_SELLER_MISMATCH';
    reason = 'prior amount match exists only under a different seller';
  } else if (priorSales.length === 0) {
    classification = 'NO_PRIOR_SALE_IN_HISTORY';
    reason = 'no earlier operation_type=1 receipt is visible in the current corpus';
  } else {
    classification = 'NO_COMPATIBLE_CANDIDATE';
    reason = 'prior sales exist, but no compatible seller/amount/item candidate was found';
  }

  return {
    returnReceiptId: returnReceipt.id,
    classification,
    reason,
    candidateCounts: {
      priorSales: priorSales.length,
      sameSellerAmount: sameSellerAmount.length,
      exact: exact.length,
      partial: partial.length,
      amountAnySeller: amountAnySeller.length,
      itemAnySeller: itemAnySeller.length,
    },
    candidates: evaluated.filter(({ predicates }) => predicates.sellerIdentity || predicates.amountEquality || predicates.itemOverlap).map(({ sale, predicates }) => ({
      saleReceiptId: sale.id,
      sellerInn: sale.sellerInn,
      totalSum: sale.totalSum,
      dateTime: sale.dateTime,
      predicates,
    })).slice(0, 25),
    strictCandidateReceiptId: strictSafety ? exact[0].sale.id : null,
  };
}

export function summarizeReturnResearch(results) {
  const output = { total: results.length, byClassification: {}, fiscalFaceValue: 0, newMoney: 0, classifications: [] };
  for (const result of results) {
    output.byClassification[result.classification] = (output.byClassification[result.classification] ?? 0) + 1;
    output.classifications.push(result.classification);
  }
  return output;
}

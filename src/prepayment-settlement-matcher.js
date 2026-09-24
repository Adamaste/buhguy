import { fiscalContentFingerprint } from './fiscal-evidence.js';
import { BusinessEventGraphRepository, GRAPH_MODEL_VERSION, SYSTEM_DERIVED } from './business-event-graph.js';
import { decodePostgresTextEvidence } from './postgres-text-evidence.js';

export const PREPAYMENT_SETTLEMENT_RULE = 'PREPAYMENT_SETTLEMENT_V1';
export const MATCHER_VERSION = 'prepayment-settlement-matcher-v1';
export const NORMALIZED_FACT_VERSION = 'fiscal-normalizer-v1';

const PREPAYMENT_STAGES = new Set(['PREPAYMENT_ONLY', 'ADVANCE_ONLY']);
const SETTLEMENT_STAGES = new Set(['SETTLEMENT_ONLY', 'MIXED']);

function amount(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

function positive(value) { return value !== null && value !== undefined && Number(value) > 0; }

function itemsFingerprint(items) {
  return fiscalContentFingerprint((items ?? []).map((item) => ({
    name: item.name ?? null,
    quantity: amount(item.quantity),
    price: amount(item.price),
    itemSum: amount(item.itemSum),
    providerInn: item.providerInn ?? null,
    gtin: item.gtin ?? null,
    rawProductCode: item.rawProductCode ?? null,
  })));
}

function newMoney(fact) {
  if (fact.cashTotalSum === null || fact.ecashTotalSum === null) return null;
  return Number(fact.cashTotalSum) + Number(fact.ecashTotalSum);
}

function predicate(name, matched, details = null) { return { name, matched: Boolean(matched), details }; }

function comparePair(prepayment, settlement, { scopeKey = 'default' } = {}) {
  const preItems = prepayment.items ?? [];
  const settlementItems = settlement.items ?? [];
  const predicates = [
    predicate('same_accounting_scope', prepayment.scopeKey === settlement.scopeKey && prepayment.scopeKey === scopeKey),
    predicate('operation_type_compatible', [1].includes(Number(prepayment.operationType)) && [1].includes(Number(settlement.operationType))),
    predicate('prepayment_stage', PREPAYMENT_STAGES.has(prepayment.paymentStage)),
    predicate('full_settlement_stage', settlement.paymentStage === 'SETTLEMENT_ONLY'),
    predicate('ready_normalization', prepayment.normalizationStatus === 'READY' && settlement.normalizationStatus === 'READY'),
    predicate('chronology', new Date(prepayment.dateTime).getTime() < new Date(settlement.dateTime).getTime()),
    predicate('seller_identity', prepayment.sellerInn !== null && prepayment.sellerInn === settlement.sellerInn),
    predicate('currency_compatible', (prepayment.currency === null && settlement.currency === null)
      || (prepayment.currency !== null && settlement.currency !== null && prepayment.currency === settlement.currency)),
    predicate('amount_equality', amount(prepayment.totalSum) !== null && amount(prepayment.totalSum) === amount(settlement.totalSum)),
    predicate('item_count', preItems.length > 0 && preItems.length === settlementItems.length),
    predicate('item_names', preItems.length === settlementItems.length && preItems.every((item, index) => item.name === settlementItems[index]?.name)),
    predicate('quantity', preItems.length === settlementItems.length && preItems.every((item, index) => amount(item.quantity) === amount(settlementItems[index]?.quantity))),
    predicate('price', preItems.length === settlementItems.length && preItems.every((item, index) => amount(item.price) === amount(settlementItems[index]?.price))),
    predicate('item_sum', preItems.length === settlementItems.length && preItems.every((item, index) => amount(item.itemSum) === amount(settlementItems[index]?.itemSum))),
    predicate('provider_inn', preItems.length === settlementItems.length && preItems.every((item, index) => item.providerInn === settlementItems[index]?.providerInn)),
    predicate('gtin_product_code', itemsFingerprint(preItems) === itemsFingerprint(settlementItems)),
    predicate('prepayment_new_money', positive(newMoney(prepayment))),
    predicate('settlement_consumes_prepaid', amount(settlement.prepaidSum) === amount(settlement.totalSum) && newMoney(settlement) === 0),
    predicate('no_credit_or_provision', amount(prepayment.creditSum) === '0.00' && amount(prepayment.provisionSum) === '0.00' && amount(settlement.creditSum) === '0.00' && amount(settlement.provisionSum) === '0.00'),
  ];
  const strict = predicates.every((item) => item.matched);
  const research = predicates.slice(0, 9).every((item) => item.matched);
  const firstFailed = predicates.find((item) => !item.matched);
  return {
    prepaymentReceiptId: prepayment.id,
    settlementReceiptId: settlement.id,
    prepaymentFnsId: prepayment.fnsId,
    settlementFnsId: settlement.fnsId,
    sellerInn: prepayment.sellerInn,
    amount: amount(prepayment.totalSum),
    prepaymentTimestamp: prepayment.dateTime,
    settlementTimestamp: settlement.dateTime,
    research,
    strict,
    firstExclusionReason: firstFailed?.name ?? null,
    predicates,
    purchaseValue: strict ? amount(prepayment.totalSum) : null,
    rule: PREPAYMENT_SETTLEMENT_RULE,
    matcherVersion: MATCHER_VERSION,
    normalizerVersion: NORMALIZED_FACT_VERSION,
  };
}

export function matchPrepaymentSettlements(receipts, { scopeKey = 'default', retainDetails = true } = {}) {
  const rows = [...receipts].sort((a, b) => String(a.dateTime).localeCompare(String(b.dateTime)) || Number(a.id) - Number(b.id));
  const settlements = rows.filter((row) => SETTLEMENT_STAGES.has(row.paymentStage));
  const candidates = [];
  const settlementsResult = [];
  for (const settlement of settlements) {
    const pairs = rows.filter((row) => PREPAYMENT_STAGES.has(row.paymentStage) && new Date(row.dateTime).getTime() < new Date(settlement.dateTime).getTime()).map((prepayment) => {
      const pair = comparePair(prepayment, settlement, { scopeKey });
      if (retainDetails) return pair;
      return {
        prepaymentReceiptId: pair.prepaymentReceiptId,
        settlementReceiptId: pair.settlementReceiptId,
        amount: pair.amount,
        purchaseValue: pair.purchaseValue,
        strict: pair.strict,
      };
    });
    const strictPairs = pairs.filter((pair) => pair.strict);
    candidates.push(...pairs);
    settlementsResult.push({ settlementReceiptId: settlement.id, status: 'PENDING', candidateCount: pairs.length, strictCount: strictPairs.length, strictPairs });
  }
  const uniqueStrictPairs = settlementsResult.flatMap((settlement) => settlement.strictPairs.length === 1 ? settlement.strictPairs : []);
  const prepaymentUse = new Map();
  for (const pair of uniqueStrictPairs) prepaymentUse.set(pair.prepaymentReceiptId, (prepaymentUse.get(pair.prepaymentReceiptId) ?? 0) + 1);
  for (const settlement of settlementsResult) {
    const status = settlement.strictPairs.length > 1
      ? 'AMBIGUOUS'
      : (settlement.strictPairs.length === 1
        ? (prepaymentUse.get(settlement.strictPairs[0].prepaymentReceiptId) === 1 ? 'CONFIRMED' : 'AMBIGUOUS')
        : (settlement.candidateCount ? 'CANDIDATE' : 'UNMATCHED'));
    if (settlement.strictPairs.length === 1) settlement.strictPairs[0].confirmed = status === 'CONFIRMED';
    settlement.status = status;
    delete settlement.strictPairs;
  }
  return {
    rule: PREPAYMENT_SETTLEMENT_RULE,
    matcherVersion: MATCHER_VERSION,
    normalizerVersion: NORMALIZED_FACT_VERSION,
    candidates,
    settlements: settlementsResult,
    summary: {
      settlementsExamined: settlements.length,
      candidatePairs: candidates.length,
      strictMatches: candidates.filter((pair) => pair.strict).length,
      confirmedSettlements: settlementsResult.filter((row) => row.status === 'CONFIRMED').length,
      ambiguousSettlements: settlementsResult.filter((row) => row.status === 'AMBIGUOUS').length,
      unmatchedSettlements: settlementsResult.filter((row) => row.status === 'UNMATCHED').length,
      candidateOnlySettlements: settlementsResult.filter((row) => row.status === 'CANDIDATE').length,
    },
  };
}

const MATCHER_RECEIPTS_BODY = `
SELECT r.id, r.fns_id AS "fnsId", r.date_time AS "dateTime", r.seller_inn AS "sellerInn",
       r.operation_type AS "operationType",
       r.total_sum AS "totalSum", r.currency, f.normalization_status AS "normalizationStatus",
       f.payment_stage AS "paymentStage", f.cash_total_sum AS "cashTotalSum",
       f.ecash_total_sum AS "ecashTotalSum", f.prepaid_sum AS "prepaidSum",
       f.credit_sum AS "creditSum", f.provision_sum AS "provisionSum",
       COALESCE(jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity,
         'price', i.price, 'itemSum', i.item_sum, 'providerInn', f_item.provider_inn,
         'gtin', f_item.gtin, 'rawProductCode', f_item.raw_product_code)
         ORDER BY i.position) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
FROM receipts r
JOIN receipt_fiscal_facts f ON f.receipt_id = r.id AND f.normalization_version = $1
LEFT JOIN receipt_items i ON i.receipt_id = r.id
LEFT JOIN receipt_item_fiscal_facts f_item ON f_item.receipt_item_id = i.id AND f_item.normalization_version = $1
`;

const MATCHER_RECEIPTS_GROUP = `
GROUP BY r.id, f.receipt_id, f.normalization_version;
`;

export const MATCHER_RECEIPTS_SQL = `${MATCHER_RECEIPTS_BODY}WHERE f.normalization_status = 'READY'${MATCHER_RECEIPTS_GROUP}`;

const MATCHER_INCREMENTAL_RECEIPTS_SQL = `
WITH target AS (
  SELECT r.id, r.seller_inn
  FROM receipts r
  JOIN receipt_fiscal_facts f ON f.receipt_id = r.id AND f.normalization_version = $1
  WHERE r.id = $2 AND f.normalization_status = 'READY'
)
${MATCHER_RECEIPTS_BODY}
WHERE f.normalization_status = 'READY'
  AND (
    r.id = $2
    OR (
      r.operation_type = 1
      AND f.payment_stage IN ('PREPAYMENT_ONLY', 'ADVANCE_ONLY', 'SETTLEMENT_ONLY', 'MIXED')
      AND EXISTS (SELECT 1 FROM target t WHERE t.seller_inn IS NOT NULL AND r.seller_inn = t.seller_inn)
    )
  )
${MATCHER_RECEIPTS_GROUP}
`;

export async function dryRunPrepaymentSettlements(pool, options = {}) {
  const result = await pool.query(MATCHER_RECEIPTS_SQL, [options.normalizerVersion ?? NORMALIZED_FACT_VERSION]);
  const scopeKey = options.scopeKey ?? 'default';
  return matchPrepaymentSettlements(result.rows.map((row) => ({ ...row, scopeKey, items: row.items.map((item) => ({ ...item, rawProductCode: decodePostgresTextEvidence(item.rawProductCode) })) })), { ...options, scopeKey, retainDetails: options.retainDetails ?? true });
}

export async function reconsiderPrepaymentSettlement(pool, receiptId, options = {}) {
  const normalizerVersion = options.normalizerVersion ?? NORMALIZED_FACT_VERSION;
  const result = await pool.query(MATCHER_INCREMENTAL_RECEIPTS_SQL, [normalizerVersion, receiptId]);
  if (!result.rowCount) return { rule: PREPAYMENT_SETTLEMENT_RULE, matcherVersion: MATCHER_VERSION, normalizerVersion, receiptId, summary: { settlementsExamined: 0, candidatePairs: 0, strictMatches: 0, confirmedSettlements: 0, ambiguousSettlements: 0, unmatchedSettlements: 0, candidateOnlySettlements: 0 }, candidates: [], settlements: [], triggerStatus: 'NOT_READY' };
  const scopeKey = options.scopeKey ?? 'default';
  const dryRun = matchPrepaymentSettlements(result.rows.map((row) => ({ ...row, scopeKey, items: row.items.map((item) => ({ ...item, rawProductCode: decodePostgresTextEvidence(item.rawProductCode) })) })), { ...options, scopeKey });
  const trigger = dryRun.settlements.find((row) => String(row.settlementReceiptId) === String(receiptId)) ?? null;
  if (options.persist && dryRun.summary.confirmedSettlements) {
    const pairKeys = dryRun.candidates
      .filter((pair) => pair.strict && (String(pair.prepaymentReceiptId) === String(receiptId) || String(pair.settlementReceiptId) === String(receiptId)))
      .map((pair) => `${pair.prepaymentReceiptId}:${pair.settlementReceiptId}`);
    return { ...await persistPrepaymentSettlementMatches(pool, { ...options, result: dryRun, pairKeys }), triggerStatus: trigger?.status ?? 'RECONSIDERED' };
  }
  return { ...dryRun, receiptId, triggerStatus: trigger?.status ?? 'RECONSIDERED' };
}

export async function persistPrepaymentSettlementMatches(pool, options = {}) {
  const result = options.result ?? await dryRunPrepaymentSettlements(pool, { ...options, retainDetails: false });
  const graph = new BusinessEventGraphRepository(pool);
  const strictBySettlement = new Map();
  for (const pair of result.candidates.filter((candidate) => candidate.strict)) {
    const list = strictBySettlement.get(pair.settlementReceiptId) ?? [];
    list.push(pair);
    strictBySettlement.set(pair.settlementReceiptId, list);
  }
  const allConfirmedPairs = result.candidates.filter((pair) => pair.confirmed === true);
  const requestedKeys = options.pairKeys ? new Set(options.pairKeys) : null;
  const confirmedPairs = requestedKeys
    ? allConfirmedPairs.filter((pair) => requestedKeys.has(`${pair.prepaymentReceiptId}:${pair.settlementReceiptId}`))
    : allConfirmedPairs;
  const created = { purchases: 0, lifecycleEvents: 0, evidenceLinks: 0, edges: 0, allocations: 0 };
  await graph.withTransaction(async (tx) => {
    for (const pair of confirmedPairs) {
      const base = {
        scopeKey: options.scopeKey ?? 'default', origin: SYSTEM_DERIVED,
        graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: PREPAYMENT_SETTLEMENT_RULE,
        ruleVersion: MATCHER_VERSION, resolutionStatus: 'CONFIRMED', amount: pair.purchaseValue,
        currency: null,
      };
      const purchase = await tx.createEvent({ ...base, eventType: 'PURCHASE', semanticKey: `purchase:${pair.prepaymentReceiptId}:${pair.settlementReceiptId}`, description: 'One purchase lifecycle represented by prepayment and later full settlement' });
      if (purchase.created) created.purchases += 1;
      if (options.failAfter === 'purchase') throw new Error('injected matcher failure after purchase');
      const prepayment = await tx.createEvent({ ...base, eventType: 'PREPAYMENT', semanticKey: `prepayment:${pair.prepaymentReceiptId}:${pair.settlementReceiptId}`, description: 'Prepayment evidence for the confirmed purchase lifecycle' });
      const fulfillment = await tx.createEvent({ ...base, eventType: 'FULFILLMENT', semanticKey: `fulfillment:${pair.prepaymentReceiptId}:${pair.settlementReceiptId}`, description: 'Full settlement/fulfillment evidence for the confirmed purchase lifecycle' });
      created.lifecycleEvents += Number(prepayment.created) + Number(fulfillment.created);
      if (options.failAfter === 'lifecycle') throw new Error('injected matcher failure after lifecycle');
      const preEvidence = await tx.createEvidenceLink({ eventId: prepayment.id, receiptId: pair.prepaymentReceiptId, normalizationVersion: NORMALIZED_FACT_VERSION, evidenceRole: 'PREPAYMENT_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: PREPAYMENT_SETTLEMENT_RULE, ruleVersion: MATCHER_VERSION });
      const settleEvidence = await tx.createEvidenceLink({ eventId: fulfillment.id, receiptId: pair.settlementReceiptId, normalizationVersion: NORMALIZED_FACT_VERSION, evidenceRole: 'FULFILLMENT_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: PREPAYMENT_SETTLEMENT_RULE, ruleVersion: MATCHER_VERSION });
      created.evidenceLinks += Number(preEvidence.created) + Number(settleEvidence.created);
      if (options.failAfter === 'evidence') throw new Error('injected matcher failure after evidence');
      const preEdge = await tx.createEdge({ ...base, sourceEventId: prepayment.id, targetEventId: purchase.id, relationType: 'PREPAYMENT_FOR', semanticKey: `prepayment-for:${pair.prepaymentReceiptId}:${pair.settlementReceiptId}`, explanation: 'Strict PREPAYMENT_SETTLEMENT_V1 evidence' });
      const settleEdge = await tx.createEdge({ ...base, sourceEventId: fulfillment.id, targetEventId: purchase.id, relationType: 'FULFILLS', semanticKey: `fulfills:${pair.prepaymentReceiptId}:${pair.settlementReceiptId}`, explanation: 'Strict PREPAYMENT_SETTLEMENT_V1 evidence' });
      created.edges += Number(preEdge.created) + Number(settleEdge.created);
      if (options.failAfter === 'commit') throw new Error('injected matcher failure before commit');
    }
  });
  return { ...result, writeMode: true, created, confirmedPairs: confirmedPairs.map((pair) => ({ prepaymentReceiptId: pair.prepaymentReceiptId, settlementReceiptId: pair.settlementReceiptId, purchaseValue: pair.purchaseValue })) };
}

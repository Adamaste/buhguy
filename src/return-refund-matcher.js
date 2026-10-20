import { MATCHER_RECEIPTS_SQL, NORMALIZED_FACT_VERSION } from './prepayment-settlement-matcher.js';
import { BusinessEventGraphRepository, EXTERNAL_CONFIRMED, GRAPH_MODEL_VERSION, MANUAL, SYSTEM_DERIVED } from './business-event-graph.js';
import { classifyReturnResearch } from './return-refund-research.js';

export const RETURN_REFUND_RULE = 'RETURN_REFUND_V1';
export const RETURN_REFUND_MATCHER_VERSION = 'return-refund-matcher-v1';

const money = (value) => Number(value ?? 0);
const amount = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : null;

function mapReceiptRows(rows) {
  return rows.map((row) => ({
    id: String(row.id), operationType: row.operationType, fnsId: row.fnsId, sellerInn: row.sellerInn,
    totalSum: row.totalSum, currency: row.currency, dateTime: row.dateTime,
    normalizationStatus: row.normalizationStatus, paymentStage: row.paymentStage,
    cashTotalSum: row.cashTotalSum, ecashTotalSum: row.ecashTotalSum, prepaidSum: row.prepaidSum,
    creditSum: row.creditSum, provisionSum: row.provisionSum, items: row.items ?? [],
  }));
}

export function matchReturnReceipts(receipts, options = {}) {
  const rows = mapReceiptRows(receipts);
  const sales = rows.filter((row) => Number(row.operationType) === 1);
  const returns = rows.filter((row) => Number(row.operationType) === 2);
  const purchaseTargets = options.purchaseTargets ?? new Map();
  const standalonePurchaseEligible = options.standalonePurchaseEligible ?? new Set();
  const priorReturnsBySaleId = options.priorReturnsBySaleId ?? new Map();
  const priorReturnedAmountBySaleId = options.priorReturnedAmountBySaleId ?? new Map();
  const results = returns.map((returnReceipt) => {
    const research = classifyReturnResearch(returnReceipt, sales, { priorReturnsBySaleId, priorReturnedAmountBySaleId, allocatedSaleIds: options.allocatedSaleIds });
    const exactCandidate = research.strictCandidateReceiptId ? sales.find((sale) => sale.id === research.strictCandidateReceiptId) : null;
    const target = exactCandidate ? purchaseTargets.get(exactCandidate.id) ?? (standalonePurchaseEligible.has(exactCandidate.id) ? { kind: 'STANDALONE', saleReceiptId: exactCandidate.id } : null) : null;
    let status = 'UNMATCHED';
    if (research.classification.startsWith('AMBIGUOUS')) status = 'AMBIGUOUS';
    else if (research.classification === 'PARTIAL_ITEM_CANDIDATE') status = 'CANDIDATE_ONLY';
    else if (research.classification === 'EXACT_UNIQUE_SAFE' && target) status = 'CONFIRMED';
    else if (research.classification === 'EXACT_UNIQUE_SAFE') status = 'CANDIDATE_ONLY';
    return {
      ...research,
      status,
      returnReceipt,
      saleReceipt: exactCandidate,
      purchaseTarget: target,
      rule: RETURN_REFUND_RULE,
      matcherVersion: RETURN_REFUND_MATCHER_VERSION,
      normalizationVersion: NORMALIZED_FACT_VERSION,
      refundStatus: 'UNPROVEN',
    };
  });
  const consumedPurchaseKeys = new Set();
  const orderedResults = [...results].sort((a, b) => new Date(a.returnReceipt.dateTime).getTime() - new Date(b.returnReceipt.dateTime).getTime() || String(a.returnReceipt.id).localeCompare(String(b.returnReceipt.id)));
  for (const result of orderedResults) {
    if (result.status !== 'CONFIRMED' || !result.saleReceipt) continue;
    const purchaseKey = String(result.purchaseTarget?.eventId ?? result.saleReceipt.id);
    if (consumedPurchaseKeys.has(purchaseKey)) {
      result.status = 'CANDIDATE_ONLY';
      result.reason = 'another full return already consumes the same purchase lifecycle in this deterministic run';
    } else {
      consumedPurchaseKeys.add(purchaseKey);
    }
  }
  return {
    rule: RETURN_REFUND_RULE,
    matcherVersion: RETURN_REFUND_MATCHER_VERSION,
    normalizationVersion: NORMALIZED_FACT_VERSION,
    results,
    summary: {
      returnsExamined: returns.length,
      confirmed: results.filter((row) => row.status === 'CONFIRMED').length,
      ambiguous: results.filter((row) => row.status === 'AMBIGUOUS').length,
      candidateOnly: results.filter((row) => row.status === 'CANDIDATE_ONLY').length,
      unresolved: results.filter((row) => row.status === 'UNMATCHED').length,
      fiscalFaceValue: returns.reduce((sum, row) => sum + money(row.totalSum), 0).toFixed(2),
      newMoney: returns.reduce((sum, row) => sum + money(row.cashTotalSum) + money(row.ecashTotalSum), 0).toFixed(2),
    },
  };
}

async function loadReturnInputs(pool, scopeKey = 'default') {
  const rows = (await pool.query(MATCHER_RECEIPTS_SQL, [NORMALIZED_FACT_VERSION, scopeKey])).rows;
  const graphRows = (await pool.query(`
    SELECT e.receipt_id, b.id AS event_id, b.event_type, b.resolution_status,
           b.origin, b.amount, s.scope_key
    FROM business_event_evidence e
    JOIN business_events b ON b.id=e.event_id
    JOIN accounting_scopes s ON s.id=b.scope_id
    WHERE e.receipt_id IS NOT NULL AND s.scope_key=$1
    ORDER BY e.receipt_id,b.id`, [scopeKey])).rows;
  const purchaseTargets = new Map();
  for (const row of graphRows.filter((item) => item.event_type === 'PURCHASE' && item.resolution_status === 'CONFIRMED')) {
    const current = purchaseTargets.get(String(row.receipt_id));
    if (!current) purchaseTargets.set(String(row.receipt_id), { kind: 'EXISTING', eventId: Number(row.event_id), scopeKey });
    else if (current.eventId !== Number(row.event_id)) purchaseTargets.delete(String(row.receipt_id));
  }
  const lifecycleRows = (await pool.query(`
    SELECT ev.receipt_id, e.target_event_id AS purchase_event_id
    FROM business_event_evidence ev
    JOIN business_event_edges e ON e.source_event_id=ev.event_id
    JOIN business_events p ON p.id=e.target_event_id
    JOIN accounting_scopes s ON s.id=p.scope_id
    WHERE e.relation_type IN ('PREPAYMENT_FOR','FULFILLS')
      AND e.resolution_status='CONFIRMED' AND p.event_type='PURCHASE'
      AND s.scope_key=$1`, [scopeKey])).rows;
  for (const row of lifecycleRows) {
    const current = purchaseTargets.get(String(row.receipt_id));
    if (!current) purchaseTargets.set(String(row.receipt_id), { kind: 'EXISTING', eventId: Number(row.purchase_event_id), scopeKey });
    else if (current.eventId !== Number(row.purchase_event_id)) purchaseTargets.delete(String(row.receipt_id));
  }
  const purchaseReceipts = new Map();
  for (const row of graphRows.filter((item) => item.event_type === 'PURCHASE' && item.resolution_status === 'CONFIRMED')) {
    const list = purchaseReceipts.get(Number(row.event_id)) ?? [];
    list.push(String(row.receipt_id));
    purchaseReceipts.set(Number(row.event_id), list);
  }
  for (const row of lifecycleRows) {
    const list = purchaseReceipts.get(Number(row.purchase_event_id)) ?? [];
    list.push(String(row.receipt_id));
    purchaseReceipts.set(Number(row.purchase_event_id), list);
  }
  const standalonePurchaseEligible = new Set(rows.filter((row) => row.operationType === 1 && row.paymentStage === 'SETTLEMENT_ONLY' && !graphRows.some((item) => String(item.receipt_id) === String(row.id) && ['PREPAYMENT', 'FULFILLMENT'].includes(item.event_type))).map((row) => String(row.id)));
  const confirmedReturnRows = (await pool.query(`
    SELECT ev.receipt_id, e.target_event_id AS purchase_event_id, COALESCE(SUM(a.allocated_amount),0) AS returned_amount
    FROM business_event_edges e
    JOIN business_event_evidence ev ON ev.event_id=e.source_event_id
    LEFT JOIN business_event_allocations a ON a.target_event_id=e.source_event_id AND a.resolution_status='CONFIRMED'
    WHERE e.relation_type='RETURNS' AND e.resolution_status='CONFIRMED' AND e.origin IN ('SYSTEM_DERIVED','MANUAL','EXTERNAL_CONFIRMED')
    GROUP BY ev.receipt_id,e.target_event_id`)).rows;
  const priorReturnsBySaleId = new Map();
  const priorReturnedAmountBySaleId = new Map();
  const allocatedSaleIds = new Set();
  for (const row of confirmedReturnRows) {
    for (const receiptId of purchaseReceipts.get(Number(row.purchase_event_id)) ?? []) {
      priorReturnsBySaleId.set(receiptId, (priorReturnsBySaleId.get(receiptId) ?? 0) + 1);
      priorReturnedAmountBySaleId.set(receiptId, (priorReturnedAmountBySaleId.get(receiptId) ?? 0) + money(row.returned_amount));
    }
    allocatedSaleIds.add(String(row.receipt_id));
  }
  return { rows, purchaseTargets, standalonePurchaseEligible, priorReturnsBySaleId, priorReturnedAmountBySaleId, allocatedSaleIds };
}

export async function dryRunReturnRefundMatches(pool, options = {}) {
  const inputs = await loadReturnInputs(pool, options.scopeKey ?? 'default');
  return matchReturnReceipts(inputs.rows, inputs);
}

export async function reconsiderReturnRefund(pool, receiptId, options = {}) {
  const result = options.result ?? await dryRunReturnRefundMatches(pool, options);
  const trigger = result.results.find((row) => String(row.returnReceiptId) === String(receiptId)) ?? null;
  if (options.persist && trigger?.status === 'CONFIRMED') {
    const scopedResult = {
      ...result,
      results: [trigger],
      summary: { ...result.summary, returnsExamined: 1, confirmed: 1, ambiguous: 0, candidateOnly: 0, unmatched: 0 },
    };
    return { ...await persistReturnRefundMatches(pool, { ...options, result: scopedResult }), triggerStatus: trigger.status, receiptId };
  }
  return { ...result, triggerStatus: trigger?.status ?? 'UNRESOLVED', receiptId };
}

async function existingConfirmedReturnForReceipt(tx, receiptId) {
  const result = await tx.pool.query(`SELECT e.id FROM business_event_edges e JOIN business_event_evidence ev ON ev.event_id=e.source_event_id WHERE e.relation_type='RETURNS' AND e.resolution_status='CONFIRMED' AND ev.receipt_id=$1 LIMIT 1`, [receiptId]);
  return result.rowCount > 0;
}

export async function persistReturnRefundMatches(pool, options = {}) {
  const scopeKey = options.scopeKey ?? 'default';
  const result = options.result ?? await dryRunReturnRefundMatches(pool, { scopeKey });
  const graph = new BusinessEventGraphRepository(pool);
  const created = { purchases: 0, returns: 0, refunds: 0, evidenceLinks: 0, edges: 0, allocations: 0 };
  await graph.withTransaction(async (tx) => {
    for (const match of result.results.filter((row) => row.status === 'CONFIRMED')) {
      if (!match.saleReceipt || !match.returnReceipt) continue;
      await tx.pool.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${RETURN_REFUND_RULE}:${scopeKey}:${match.saleReceipt.id}`]);
      if (await existingConfirmedReturnForReceipt(tx, match.returnReceipt.id)) continue;
      const base = { scopeKey, origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: RETURN_REFUND_RULE, ruleVersion: RETURN_REFUND_MATCHER_VERSION, resolutionStatus: 'CONFIRMED', amount: amount(match.returnReceipt.totalSum), currency: match.returnReceipt.currency ?? null };
      let purchase;
      if (match.purchaseTarget?.eventId) purchase = { id: match.purchaseTarget.eventId, created: false };
      else {
        purchase = await tx.createEvent({ ...base, eventType: 'PURCHASE', amount: amount(match.saleReceipt.totalSum), semanticKey: `return-purchase:${match.saleReceipt.id}`, description: 'Standalone full-settlement purchase resolved by RETURN_REFUND_V1' });
        if (purchase.created) created.purchases += 1;
        const saleEvidence = await tx.createEvidenceLink({ eventId: purchase.id, receiptId: match.saleReceipt.id, normalizationVersion: NORMALIZED_FACT_VERSION, evidenceRole: 'PURCHASE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: RETURN_REFUND_RULE, ruleVersion: RETURN_REFUND_MATCHER_VERSION });
        created.evidenceLinks += Number(saleEvidence.created);
      }
      if (options.failAfter === 'purchase') throw new Error('injected return matcher failure after purchase');
      const returnEvent = await tx.createEvent({ ...base, eventType: 'RETURN', semanticKey: `return:${match.returnReceipt.id}:purchase:${purchase.id}`, description: 'Fiscal return evidence for an exact unique purchase match' });
      if (returnEvent.created) created.returns += 1;
      if (options.failAfter === 'return') throw new Error('injected return matcher failure after return');
      const returnEvidence = await tx.createEvidenceLink({ eventId: returnEvent.id, receiptId: match.returnReceipt.id, normalizationVersion: NORMALIZED_FACT_VERSION, evidenceRole: 'RETURN_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: RETURN_REFUND_RULE, ruleVersion: RETURN_REFUND_MATCHER_VERSION });
      created.evidenceLinks += Number(returnEvidence.created);
      const edge = await tx.createEdge({ ...base, sourceEventId: returnEvent.id, targetEventId: purchase.id, relationType: 'RETURNS', semanticKey: `returns:${match.returnReceipt.id}:purchase:${purchase.id}`, explanation: 'Exact unique full return; monetary refund is not independently proven' });
      created.edges += Number(edge.created);
      if (options.failAfter === 'edge') throw new Error('injected return matcher failure after edge');
      const allocation = await tx.createAllocation({ ...base, targetEventId: returnEvent.id, sourceReceiptId: match.returnReceipt.id, normalizationVersion: NORMALIZED_FACT_VERSION, allocatedAmount: amount(match.returnReceipt.totalSum), currency: match.returnReceipt.currency ?? 'RUB', allocationRole: 'RETURN_COMPONENT', explanation: 'Full return amount allocation guarded by RETURN_REFUND_V1' });
      created.allocations += Number(allocation.created);
    }
  });
  return { ...result, created, refundEventsCreated: created.refunds };
}

export async function rebuildReturnRefundMatches(pool, options = {}) {
  const graph = new BusinessEventGraphRepository(pool);
  const scopeKey = options.scopeKey ?? 'default';
  const deleted = await graph.rebuildSystemDerived({ scopeKey, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: RETURN_REFUND_RULE, ruleVersion: RETURN_REFUND_MATCHER_VERSION });
  const result = await persistReturnRefundMatches(pool, { scopeKey });
  return { deleted, ...result };
}

export { EXTERNAL_CONFIRMED, MANUAL };

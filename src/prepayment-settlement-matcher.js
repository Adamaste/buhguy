import { fiscalContentFingerprint } from './fiscal-evidence.js';
import { BusinessEventGraphRepository, GRAPH_MODEL_VERSION, SYSTEM_DERIVED } from './business-event-graph.js';
import { decodePostgresTextEvidence } from './postgres-text-evidence.js';
import { lockMatchedPurchaseScope, lockMatchedPurchaseScopeTransaction } from './matched-purchase-locks.js';

export const PREPAYMENT_SETTLEMENT_RULE = 'PREPAYMENT_SETTLEMENT_V1';
export const MATCHER_VERSION = 'prepayment-settlement-matcher-v2';
export const NORMALIZED_FACT_VERSION = 'fiscal-normalizer-v1';
export const PREPAYMENT_SETTLEMENT_START_AT_ENV = 'PREPAYMENT_SETTLEMENT_START_AT';

const PREPAYMENT_STAGES = new Set(['PREPAYMENT_ONLY', 'ADVANCE_ONLY']);
const SETTLEMENT_STAGES = new Set(['SETTLEMENT_ONLY', 'MIXED']);

function amount(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

function positive(value) { return value !== null && value !== undefined && Number(value) > 0; }

function itemFingerprint(item) {
  return fiscalContentFingerprint({
    name: item.name ?? null,
    quantity: amount(item.quantity),
    price: amount(item.price),
    itemSum: amount(item.itemSum),
    providerInn: item.providerInn ?? null,
    gtin: item.gtin ?? null,
    rawProductCode: item.rawProductCode ?? null,
  });
}

function sameMultiset(left, right, fingerprint = (value) => JSON.stringify(value)) {
  if (left.length !== right.length) return false;
  const a = left.map(fingerprint).sort();
  const b = right.map(fingerprint).sort();
  return a.every((value, index) => value === b[index]);
}

function itemsFingerprint(items) {
  return fiscalContentFingerprint((items ?? []).map(itemFingerprint).sort());
}

function strictStartAt(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    const error = new Error(`${PREPAYMENT_SETTLEMENT_START_AT_ENV} must be an ISO timestamp`);
    error.code = 'PREPAYMENT_SETTLEMENT_START_AT_INVALID';
    throw error;
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) {
    const error = new Error(`${PREPAYMENT_SETTLEMENT_START_AT_ENV} must be a canonical UTC timestamp`);
    error.code = 'PREPAYMENT_SETTLEMENT_START_AT_INVALID';
    throw error;
  }
  return normalized;
}

export function readPrepaymentSettlementStartAt(env = process.env) {
  return strictStartAt(env[PREPAYMENT_SETTLEMENT_START_AT_ENV]);
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
    predicate('prepayment_not_already_expensed', prepayment.manualTroikaTopupAlreadyExpensed !== true),
    predicate('full_settlement_stage', settlement.paymentStage === 'SETTLEMENT_ONLY'),
    predicate('settlement_not_already_expensed', settlement.manualTroikaTopupAlreadyExpensed !== true),
    predicate('ready_normalization', prepayment.normalizationStatus === 'READY' && settlement.normalizationStatus === 'READY'),
    predicate('chronology', new Date(prepayment.dateTime).getTime() < new Date(settlement.dateTime).getTime()),
    predicate('seller_identity', prepayment.sellerInn !== null && prepayment.sellerInn === settlement.sellerInn),
    predicate('currency_compatible', (prepayment.currency === null && settlement.currency === null)
      || (prepayment.currency !== null && settlement.currency !== null && prepayment.currency === settlement.currency)),
    predicate('amount_equality', amount(prepayment.totalSum) !== null && amount(prepayment.totalSum) === amount(settlement.totalSum)),
    predicate('item_count', preItems.length > 0 && preItems.length === settlementItems.length),
    predicate('item_names', sameMultiset(preItems, settlementItems, (item) => JSON.stringify(item.name ?? null))),
    predicate('quantity', sameMultiset(preItems, settlementItems, (item) => amount(item.quantity))),
    predicate('price', sameMultiset(preItems, settlementItems, (item) => amount(item.price))),
    predicate('item_sum', sameMultiset(preItems, settlementItems, (item) => amount(item.itemSum))),
    predicate('provider_inn', sameMultiset(preItems, settlementItems, (item) => JSON.stringify(item.providerInn ?? null))),
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
    prepaymentObservedAt: prepayment.sourceObservedAt ?? null,
    settlementObservedAt: settlement.sourceObservedAt ?? null,
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
        confirmed: pair.confirmed === true,
        prepaymentObservedAt: pair.prepaymentObservedAt,
        settlementObservedAt: pair.settlementObservedAt,
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
SELECT r.id, r.fns_id AS "fnsId", r.date_time AS "dateTime",
       (SELECT min(observation.observed_at)
        FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        WHERE observation.receipt_id=r.id
          AND source.scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$2)) AS "sourceObservedAt",
       r.seller_inn AS "sellerInn",
       r.operation_type AS "operationType",
       r.total_sum AS "totalSum", r.currency, f.normalization_status AS "normalizationStatus",
       f.payment_stage AS "paymentStage", f.cash_total_sum AS "cashTotalSum",
       f.ecash_total_sum AS "ecashTotalSum", f.prepaid_sum AS "prepaidSum",
       f.credit_sum AS "creditSum", f.provision_sum AS "provisionSum",
       COALESCE(jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity,
         'price', i.price, 'itemSum', i.item_sum, 'providerInn', f_item.provider_inn,
         'gtin', f_item.gtin, 'rawProductCode', f_item.raw_product_code)
         ORDER BY i.position) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items,
       EXISTS (SELECT 1 FROM manual_troika_topup_receipt_links manual_link WHERE manual_link.receipt_id=r.id) AS "manualTroikaTopupAlreadyExpensed"
FROM receipts r
JOIN receipt_fiscal_facts f ON f.receipt_id = r.id AND f.normalization_version = $1
LEFT JOIN receipt_items i ON i.receipt_id = r.id
LEFT JOIN receipt_item_fiscal_facts f_item ON f_item.receipt_item_id = i.id AND f_item.normalization_version = $1
`;

const MATCHER_RECEIPTS_GROUP = `
GROUP BY r.id, f.receipt_id, f.normalization_version;
`;

const MATCHER_SCOPE_OBSERVATION_FILTER = `EXISTS (
  SELECT 1 FROM receipt_source_observations observation
  JOIN fns_sources source ON source.id=observation.fns_source_id
  WHERE observation.receipt_id=r.id
    AND source.scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$2)
)`;

export const MATCHER_RECEIPTS_SQL = `${MATCHER_RECEIPTS_BODY}WHERE f.normalization_status = 'READY'
  AND ${MATCHER_SCOPE_OBSERVATION_FILTER}${MATCHER_RECEIPTS_GROUP}`;

const MATCHER_INCREMENTAL_RECEIPTS_SQL = `
WITH target AS (
  SELECT r.id, r.seller_inn
  FROM receipts r
  JOIN receipt_fiscal_facts f ON f.receipt_id = r.id AND f.normalization_version = $1
  WHERE r.id = $3 AND f.normalization_status = 'READY'
    AND ${MATCHER_SCOPE_OBSERVATION_FILTER}
)
${MATCHER_RECEIPTS_BODY}
WHERE f.normalization_status = 'READY'
  AND ${MATCHER_SCOPE_OBSERVATION_FILTER}
  AND (
    r.id = $3
    OR (
      r.operation_type = 1
      AND f.payment_stage IN ('PREPAYMENT_ONLY', 'ADVANCE_ONLY', 'SETTLEMENT_ONLY', 'MIXED')
      AND EXISTS (SELECT 1 FROM target t WHERE t.seller_inn IS NOT NULL AND r.seller_inn = t.seller_inn)
    )
  )
${MATCHER_RECEIPTS_GROUP}
`;

export async function dryRunPrepaymentSettlements(pool, options = {}) {
  const scopeKey = options.scopeKey ?? 'default';
  const result = await pool.query(MATCHER_RECEIPTS_SQL, [options.normalizerVersion ?? NORMALIZED_FACT_VERSION, scopeKey]);
  return matchPrepaymentSettlements(result.rows.map((row) => ({ ...row, scopeKey, items: row.items.map((item) => ({ ...item, rawProductCode: decodePostgresTextEvidence(item.rawProductCode) })) })), { ...options, scopeKey, retainDetails: options.retainDetails ?? true });
}

export async function reconsiderPrepaymentSettlement(pool, receiptId, options = {}) {
  const normalizerVersion = options.normalizerVersion ?? NORMALIZED_FACT_VERSION;
  const scopeKey = options.scopeKey ?? 'default';
  const result = await pool.query(MATCHER_INCREMENTAL_RECEIPTS_SQL, [normalizerVersion, scopeKey, receiptId]);
  if (!result.rowCount) return { rule: PREPAYMENT_SETTLEMENT_RULE, matcherVersion: MATCHER_VERSION, normalizerVersion, receiptId, summary: { settlementsExamined: 0, candidatePairs: 0, strictMatches: 0, confirmedSettlements: 0, ambiguousSettlements: 0, unmatchedSettlements: 0, candidateOnlySettlements: 0 }, candidates: [], settlements: [], triggerStatus: 'NOT_READY' };
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
  const configuredStartAt = Object.hasOwn(options, 'startAt')
    ? strictStartAt(options.startAt)
    : readPrepaymentSettlementStartAt();
  const strictBySettlement = new Map();
  for (const pair of result.candidates.filter((candidate) => candidate.strict)) {
    const list = strictBySettlement.get(pair.settlementReceiptId) ?? [];
    list.push(pair);
    strictBySettlement.set(pair.settlementReceiptId, list);
  }
  const allConfirmedPairs = result.candidates.filter((pair) => pair.confirmed === true);
  const eligibleByStartAt = (pair) => configuredStartAt !== null
    && pair.prepaymentObservedAt !== null && pair.settlementObservedAt !== null
    && Number.isFinite(Date.parse(pair.prepaymentObservedAt)) && Number.isFinite(Date.parse(pair.settlementObservedAt))
    && Date.parse(pair.prepaymentObservedAt) >= Date.parse(configuredStartAt)
    && Date.parse(pair.settlementObservedAt) >= Date.parse(configuredStartAt);
  const blockedByStartAt = allConfirmedPairs.filter((pair) => !eligibleByStartAt(pair)).map((pair) => ({
    prepaymentReceiptId: Number(pair.prepaymentReceiptId),
    settlementReceiptId: Number(pair.settlementReceiptId),
    reason: configuredStartAt === null ? 'PREPAYMENT_SETTLEMENT_START_AT_UNSET' : 'OUTSIDE_PREPAYMENT_SETTLEMENT_COHORT',
  }));
  const cohortConfirmedPairs = allConfirmedPairs.filter(eligibleByStartAt);
  const requestedKeys = options.pairKeys ? new Set(options.pairKeys) : null;
  const confirmedPairs = requestedKeys
    ? cohortConfirmedPairs.filter((pair) => requestedKeys.has(`${pair.prepaymentReceiptId}:${pair.settlementReceiptId}`))
    : cohortConfirmedPairs;
  const created = { purchases: 0, lifecycleEvents: 0, evidenceLinks: 0, edges: 0, allocations: 0 };
  const scopeKey = options.scopeKey ?? 'default';
  const lockClient = await pool.connect();
  let releaseScopeLock = null;
  let persistablePairs = [];
  let blockedManualTopupPairs = [];
  const tx = new BusinessEventGraphRepository({
    query: lockClient.query.bind(lockClient),
    connect: async () => lockClient,
  });
  try {
    releaseScopeLock = await lockMatchedPurchaseScope(lockClient, scopeKey);
    await lockClient.query('BEGIN');
    try {
      await lockMatchedPurchaseScopeTransaction(lockClient, scopeKey);
      const receiptIds = [...new Set(confirmedPairs.flatMap((pair) => [pair.prepaymentReceiptId, pair.settlementReceiptId]).map(Number))];
      const guardedReceipts = receiptIds.length
        ? new Set((await tx.pool.query(`SELECT receipt_id FROM manual_troika_topup_receipt_links WHERE receipt_id=ANY($1::bigint[])`, [receiptIds])).rows.map((row) => Number(row.receipt_id)))
        : new Set();
      const pairHasManualTopupEvidence = (pair) => guardedReceipts.has(Number(pair.prepaymentReceiptId))
        || guardedReceipts.has(Number(pair.settlementReceiptId));
      persistablePairs = confirmedPairs.filter((pair) => !pairHasManualTopupEvidence(pair));
      blockedManualTopupPairs = confirmedPairs.filter(pairHasManualTopupEvidence);
      for (const pair of persistablePairs) {
      const priorLifecycles = (await tx.pool.query(`SELECT DISTINCT pre_evidence.receipt_id AS prepayment_receipt_id,
          settle_evidence.receipt_id AS settlement_receipt_id
        FROM business_events purchase
        JOIN business_event_edges pre_edge ON pre_edge.target_event_id=purchase.id
          AND pre_edge.relation_type='PREPAYMENT_FOR' AND pre_edge.resolution_status='CONFIRMED'
        JOIN business_events prepayment ON prepayment.id=pre_edge.source_event_id
        JOIN business_event_evidence pre_evidence ON pre_evidence.event_id=prepayment.id
          AND pre_evidence.evidence_role='PREPAYMENT_EVIDENCE'
        JOIN business_event_edges settle_edge ON settle_edge.target_event_id=purchase.id
          AND settle_edge.relation_type='FULFILLS' AND settle_edge.resolution_status='CONFIRMED'
        JOIN business_events fulfillment ON fulfillment.id=settle_edge.source_event_id
        JOIN business_event_evidence settle_evidence ON settle_evidence.event_id=fulfillment.id
          AND settle_evidence.evidence_role='FULFILLMENT_EVIDENCE'
        WHERE purchase.scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$1)
          AND purchase.event_type='PURCHASE' AND purchase.resolution_status='CONFIRMED'
          AND prepayment.resolution_status='CONFIRMED' AND fulfillment.resolution_status='CONFIRMED'
          AND (pre_evidence.receipt_id=ANY($2::bigint[]) OR settle_evidence.receipt_id=ANY($2::bigint[]))`,
      [scopeKey, [pair.prepaymentReceiptId, pair.settlementReceiptId]])).rows;
      if (priorLifecycles.length) {
        const exactExisting = priorLifecycles.length === 1
          && Number(priorLifecycles[0].prepayment_receipt_id) === Number(pair.prepaymentReceiptId)
          && Number(priorLifecycles[0].settlement_receipt_id) === Number(pair.settlementReceiptId);
        if (!exactExisting) {
          const error = new Error('A prepayment receipt already belongs to a different confirmed lifecycle');
          error.code = 'PREPAYMENT_LIFECYCLE_CONFLICT';
          throw error;
        }
        continue;
      }
      const base = {
        scopeKey, origin: SYSTEM_DERIVED,
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
      await lockClient.query('COMMIT');
    } catch (error) {
      await lockClient.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    let releaseError;
    if (releaseScopeLock) {
      try { await releaseScopeLock(); } catch (error) { releaseError = error; }
    }
    lockClient.release(releaseError);
  }
  return {
    ...result,
    writeMode: true,
    created,
    persistenceStartAt: configuredStartAt,
    blockedByStartAt,
    confirmedPairs: persistablePairs.map((pair) => ({ prepaymentReceiptId: Number(pair.prepaymentReceiptId), settlementReceiptId: Number(pair.settlementReceiptId), purchaseValue: pair.purchaseValue })),
    blockedManualTopupPairs: blockedManualTopupPairs.map((pair) => ({ prepaymentReceiptId: Number(pair.prepaymentReceiptId), settlementReceiptId: Number(pair.settlementReceiptId), reason: 'RECEIPT_ALREADY_RECORDED_AS_MANUAL_TROIKA_EXPENSE' })),
  };
}

import { BusinessEventGraphRepository, GRAPH_MODEL_VERSION, SYSTEM_DERIVED } from './business-event-graph.js';
import { NORMALIZED_FACT_VERSION } from './prepayment-settlement-matcher.js';

export const STANDALONE_PURCHASE_RULE = 'STANDALONE_PURCHASE_V1';
export const STANDALONE_PURCHASE_VERSION = 'standalone-purchase-v1';

const money = (value) => Number(value ?? 0);
const amount = (value) => money(value).toFixed(2);
const CATEGORY_ORDER = ['ELIGIBLE_STANDALONE', 'EXCLUDED_ALREADY_MULTI_RECEIPT', 'EXCLUDED_PREPAYMENT', 'EXCLUDED_ADVANCE', 'EXCLUDED_MIXED', 'EXCLUDED_CREDIT', 'EXCLUDED_PREPAID_COMPONENT', 'EXCLUDED_ALREADY_PURCHASE', 'OTHER_UNSUPPORTED'];
export const standaloneSemanticKey = (receiptId) => `standalone-purchase:${receiptId}`;

export const STANDALONE_RECEIPTS_SQL = `
SELECT r.id, r.fns_id AS "fnsId", r.date_time AS "dateTime", r.operation_type AS "operationType",
       r.total_sum AS "totalSum", r.currency, f.normalization_status AS "normalizationStatus",
       f.fiscal_operation_type AS "fiscalOperationType", f.payment_stage AS "paymentStage",
       f.cash_total_sum AS "cashTotalSum", f.cash_total_state AS "cashTotalState",
       f.ecash_total_sum AS "ecashTotalSum", f.ecash_total_state AS "ecashTotalState",
       f.prepaid_sum AS "prepaidSum", f.prepaid_state AS "prepaidState",
       f.credit_sum AS "creditSum", f.credit_state AS "creditState",
       f.provision_sum AS "provisionSum", f.provision_state AS "provisionState",
       f.payment_components_status AS "paymentComponentsStatus"
FROM receipts r
JOIN receipt_fiscal_facts f ON f.receipt_id=r.id AND f.normalization_version=$1
WHERE ($2::bigint[] IS NULL OR r.id = ANY($2::bigint[]))
ORDER BY r.id`;

function zeroComponent(value, state) { return Number(value) === 0 && ['PRESENT_VALUE', 'EXPLICIT_ZERO'].includes(state); }
function newMoneyReconciles(row) { return ['PRESENT_VALUE', 'EXPLICIT_ZERO'].includes(row.cashTotalState) && ['PRESENT_VALUE', 'EXPLICIT_ZERO'].includes(row.ecashTotalState) && Math.abs(money(row.cashTotalSum) + money(row.ecashTotalSum) - money(row.totalSum)) < 0.005; }

export function standaloneEligibility(row, { lifecycleReceiptIds = new Set(), purchaseReceiptIds = new Set() } = {}) {
  if (lifecycleReceiptIds.has(String(row.id))) return { category: 'EXCLUDED_ALREADY_MULTI_RECEIPT', reason: 'CONFIRMED_MULTI_RECEIPT_LIFECYCLE' };
  if (purchaseReceiptIds.has(String(row.id))) return { category: 'EXCLUDED_ALREADY_PURCHASE', reason: 'PURCHASE_EVIDENCE_ALREADY_EXISTS' };
  if (row.normalizationStatus !== 'READY' || row.operationType !== 1 || row.fiscalOperationType !== 1 || (row.currency !== null && row.currency !== 'RUB')) return { category: 'OTHER_UNSUPPORTED', reason: 'NORMALIZATION_OPERATION_OR_CURRENCY_NOT_SUPPORTED' };
  if (row.paymentStage === 'PREPAYMENT_ONLY') return { category: 'EXCLUDED_PREPAYMENT', reason: 'PREPAYMENT_STAGE' };
  if (row.paymentStage === 'ADVANCE_ONLY') return { category: 'EXCLUDED_ADVANCE', reason: 'ADVANCE_STAGE' };
  if (row.paymentStage === 'MIXED') return { category: 'EXCLUDED_MIXED', reason: 'MIXED_PAYMENT_STAGE' };
  if (row.creditSum === null || !zeroComponent(row.creditSum, row.creditState)) return { category: 'EXCLUDED_CREDIT', reason: row.creditSum === null ? 'CREDIT_COMPONENT_MISSING' : 'CREDIT_COMPONENT_PRESENT' };
  if (row.prepaidSum === null || !zeroComponent(row.prepaidSum, row.prepaidState)) return { category: 'EXCLUDED_PREPAID_COMPONENT', reason: row.prepaidSum === null ? 'PREPAID_COMPONENT_MISSING' : 'PREPAID_COMPONENT_PRESENT' };
  if (row.provisionSum === null || !zeroComponent(row.provisionSum, row.provisionState)) return { category: 'OTHER_UNSUPPORTED', reason: row.provisionSum === null ? 'PROVISION_COMPONENT_MISSING' : 'PROVISION_COMPONENT_PRESENT' };
  if (row.paymentStage !== 'SETTLEMENT_ONLY' || row.paymentComponentsStatus !== 'RECONCILED' || !newMoneyReconciles(row)) return { category: 'OTHER_UNSUPPORTED', reason: 'FULL_SETTLEMENT_COMPONENTS_NOT_RECONCILED' };
  return { category: 'ELIGIBLE_STANDALONE', reason: 'STRICT_NEW_MONEY_FULL_SETTLEMENT' };
}

async function graphReceiptSets(pool, scopeKey) {
  const [lifecycle, purchases] = await Promise.all([
    pool.query(`SELECT DISTINCT ev.receipt_id
      FROM business_event_evidence ev
      JOIN business_events evidence_event ON evidence_event.id=ev.event_id
      JOIN accounting_scopes scope ON scope.id=evidence_event.scope_id
      WHERE scope.scope_key=$1 AND EXISTS (
        SELECT 1
        FROM business_event_edges edge
        JOIN business_events source ON source.id=edge.source_event_id
        JOIN business_events target ON target.id=edge.target_event_id
        WHERE edge.relation_type IN ('PREPAYMENT_FOR','FULFILLS')
          AND edge.resolution_status='CONFIRMED'
          AND target.event_type='PURCHASE' AND target.resolution_status='CONFIRMED'
          AND source.event_type IN ('PREPAYMENT','FULFILLMENT')
          AND (evidence_event.id=edge.source_event_id OR evidence_event.id=edge.target_event_id)
      )`, [scopeKey]),
    pool.query(`SELECT DISTINCT ev.receipt_id
      FROM business_event_evidence ev
      JOIN business_events event ON event.id=ev.event_id
      JOIN accounting_scopes scope ON scope.id=event.scope_id
      WHERE scope.scope_key=$1 AND event.event_type='PURCHASE'
        AND event.resolution_status='CONFIRMED'`, [scopeKey]),
  ]);
  return { lifecycleReceiptIds: new Set(lifecycle.rows.map((row) => String(row.receipt_id))), purchaseReceiptIds: new Set(purchases.rows.map((row) => String(row.receipt_id))) };
}

export async function standalonePurchaseCensus(pool, { scopeKey = 'default', from = null, to = null } = {}) {
  const [rowsResult, sets] = await Promise.all([pool.query(STANDALONE_RECEIPTS_SQL, [NORMALIZED_FACT_VERSION, null]), graphReceiptSets(pool, scopeKey)]);
  const buckets = new Map(CATEGORY_ORDER.map((category) => [category, { category, count: 0, amount: '0.00', receiptIds: [] }]));
  for (const row of rowsResult.rows) {
    const at = new Date(row.dateTime);
    if ((from && at < new Date(from)) || (to && at >= new Date(to))) continue;
    const eligibility = standaloneEligibility({ ...row, operationType: Number(row.operationType), fiscalOperationType: Number(row.fiscalOperationType) }, sets);
    const bucket = buckets.get(eligibility.category) ?? buckets.get('OTHER_UNSUPPORTED');
    bucket.count += 1; bucket.amount = amount(money(bucket.amount) + money(row.totalSum));
    if (bucket.receiptIds.length < 10) bucket.receiptIds.push({ id: Number(row.id), reason: eligibility.reason });
  }
  return { model: STANDALONE_PURCHASE_RULE, version: STANDALONE_PURCHASE_VERSION, scopeKey, period: { from, to, semantics: 'receipt date_time, half-open [from,to)' }, totalNormalized: [...buckets.values()].reduce((sum, row) => sum + row.count, 0), buckets: [...buckets.values()] };
}

async function persistCandidate(tx, row, scopeKey) {
  await tx.pool.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${STANDALONE_PURCHASE_RULE}:${scopeKey}:${row.id}`]);
  const existing = await tx.pool.query(`SELECT event.id,event.resolution_status FROM business_event_evidence ev JOIN business_events event ON event.id=ev.event_id JOIN accounting_scopes scope ON scope.id=event.scope_id WHERE scope.scope_key=$1 AND ev.receipt_id=$2 AND event.event_type='PURCHASE' AND event.resolution_status='CONFIRMED' LIMIT 1`, [scopeKey, row.id]);
  if (existing.rowCount) return { receiptId: Number(row.id), eventId: Number(existing.rows[0].id), created: false, reused: true };
  const base = { scopeKey, origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: STANDALONE_PURCHASE_RULE, ruleVersion: STANDALONE_PURCHASE_VERSION, resolutionStatus: 'CONFIRMED', amount: amount(row.totalSum), currency: row.currency ?? 'RUB' };
  const event = await tx.createEvent({ ...base, eventType: 'PURCHASE', semanticKey: standaloneSemanticKey(row.id), description: 'Ordinary one-stage full settlement from reconciled new-money components' });
  const evidence = await tx.createEvidenceLink({ ...base, eventId: event.id, receiptId: Number(row.id), normalizationVersion: NORMALIZED_FACT_VERSION, evidenceRole: 'PURCHASE_EVIDENCE' });
  return { receiptId: Number(row.id), eventId: Number(event.id), evidenceId: Number(evidence.id), created: Boolean(event.created), reused: false };
}

export async function persistStandalonePurchases(pool, { scopeKey = 'default', receiptIds = null, ledgerRefresher = null, certificationRefresher = null } = {}) {
  const ids = receiptIds?.map((id) => Number(id)) ?? null;
  const [rowsResult, sets] = await Promise.all([pool.query(STANDALONE_RECEIPTS_SQL, [NORMALIZED_FACT_VERSION, ids]), graphReceiptSets(pool, scopeKey)]);
  const requested = receiptIds ? new Set(receiptIds.map((id) => String(id))) : null;
  const eligible = rowsResult.rows.filter((row) => (!requested || requested.has(String(row.id))) && standaloneEligibility({ ...row, operationType: Number(row.operationType), fiscalOperationType: Number(row.fiscalOperationType) }, sets).category === 'ELIGIBLE_STANDALONE');
  const persisted = await new BusinessEventGraphRepository(pool).withTransaction(async (tx) => {
    const results = [];
    for (const row of eligible) results.push(await persistCandidate(tx, row, scopeKey));
    return results;
  });
  const created = persisted.filter((row) => row.created);
  const propagation = { ledger: 0, certification: 0 };
  for (const row of created) {
    if (ledgerRefresher) {
      const ledger = await ledgerRefresher(row.receiptId);
      propagation.ledger += Number(ledger?.created?.entries ?? 0);
      if (certificationRefresher && ledger?.eventIds?.length) { await certificationRefresher(ledger.eventIds); propagation.certification += ledger.eventIds.length; }
    }
  }
  return { model: STANDALONE_PURCHASE_RULE, candidates: eligible.length, created: created.length, reused: persisted.filter((row) => row.reused).length, purchases: persisted, propagation };
}

import { certificationSourceStateKey } from './certification.js';

export const ACCOUNTING_COVERAGE_MODEL = 'accounting-coverage-gate-v1';
export const COVERAGE_OUTCOMES = Object.freeze([
  'ACCOUNTED_PURCHASE', 'PREPAYMENT_COMPONENT', 'FULFILLMENT_COMPONENT',
  'RETURN', 'REFUND', 'ADVANCE', 'CREDIT_OR_LIABILITY', 'AMBIGUOUS',
  'UNSUPPORTED', 'BLOCKED', 'OTHER_EXPLICIT', 'UNEXPLAINED',
]);

const money = (value) => Number(value ?? 0).toFixed(2);
const byId = (rows = []) => new Map(rows.map((row) => [String(row.id), row]));

function eventIds(events = []) { return events.map((event) => Number(event.eventId)).filter(Number.isInteger).sort((a, b) => a - b); }
function hasEvent(events, type, status = null) { return events.some((event) => event.eventType === type && (!status || event.resolutionStatus === status)); }
function hasRule(events, rule) { return events.some((event) => event.ruleCode === rule); }
function zeroComponent(value, state) { return Number(value) === 0 && ['PRESENT_VALUE', 'EXPLICIT_ZERO'].includes(state); }
function newMoneyReconciles(row) { return ['PRESENT_VALUE', 'EXPLICIT_ZERO'].includes(row.cashTotalState) && ['PRESENT_VALUE', 'EXPLICIT_ZERO'].includes(row.ecashTotalState) && Math.abs(Number(row.cashTotalSum ?? 0) + Number(row.ecashTotalSum ?? 0) - Number(row.totalSum ?? 0)) < 0.005; }

export function classifyCoverageReceipt(row, related = row.related ?? {}) {
  const events = related.events ?? [];
  const certifiedAcquisition = new Set((related.certifiedAcquisitionEventIds ?? []).map(Number));
  const exposure = money(row.totalSum);
  const ids = eventIds(events);
  const base = (outcome, reasonCode, event = null) => ({
    receiptId: Number(row.id), dateTime: row.dateTime, operationType: row.operationType === null ? null : Number(row.operationType),
    paymentStage: row.paymentStage, currency: row.currency ?? null, fiscalCoverageExposure: exposure,
    outcome, reasonCode, ruleCode: event?.ruleCode ?? null, ruleVersion: event?.ruleVersion ?? null, eventIds: ids,
  });

  if (row.normalizationStatus !== 'READY') return base(row.normalizationStatus === 'BLOCKED' ? 'BLOCKED' : 'UNSUPPORTED', 'NORMALIZATION_NOT_READY');
  if (row.operationType === 2 || row.fiscalOperationType === 2 || hasEvent(events, 'RETURN')) return base('RETURN', 'RETURN_OPERATION_OR_EVENT', events.find((event) => event.eventType === 'RETURN') ?? null);
  if (hasEvent(events, 'REFUND')) return base('REFUND', 'REFUND_EVENT', events.find((event) => event.eventType === 'REFUND'));
  if (hasEvent(events, 'FULFILLMENT', 'CONFIRMED') || hasRule(events, 'PREPAYMENT_SETTLEMENT_V1') && row.paymentStage === 'SETTLEMENT_ONLY') return base('FULFILLMENT_COMPONENT', 'CONFIRMED_FULFILLMENT_EVIDENCE', events.find((event) => event.eventType === 'FULFILLMENT') ?? null);
  if (hasEvent(events, 'PREPAYMENT', 'CONFIRMED') || row.paymentStage === 'PREPAYMENT_ONLY' && hasRule(events, 'PREPAYMENT_SETTLEMENT_V1')) return base('PREPAYMENT_COMPONENT', 'CONFIRMED_PREPAYMENT_EVIDENCE', events.find((event) => event.eventType === 'PREPAYMENT') ?? null);
  if (hasEvent(events, 'ADVANCE', 'CONFIRMED') || row.paymentStage === 'ADVANCE_ONLY' && events.length) return base('ADVANCE', 'ADVANCE_EVIDENCE', events.find((event) => event.eventType === 'ADVANCE') ?? null);
  if (hasEvent(events, 'CREDIT', 'CONFIRMED') || hasEvent(events, 'CREDIT_PAYMENT', 'CONFIRMED') || row.paymentStage === 'CREDIT_ONLY' && events.length) return base('CREDIT_OR_LIABILITY', 'CREDIT_EVIDENCE', events.find((event) => ['CREDIT', 'CREDIT_PAYMENT'].includes(event.eventType)) ?? null);
  if (events.some((event) => event.resolutionStatus === 'AMBIGUOUS')) return base('AMBIGUOUS', 'AMBIGUOUS_GRAPH_EVIDENCE');
  if (events.some((event) => event.derivationStatus === 'BLOCKED' || event.ledgerStatus === 'BLOCKED')) return base('BLOCKED', 'BLOCKED_LEDGER_ROUTE');
  if (row.paymentComponentsStatus === 'UNSUPPORTED' || row.paymentStage === 'UNKNOWN' || row.correctionStatus === 'UNSUPPORTED') return base('UNSUPPORTED', 'NORMALIZED_COMBINATION_UNSUPPORTED');
  if (row.paymentStage === 'PREPAYMENT_ONLY') return base('PREPAYMENT_COMPONENT', 'NORMALIZED_PREPAYMENT_COMPONENT');
  if (row.paymentStage === 'ADVANCE_ONLY') return base('ADVANCE', 'NORMALIZED_ADVANCE_COMPONENT');
  if (row.paymentStage === 'CREDIT_ONLY') return base('CREDIT_OR_LIABILITY', 'NORMALIZED_CREDIT_COMPONENT');
  if (row.paymentStage === 'MIXED') return base('UNSUPPORTED', 'NORMALIZED_MIXED_PAYMENT_STAGE');
  if (row.operationType === 3 || row.fiscalOperationType === 3) return base('OTHER_EXPLICIT', 'OPERATION_TYPE_3_EXPLICIT');
  if (events.some((event) => event.eventType === 'PURCHASE' && event.resolutionStatus === 'CONFIRMED' && (event.ruleCode === 'STANDALONE_PURCHASE_V1' || certifiedAcquisition.has(Number(event.eventId)) || event.ruleCode === 'RETURN_REFUND_V1'))) {
    const event = events.find((item) => item.eventType === 'PURCHASE' && item.resolutionStatus === 'CONFIRMED');
    return base('ACCOUNTED_PURCHASE', 'CONFIRMED_PURCHASE_EVIDENCE', event);
  }
  if (!events.length && row.paymentStage === 'SETTLEMENT_ONLY' && row.operationType === 1 && row.fiscalOperationType === 1 && (row.currency === null || row.currency === 'RUB') && row.paymentComponentsStatus === 'RECONCILED' && zeroComponent(row.creditSum, row.creditState) && zeroComponent(row.prepaidSum, row.prepaidState) && zeroComponent(row.provisionSum, row.provisionState) && newMoneyReconciles(row)) return base('UNEXPLAINED', 'MISSING_CONFIRMED_PURCHASE_EVIDENCE');
  if (row.paymentStage === 'SETTLEMENT_ONLY') return base('UNSUPPORTED', 'NORMALIZED_SETTLEMENT_NOT_SUPPORTED');
  if (events.length) return base('OTHER_EXPLICIT', 'EXPLICIT_GRAPH_EVIDENCE', events[0]);
  return base('UNEXPLAINED', 'COVERAGE_UNEXPLAINED_RECEIPT');
}

function aggregate(outcomes) {
  const result = new Map();
  for (const row of outcomes) {
    const key = row.outcome;
    const current = result.get(key) ?? { outcome: key, count: 0, fiscalCoverageExposure: 0 };
    current.count += 1; current.fiscalCoverageExposure += Number(row.fiscalCoverageExposure); result.set(key, current);
  }
  return [...result.values()].map((row) => ({ ...row, fiscalCoverageExposure: money(row.fiscalCoverageExposure) })).sort((a, b) => a.outcome.localeCompare(b.outcome));
}

function matrix(outcomes) {
  const result = new Map();
  for (const row of outcomes) {
    const key = `${row.operationType ?? 'NULL'}|${row.paymentStage ?? 'NULL'}|${row.currency ?? 'NULL'}|${row.outcome}`;
    const current = result.get(key) ?? { operationType: row.operationType, paymentStage: row.paymentStage, currency: row.currency, outcome: row.outcome, count: 0, fiscalCoverageExposure: 0 };
    current.count += 1; current.fiscalCoverageExposure += Number(row.fiscalCoverageExposure); result.set(key, current);
  }
  return [...result.values()].map((row) => ({ ...row, fiscalCoverageExposure: money(row.fiscalCoverageExposure) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function buildCoverageReport(rows, { from = null, to = null, scopeKey = 'default', sourceStateKey = null } = {}) {
  const outcomes = rows.filter((row) => row.normalizationStatus === 'READY' || row.normalizationStatus === 'BLOCKED' || row.normalizationStatus === 'UNSUPPORTED').map((row) => classifyCoverageReceipt(row, row.related));
  const ready = outcomes.filter((row) => rows.find((item) => Number(item.id) === row.receiptId)?.normalizationStatus === 'READY');
  const unexplained = ready.filter((row) => row.outcome === 'UNEXPLAINED');
  const covered = ready.filter((row) => row.outcome !== 'UNEXPLAINED');
  const reasonCodes = [...new Set(unexplained.map((row) => row.reasonCode))].sort();
  // Explicit non-acquisition routes are intentionally unresolved until
  // matching evidence exists; only an otherwise unexplained READY fact is a
  // normalization-to-graph gap.
  const graphGaps = rows.filter((row) => row.normalizationStatus === 'READY'
    && !(row.related?.events ?? []).length
    && classifyCoverageReceipt(row, row.related).outcome === 'UNEXPLAINED').length;
  const ledgerEntries = new Set(rows.flatMap((row) => (row.related?.events ?? []).filter((event) => event.ledgerEntryId != null).map((event) => String(event.eventId))));
  const certificationEvents = new Set(rows.flatMap((row) => (row.related?.certificationEventIds ?? []).map(Number)));
  const certifiedReceipts = new Set(rows.flatMap((row) => row.related?.certifiedAcquisitionEventIds?.length ? [String(row.id)] : []));
  const blockedAcquisitionReceipts = new Set(rows.flatMap((row) => (row.related?.certificationFacts ?? []).some((fact) => fact.metricCode === 'BLOCKED_EXPOSURE' && fact.status === 'BLOCKED') ? [String(row.id)] : []));
  const analyticsReceipts = new Set(rows.flatMap((row) => row.related?.analyticsReceipt ? [String(row.id)] : []));
  const confirmedPurchaseReceipts = new Set(rows.flatMap((row) => (row.related?.events ?? []).some((event) => event.eventType === 'PURCHASE' && event.resolutionStatus === 'CONFIRMED') ? [String(row.id)] : []));
  const ledgerReceipts = new Set(rows.flatMap((row) => (row.related?.events ?? []).some((event) => event.ledgerEntryId != null) ? [String(row.id)] : []));
  const missingCertification = [...ledgerReceipts].filter((id) => {
    const row = rows.find((item) => String(item.id) === id);
    return !(row?.related?.certificationEventIds ?? []).length;
  }).length;
  const missingCertifiedAcquisition = [...confirmedPurchaseReceipts].filter((id) => !certifiedReceipts.has(id) && !blockedAcquisitionReceipts.has(id)).length;
  const missingAnalytics = [...certifiedReceipts].filter((id) => !analyticsReceipts.has(id)).length;
  return {
    model: ACCOUNTING_COVERAGE_MODEL, scopeKey, sourceStateKey, period: { from, to, semantics: 'receipt date_time, half-open [from,to)' },
    totals: { readyReceipts: ready.length, explained: covered.length, unexplained: unexplained.length, fiscalCoverageExposure: money(ready.reduce((sum, row) => sum + Number(row.fiscalCoverageExposure), 0)), unexplainedExposure: money(unexplained.reduce((sum, row) => sum + Number(row.fiscalCoverageExposure), 0)) },
    gate: { status: unexplained.length ? 'FAIL' : 'PASS', reasonCodes, hardFail: Boolean(unexplained.length) },
    outcomes: aggregate(ready), matrix: matrix(ready), receiptOutcomes: outcomes,
    layerChecks: { sourceToNormalization: { ready: ready.length, explicitNonReady: rows.filter((row) => row.normalizationStatus !== 'READY').length }, normalizationToGraph: { readyWithoutReceiptEvidence: graphGaps }, graphToLedger: { confirmedEventsWithoutLedger: rows.reduce((sum, row) => sum + (row.related?.events ?? []).filter((event) => event.resolutionStatus === 'CONFIRMED' && event.ledgerEntryId == null).length, 0) }, ledgerToCertification: { ledgerReceipts: ledgerReceipts.size, receiptsWithCertification: [...ledgerReceipts].filter((id) => (rows.find((item) => String(item.id) === id)?.related?.certificationEventIds ?? []).length).length, missingCertification, confirmedPurchaseReceipts: confirmedPurchaseReceipts.size, certifiedAcquisitionReceipts: certifiedReceipts.size, missingCertifiedAcquisition }, certificationToAnalytics: { certifiedAcquisitionReceipts: certifiedReceipts.size, analyticsReceipts: analyticsReceipts.size, missingAnalytics } },
  };
}

export function compareCoverageReports(baseline, candidate, { allowlist = [] } = {}) {
  const oldRows = new Map((baseline.receiptOutcomes ?? []).map((row) => [String(row.receiptId), row])); const newRows = new Map((candidate.receiptOutcomes ?? []).map((row) => [String(row.receiptId), row]));
  const ids = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort((a, b) => Number(a) - Number(b));
  const allowed = (oldRow, newRow) => allowlist.some((item) => String(item.receiptId) === String(newRow?.receiptId ?? oldRow?.receiptId) && item.oldOutcome === oldRow?.outcome && item.newOutcome === newRow?.outcome);
  const transitions = new Map(); const failures = [];
  if (baseline.sourceStateKey && candidate.sourceStateKey && baseline.sourceStateKey !== candidate.sourceStateKey) failures.push({ code: 'COVERAGE_SOURCE_SNAPSHOT_MISMATCH' });
  for (const id of ids) {
    const oldRow = oldRows.get(id); const newRow = newRows.get(id); const oldOutcome = oldRow?.outcome ?? 'ABSENT'; const newOutcome = newRow?.outcome ?? 'ABSENT';
    const key = `${oldOutcome} -> ${newOutcome}`; transitions.set(key, (transitions.get(key) ?? 0) + 1);
    if (newOutcome === 'UNEXPLAINED') failures.push({ code: 'COVERAGE_UNEXPLAINED_RECEIPT', receiptId: Number(id), oldOutcome, newOutcome });
    if (oldOutcome === 'ACCOUNTED_PURCHASE' && ['UNEXPLAINED', 'UNSUPPORTED', 'AMBIGUOUS', 'BLOCKED'].includes(newOutcome) && !allowed(oldRow, newRow)) failures.push({ code: newOutcome === 'UNEXPLAINED' ? 'COVERAGE_ACCOUNTED_REGRESSION' : 'COVERAGE_UNREVIEWED_TRANSITION', receiptId: Number(id), oldOutcome, newOutcome });
  }
  const oldClasses = new Set((baseline.matrix ?? []).filter((row) => row.count > 0).map((row) => `${row.operationType}|${row.paymentStage}`));
  const newClasses = new Set((candidate.matrix ?? []).filter((row) => row.count > 0).map((row) => `${row.operationType}|${row.paymentStage}`));
  for (const classKey of oldClasses) if (!newClasses.has(classKey)) failures.push({ code: 'COVERAGE_CLASS_DISAPPEARED', classKey });
  return { model: ACCOUNTING_COVERAGE_MODEL, status: failures.length ? 'FAIL' : 'PASS', reasonCodes: [...new Set(failures.map((row) => row.code))].sort(), transitions: [...transitions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([transition, count]) => ({ transition, count })), failures, baseline: baseline.totals, candidate: candidate.totals };
}

export async function loadCoverageRows(pool, { scopeKey = 'default', from = null, to = null, sourceId = null } = {}) {
  const scope = (await pool.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
  if (!scope) throw new Error(`Accounting scope not found: ${scopeKey}`);
  const params = [from, to, sourceId];
  const receipts = (await pool.query(`SELECT r.id, r.date_time AS "dateTime", r.operation_type AS "operationType", r.total_sum AS "totalSum", r.currency,
      f.normalization_status AS "normalizationStatus", f.fiscal_operation_type AS "fiscalOperationType", f.payment_stage AS "paymentStage",
      f.payment_components_status AS "paymentComponentsStatus", f.correction_status AS "correctionStatus", f.normalization_version AS "normalizationVersion",
      f.cash_total_sum AS "cashTotalSum", f.cash_total_state AS "cashTotalState", f.ecash_total_sum AS "ecashTotalSum", f.ecash_total_state AS "ecashTotalState",
      f.prepaid_sum AS "prepaidSum", f.prepaid_state AS "prepaidState", f.credit_sum AS "creditSum", f.credit_state AS "creditState",
      f.provision_sum AS "provisionSum", f.provision_state AS "provisionState"
    FROM receipts r JOIN LATERAL (SELECT f.* FROM receipt_fiscal_facts f WHERE f.receipt_id=r.id ORDER BY f.normalized_at DESC LIMIT 1) f ON true
    WHERE ($1::timestamptz IS NULL OR r.date_time >= $1)
      AND ($2::timestamptz IS NULL OR r.date_time < $2)
      AND ($3::bigint IS NULL OR EXISTS (
        SELECT 1 FROM fns_source_receipt_refs sr
        WHERE sr.fns_source_id=$3 AND sr.receipt_id=r.id
      ))
    ORDER BY r.id`, params)).rows;
  const ids = receipts.map((row) => Number(row.id));
  if (!ids.length) return [];
  const currentSourceStateKey = await certificationSourceStateKey(pool, Number(scope.id));
  const events = (await pool.query(`SELECT ev.receipt_id AS "receiptId", e.id AS "eventId", e.event_type AS "eventType", e.resolution_status AS "resolutionStatus", e.rule_code AS "ruleCode", e.rule_version AS "ruleVersion", le.id AS "ledgerEntryId", le.derivation_status AS "derivationStatus", le.reason_code AS "ledgerReason"
    FROM business_event_evidence ev JOIN business_events e ON e.id=ev.event_id LEFT JOIN LATERAL (SELECT le.* FROM ledger_entries le WHERE le.source_event_id=e.id
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=le.scope_id AND s.superseded_ledger_entry_id=le.id)
      ORDER BY le.created_at DESC, le.id DESC LIMIT 1) le ON true
    WHERE e.scope_id=$1 AND ev.receipt_id=ANY($2::bigint[]) ORDER BY ev.receipt_id,e.id`, [scope.id, ids])).rows;
  const certifications = (await pool.query(`SELECT f.business_event_id AS "businessEventId", f.metric_code AS "metricCode", f.status, f.reason_code AS "reasonCode", f.source_state_key AS "sourceStateKey"
    FROM certification_facts f
    WHERE f.scope_id=$1
      AND f.business_event_id IN (SELECT DISTINCT ev.event_id FROM business_event_evidence ev WHERE ev.receipt_id=ANY($2::bigint[]))
      AND f.source_state_key=$3
      AND (f.ledger_entry_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM ledger_entry_supersessions s
        WHERE s.scope_id=f.scope_id AND s.superseded_ledger_entry_id=f.ledger_entry_id
      ))`, [scope.id, ids, currentSourceStateKey])).rows;
  const analytics = (await pool.query(`SELECT receipt_id AS "receiptId" FROM analytics_purchases WHERE receipt_id=ANY($1::bigint[]) AND status='CERTIFIED'`, [ids])).rows;
  const eventMap = new Map(); for (const event of events) eventMap.set(String(event.receiptId), [...(eventMap.get(String(event.receiptId)) ?? []), event]);
  const certMap = new Map(); for (const item of certifications) certMap.set(String(item.businessEventId), [...(certMap.get(String(item.businessEventId)) ?? []), item]);
  const analyticsSet = new Set(analytics.map((row) => String(row.receiptId)));
  return receipts.map((row) => {
    const receiptEvents = eventMap.get(String(row.id)) ?? [];
    const facts = receiptEvents.flatMap((event) => certMap.get(String(event.eventId)) ?? []);
    return { ...row, related: { events: receiptEvents, certificationFacts: facts, certificationEventIds: [...new Set(facts.map((fact) => Number(fact.businessEventId)))], certifiedAcquisitionEventIds: [...new Set(facts.filter((fact) => fact.metricCode === 'CONFIRMED_ACQUISITION_VALUE' && fact.status === 'CERTIFIED').map((fact) => Number(fact.businessEventId)))], analyticsReceipt: analyticsSet.has(String(row.id)) } };
  });
}

export async function accountingCoverageReport(pool, options = {}) {
  const rows = await loadCoverageRows(pool, options);
  return buildCoverageReport(rows, options);
}

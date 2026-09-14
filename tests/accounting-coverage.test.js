import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverageReport, classifyCoverageReceipt, compareCoverageReports, loadCoverageRows } from '../src/accounting-coverage.js';

const row = (overrides = {}) => ({ id: 1, dateTime: '2026-08-01T10:00:00Z', operationType: 1, fiscalOperationType: 1, totalSum: '100.00', currency: 'RUB', normalizationStatus: 'READY', paymentStage: 'SETTLEMENT_ONLY', paymentComponentsStatus: 'RECONCILED', correctionStatus: 'NORMAL', cashTotalSum: '100.00', cashTotalState: 'PRESENT_VALUE', ecashTotalSum: '0.00', ecashTotalState: 'EXPLICIT_ZERO', prepaidSum: '0.00', prepaidState: 'EXPLICIT_ZERO', creditSum: '0.00', creditState: 'EXPLICIT_ZERO', provisionSum: '0.00', provisionState: 'EXPLICIT_ZERO', related: { events: [], certifiedAcquisitionEventIds: [] }, ...overrides });
const event = (overrides = {}) => ({ eventId: 10, eventType: 'PURCHASE', resolutionStatus: 'CONFIRMED', ruleCode: 'STANDALONE_PURCHASE_V1', ruleVersion: 'v1', derivationStatus: 'READY', ...overrides });

test('READY ordinary standalone routes to ACCOUNTED_PURCHASE', () => assert.equal(classifyCoverageReceipt(row({ related: { events: [event()], certifiedAcquisitionEventIds: [10] } })).outcome, 'ACCOUNTED_PURCHASE'));
test('READY prepayment and fulfillment are explicit components', () => {
  assert.equal(classifyCoverageReceipt(row({ paymentStage: 'PREPAYMENT_ONLY', related: { events: [event({ eventType: 'PREPAYMENT', ruleCode: 'PREPAYMENT_SETTLEMENT_V1' })] } })).outcome, 'PREPAYMENT_COMPONENT');
  assert.equal(classifyCoverageReceipt(row({ paymentStage: 'SETTLEMENT_ONLY', related: { events: [event({ eventType: 'FULFILLMENT', ruleCode: 'PREPAYMENT_SETTLEMENT_V1' })] } })).outcome, 'FULFILLMENT_COMPONENT');
});
test('return, unsupported and ambiguous are never silently omitted', () => {
  assert.equal(classifyCoverageReceipt(row({ operationType: 2, fiscalOperationType: 2 })).outcome, 'RETURN');
  assert.equal(classifyCoverageReceipt(row({ paymentStage: 'UNKNOWN', paymentComponentsStatus: 'UNSUPPORTED' })).outcome, 'UNSUPPORTED');
  assert.equal(classifyCoverageReceipt(row({ related: { events: [event({ resolutionStatus: 'AMBIGUOUS' })] } })).outcome, 'AMBIGUOUS');
});
test('READY without route is UNEXPLAINED and gate fails', () => {
  const report = buildCoverageReport([row()]);
  assert.equal(report.gate.status, 'FAIL'); assert.equal(report.totals.unexplained, 1); assert.equal(report.gate.reasonCodes[0], 'MISSING_CONFIRMED_PURCHASE_EVIDENCE');
});
test('blocked ledger and certification are explicit outcomes, not layer gaps', () => {
  const report = buildCoverageReport([row({ id: 83, related: {
    events: [event({ ledgerEntryId: 115, derivationStatus: 'BLOCKED', ledgerReason: 'NO_SUPPORTED_NEW_MONEY_COMPONENT' })],
    certificationEventIds: [10], certifiedAcquisitionEventIds: [],
    certificationFacts: [{ metricCode: 'BLOCKED_EXPOSURE', status: 'BLOCKED' }],
  } })]);
  assert.equal(report.receiptOutcomes[0].outcome, 'BLOCKED');
  assert.equal(report.layerChecks.graphToLedger.confirmedEventsWithoutLedger, 0);
  assert.equal(report.layerChecks.ledgerToCertification.missingCertification, 0);
  assert.equal(report.layerChecks.ledgerToCertification.missingCertifiedAcquisition, 0);
});
test('explicit non-acquisition routes do not count as normalization-to-graph gaps', () => {
  const explicit = (paymentStage, operationType = 1) => row({
    operationType,
    fiscalOperationType: operationType,
    paymentStage,
    related: { events: [], certificationFacts: [], certifiedAcquisitionEventIds: [] },
  });
  const report = buildCoverageReport([
    explicit('ADVANCE_ONLY'),
    explicit('PREPAYMENT_ONLY'),
    explicit('SETTLEMENT_ONLY', 2),
    explicit('UNKNOWN'),
  ]);
  assert.equal(report.layerChecks.normalizationToGraph.readyWithoutReceiptEvidence, 0);
});
test('confirmed graph event without a ledger entry remains an unexpected graph-to-ledger gap', () => {
  const report = buildCoverageReport([row({ related: { events: [event({ ledgerEntryId: null, derivationStatus: null })], certificationEventIds: [], certifiedAcquisitionEventIds: [] } })]);
  assert.equal(report.layerChecks.graphToLedger.confirmedEventsWithoutLedger, 1);
});
test('accounted to unexplained/unsupported regressions fail unless explicitly allowlisted', () => {
  const oldReport = buildCoverageReport([row({ related: { events: [event()], certifiedAcquisitionEventIds: [10] } })]);
  const newReport = buildCoverageReport([row()]);
  assert.equal(compareCoverageReports(oldReport, newReport).status, 'FAIL');
  assert.equal(compareCoverageReports(oldReport, newReport, { allowlist: [{ receiptId: 1, oldOutcome: 'ACCOUNTED_PURCHASE', newOutcome: 'UNEXPLAINED', reason: 'reviewed', modelVersion: 'v2' }] }).status, 'FAIL');
  const unsupported = buildCoverageReport([row({ paymentComponentsStatus: 'UNSUPPORTED' })]);
  assert.equal(compareCoverageReports(oldReport, unsupported, { allowlist: [{ receiptId: 1, oldOutcome: 'ACCOUNTED_PURCHASE', newOutcome: 'UNSUPPORTED', reason: 'reviewed', modelVersion: 'v2' }] }).status, 'PASS');
});
test('historical standalone omission fails even when downstream state is otherwise represented', () => {
  const report = buildCoverageReport(Array.from({ length: 12 }, (_, index) => row({ id: index + 1 })));
  assert.equal(report.gate.status, 'FAIL');
  assert.equal(report.totals.unexplained, 12);
  assert.equal(report.totals.unexplainedExposure, '1200.00');
});
test('same snapshot comparison is deterministic and detects class disappearance', () => {
  const oldReport = buildCoverageReport([row({ related: { events: [event()], certifiedAcquisitionEventIds: [10] } })]);
  const sameReport = buildCoverageReport([row({ related: { events: [event()], certifiedAcquisitionEventIds: [10] } })]);
  assert.equal(compareCoverageReports(oldReport, sameReport).status, 'PASS');
  assert.equal(compareCoverageReports({ ...oldReport, sourceStateKey: 'a' }, { ...sameReport, sourceStateKey: 'b' }).status, 'FAIL');
  const changed = buildCoverageReport([row({ paymentStage: 'UNKNOWN', paymentComponentsStatus: 'UNSUPPORTED' })]);
  const diff = compareCoverageReports(oldReport, changed);
  assert.equal(diff.status, 'FAIL');
  assert.ok(diff.reasonCodes.includes('COVERAGE_UNREVIEWED_TRANSITION'));
});
test('deterministic rerun, currency and scope dimensions remain explicit', () => {
  const rows = [row({ id: 1, currency: 'RUB' }), row({ id: 2, currency: 'USD', related: { events: [event()], certifiedAcquisitionEventIds: [10] } })];
  const first = buildCoverageReport(rows, { scopeKey: 'scope-a' });
  const second = buildCoverageReport(rows, { scopeKey: 'scope-a' });
  assert.deepEqual(first, second);
  assert.equal(new Set(first.matrix.map((item) => item.currency)).size, 2);
  assert.equal(first.scopeKey, 'scope-a');
});

test('source-scoped coverage filters receipts through resolved source references', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (calls.length === 1) return { rows: [{ id: 7 }] };
    return { rows: [] };
  } };
  const rows = await loadCoverageRows(pool, { scopeKey: 'default', sourceId: 202 });
  assert.deepEqual(rows, []);
  assert.equal(calls[1].params[2], 202);
  assert.match(calls[1].sql, /fns_source_receipt_refs/);
  assert.match(calls[1].sql, /sr\.fns_source_id=\$3/);
});
test('Xiaomi has one economic purchase and period is half-open', () => {
  const xiaomi = row({ id: 62, totalSum: '32380.00', related: { events: [event()], certifiedAcquisitionEventIds: [10] } });
  const report = buildCoverageReport([xiaomi], { from: '2026-08-01T00:00:00+03', to: '2026-09-01T00:00:00+03' });
  assert.equal(report.totals.readyReceipts, 1); assert.equal(report.totals.fiscalCoverageExposure, '32380.00'); assert.match(report.period.semantics, /half-open/);
});

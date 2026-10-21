import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCertificationFacts, certificationResultSemanticKey, deriveCertificationFacts, summarizeCertificationTotals } from '../src/certification.js';

const base = (id, rule, status = 'READY', amount = '100.00') => ({ id, scope_id: 1, source_event_id: id, derivation_rule: rule, derivation_status: status, currency: 'RUB', event_at: '2026-01-01T00:00:00Z', event_amount: amount });
const posting = (entry, code, debit, credit) => ({ ledger_entry_id: entry, account_code: code, debit, credit });
const link = (entry, event = entry) => ({ ledger_entry_id: entry, graph_evidence_id: event, event_id: event });

test('Xiaomi-like prepayment and fulfillment do not double count acquisition', () => {
  const facts = deriveCertificationFacts({
    sourceStateKey: 'a'.repeat(64),
    entries: [base(1, 'LEDGER_PREPAYMENT_V1', 'READY', '32380.00'), base(2, 'LEDGER_FULFILLMENT_V1', 'READY', '32380.00')],
    postings: [posting(1, 'MERCHANT_ADVANCE', '32380.00', '0'), posting(1, 'FISCAL_PAYMENT_CLEARING', '0', '32380.00'), posting(2, 'UNCLASSIFIED_ACQUISITION', '32380.00', '0'), posting(2, 'MERCHANT_ADVANCE', '0', '32380.00')],
    links: [link(1), link(2)],
  });
  assert.equal(facts.filter((fact) => fact.metricCode === 'CONFIRMED_ACQUISITION_VALUE').reduce((sum, fact) => sum + Number(fact.amount), 0), 32380);
  assert.equal(facts.filter((fact) => fact.metricCode === 'FISCAL_NEW_MONEY').reduce((sum, fact) => sum + Number(fact.amount), 0), 32380);
});

test('return without refund certifies receivable but not incoming cash', () => {
  const facts = deriveCertificationFacts({ sourceStateKey: 'b'.repeat(64), entries: [base(3, 'LEDGER_RETURN_V1')], postings: [posting(3, 'MERCHANT_REFUND_RECEIVABLE', '100.00', '0'), posting(3, 'UNCLASSIFIED_ACQUISITION', '0', '100.00')], links: [link(3)] });
  assert.equal(facts.find((fact) => fact.metricCode === 'CONFIRMED_RETURN_VALUE').status, 'CERTIFIED');
  assert.equal(facts.find((fact) => fact.metricCode === 'OUTSTANDING_REFUND_RECEIVABLE').amount, '100.00');
  assert.equal(facts.some((fact) => fact.metricCode === 'REFUND_CASH_RECEIVED' && fact.status === 'CERTIFIED'), false);
});

test('blocked ledger entry becomes blocked exposure and cannot certify a metric', () => {
  const facts = deriveCertificationFacts({ sourceStateKey: 'c'.repeat(64), entries: [base(4, 'LEDGER_RETURN_V1', 'BLOCKED', '250.00')], postings: [], links: [link(4)] });
  assert.deepEqual(facts.map((fact) => [fact.metricCode, fact.status, fact.amount]), [['BLOCKED_EXPOSURE', 'BLOCKED', '250.00']]);
});

test('period filtering and scope are deterministic', () => {
  const facts = deriveCertificationFacts({ sourceStateKey: 'd'.repeat(64), from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', entries: [base(5, 'LEDGER_FULFILLMENT_V1', 'READY', '10.00'), { ...base(6, 'LEDGER_FULFILLMENT_V1', 'READY', '20.00'), event_at: '2026-03-01T00:00:00Z' }], postings: [posting(5, 'UNCLASSIFIED_ACQUISITION', '10.00', '0'), posting(6, 'UNCLASSIFIED_ACQUISITION', '20.00', '0')], links: [link(5), link(6)] });
  assert.deepEqual([...new Set(facts.map((fact) => fact.subjectId))], [5]);
  const unbounded = deriveCertificationFacts({ sourceStateKey: 'd'.repeat(64), entries: [base(5, 'LEDGER_FULFILLMENT_V1', 'READY', '10.00')], postings: [posting(5, 'UNCLASSIFIED_ACQUISITION', '10.00', '0')], links: [link(5)] });
  assert.notEqual(facts[0].semanticKey, unbounded[0].semanticKey);
});

test('facts preserve scope and never claim bank certification from clearing', () => {
  const facts = deriveCertificationFacts({ sourceStateKey: 'e'.repeat(64), entries: [{ ...base(7, 'LEDGER_PREPAYMENT_V1'), scope_id: 9 }], postings: [posting(7, 'FISCAL_PAYMENT_CLEARING', '0', '100.00')], links: [link(7)] });
  assert.equal(facts[0].scopeId, 9);
  assert.equal(facts[0].metricCode, 'FISCAL_NEW_MONEY');
  assert.equal(facts[0].status, 'PROVISIONAL');
  assert.equal(facts.some((fact) => /BANK|CARD|CASH_ACCOUNT/.test(fact.metricCode) && fact.status === 'CERTIFIED'), false);
});

test('confirmed manual Troika top-ups certify one transport acquisition without fiscal-new-money facts', () => {
  const entry = {
    ...base(31, 'MANUAL_TROIKA_TOPUP_EXPENSE_V1', 'READY', '21.00'),
    origin: 'MANUAL',
    derivation_version: 'v1',
    certification_status: 'BUSINESS_CONFIRMED',
    reason_code: 'USER_CONFIRMED_TROIKA_TOPUP',
    event_type: 'PURCHASE',
    event_resolution_status: 'CONFIRMED',
    event_origin: 'MANUAL',
    event_graph_model_version: 'business-graph-v1',
    event_rule_code: 'MANUAL_TROIKA_TOPUP_EXPENSE_V1',
    event_rule_version: 'v1',
    manual_troika_topup_id: 5,
    manual_troika_financial_account_id: 2,
    manual_troika_person_id: 1,
    manual_troika_provider: 'ru.alfabank.mobile.android',
    manual_troika_category_code: 'PUBLIC_TRANSPORT',
    manual_troika_amount: '21.00',
    manual_troika_currency: 'RUB',
    manual_troika_provenance: 'USER_CONFIRMED',
  };
  const postings = [
    { ...posting(31, 'EXPENSE:PUBLIC_TRANSPORT', '21.00', '0.00'), currency: 'RUB', account_type: 'EXPENSE', financial_account_id: null },
    { ...posting(31, 'FINANCIAL_ACCOUNT:2', '0.00', '21.00'), currency: 'RUB', account_type: 'ASSET', financial_account_id: 2 },
  ];
  const facts = deriveCertificationFacts({ sourceStateKey: 't'.repeat(64), entries: [entry], postings, links: [] });
  assert.deepEqual(facts.map(({ metricCode, dimension, status, amount, reasonCode }) => [metricCode, dimension, status, amount, reasonCode]), [
    ['CONFIRMED_ACQUISITION_VALUE', 'BUSINESS_CERTIFICATION', 'CERTIFIED', '21.00', 'USER_CONFIRMED_TROIKA_TOPUP'],
    ['ACQUISITION_CLASSIFICATION', 'CLASSIFICATION_CERTIFICATION', 'CERTIFIED', '21.00', 'PUBLIC_TRANSPORT'],
  ]);
  assert.equal(facts.some((fact) => fact.metricCode === 'FISCAL_NEW_MONEY'), false);
});

test('manual Troika certification fails closed when the ledger account or category proof conflicts', () => {
  const entry = {
    ...base(32, 'MANUAL_TROIKA_TOPUP_EXPENSE_V1', 'READY', '34.00'),
    origin: 'MANUAL', derivation_version: 'v1', certification_status: 'BUSINESS_CONFIRMED', reason_code: 'USER_CONFIRMED_TROIKA_TOPUP',
    event_type: 'PURCHASE', event_resolution_status: 'CONFIRMED', event_origin: 'MANUAL', event_graph_model_version: 'business-graph-v1',
    event_rule_code: 'MANUAL_TROIKA_TOPUP_EXPENSE_V1', event_rule_version: 'v1', manual_troika_topup_id: 6,
    manual_troika_financial_account_id: 2, manual_troika_person_id: 1, manual_troika_provider: 'ru.alfabank.mobile.android',
    manual_troika_category_code: 'PUBLIC_TRANSPORT', manual_troika_amount: '34.00', manual_troika_currency: 'RUB', manual_troika_provenance: 'USER_CONFIRMED',
  };
  const facts = deriveCertificationFacts({ sourceStateKey: 'u'.repeat(64), entries: [entry], postings: [
    { ...posting(32, 'EXPENSE:OTHER', '34.00', '0.00'), currency: 'RUB', account_type: 'EXPENSE', financial_account_id: null },
    { ...posting(32, 'FINANCIAL_ACCOUNT:3', '0.00', '34.00'), currency: 'RUB', account_type: 'ASSET', financial_account_id: 3 },
  ], links: [] });
  assert.deepEqual(facts.map(({ metricCode, status, reasonCode }) => [metricCode, status, reasonCode]), [['BLOCKED_EXPOSURE', 'BLOCKED', 'MANUAL_TROIKA_TOPUP_PROOF_INVALID']]);
});

test('certification aggregates keep currencies separate and preserve result identity inputs', () => {
  const results = aggregateCertificationFacts([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '10.00', currency: 'RUB' },
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '10.00', currency: 'USD' },
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '5.00', currency: 'RUB' },
  ]);
  assert.deepEqual(results.map((row) => [row.currency, row.amount, row.countItems]), [['RUB', '15.00', 2], ['USD', '10.00', 1]]);
  assert.notEqual(results[0].semanticKey, results[1].semanticKey);
});



test('certification money uses exact minor units for pennies and large NUMERIC(18,2) values', () => {
  const results = aggregateCertificationFacts([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '9000000000000000.01', currency: 'RUB' },
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '0.98', currency: 'RUB' },
  ]);
  assert.deepEqual(results, [{
    metricCode: 'CONFIRMED_ACQUISITION_VALUE',
    status: 'CERTIFIED',
    amount: '9000000000000000.99',
    currency: 'RUB',
    countItems: 2,
    reasonCode: 'BUSINESS_GRAPH_CONFIRMED',
    semanticKey: results[0].semanticKey,
  }]);
});

test('certification refund arithmetic preserves cents and separates currencies', () => {
  const results = aggregateCertificationFacts([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '10.01', currency: 'RUB' },
    { metricCode: 'CONFIRMED_RETURN_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '0.02', currency: 'RUB' },
    { metricCode: 'CONFIRMED_RETURN_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '0.02', currency: 'USD' },
  ]);
  assert.equal(results.find((row) => row.metricCode === 'CONFIRMED_ACQUISITION_VALUE').amount, '10.01');
  assert.equal(results.find((row) => row.metricCode === 'CONFIRMED_RETURN_VALUE' && row.currency === 'RUB').amount, '0.02');
  assert.equal(results.find((row) => row.metricCode === 'CONFIRMED_RETURN_VALUE' && row.currency === 'USD').amount, '0.02');
});

test('same source-state inputs keep deterministic certification identity', () => {
  const facts = deriveCertificationFacts({
    sourceStateKey: 'a'.repeat(64),
    entries: [base(20, 'LEDGER_FULFILLMENT_V1', 'READY', '0.01')],
    postings: [posting(20, 'UNCLASSIFIED_ACQUISITION', '0.01', '0')],
    links: [link(20)],
  });
  const repeated = deriveCertificationFacts({
    sourceStateKey: 'a'.repeat(64),
    entries: [base(20, 'LEDGER_FULFILLMENT_V1', 'READY', '0.01')],
    postings: [posting(20, 'UNCLASSIFIED_ACQUISITION', '0.01', '0')],
    links: [link(20)],
  });
  const changed = deriveCertificationFacts({
    sourceStateKey: 'b'.repeat(64),
    entries: [base(20, 'LEDGER_FULFILLMENT_V1', 'READY', '0.01')],
    postings: [posting(20, 'UNCLASSIFIED_ACQUISITION', '0.01', '0')],
    links: [link(20)],
  });
  assert.equal(facts[0].amount, '0.01');
  assert.equal(facts[0].semanticKey, repeated[0].semanticKey);
  assert.notEqual(facts[0].semanticKey, changed[0].semanticKey);
});


test('aggregate projection identity is separate from persisted result identity', () => {
  const [aggregate] = aggregateCertificationFacts([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', status: 'CERTIFIED', reasonCode: 'BUSINESS_GRAPH_CONFIRMED', amount: '10.01', currency: 'RUB' },
  ]);
  const persisted = certificationResultSemanticKey({
    metricCode: aggregate.metricCode,
    status: aggregate.status,
    amount: aggregate.amount,
    currency: aggregate.currency,
    countItems: aggregate.countItems,
    reasonCode: aggregate.reasonCode,
  }, 123);
  assert.equal(persisted, certificationResultSemanticKey({
    metricCode: aggregate.metricCode,
    status: aggregate.status,
    amount: '10.01',
    currency: 'RUB',
    countItems: 1,
    reasonCode: 'BUSINESS_GRAPH_CONFIRMED',
  }, 123));
  assert.notEqual(aggregate.semanticKey, persisted);
});

test('certification report totals fail closed across currencies and preserve mono-currency contract', () => {
  const baseline = summarizeCertificationTotals([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', amount: '10.01', currency: 'RUB' },
    { metricCode: 'CONFIRMED_RETURN_VALUE', amount: '0.01', currency: 'RUB' },
  ]);
  assert.equal(baseline.netConfirmedAcquisition.amount, '10.00');
  assert.equal(baseline.netConfirmedAcquisition.status, 'CERTIFIED');

  const zeroReturns = summarizeCertificationTotals([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', amount: '10.01', currency: 'RUB' },
  ]);
  assert.equal(zeroReturns.confirmedReturnValue.amount, '0.00');
  assert.equal(zeroReturns.netConfirmedAcquisition.amount, '10.01');
  assert.equal(zeroReturns.netConfirmedAcquisition.status, 'CERTIFIED');

  const mixedGross = summarizeCertificationTotals([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', amount: '10.01', currency: 'RUB' },
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', amount: '2.00', currency: 'USD' },
  ]);
  assert.equal(mixedGross.confirmedAcquisitionValue.amount, null);
  assert.equal(mixedGross.confirmedAcquisitionValue.status, 'BLOCKED');
  assert.equal(mixedGross.netConfirmedAcquisition.amount, null);
  assert.equal(mixedGross.netConfirmedAcquisition.reason, 'MULTI_CURRENCY_REQUIRES_SEPARATE_REPORT');

  const mixedReturns = summarizeCertificationTotals([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', amount: '10.01', currency: 'RUB' },
    { metricCode: 'CONFIRMED_RETURN_VALUE', amount: '2.00', currency: 'RUB' },
    { metricCode: 'CONFIRMED_RETURN_VALUE', amount: '1.00', currency: 'USD' },
  ]);
  assert.equal(mixedReturns.confirmedReturnValue.amount, null);
  assert.equal(mixedReturns.confirmedReturnValue.status, 'BLOCKED');
  assert.equal(mixedReturns.netConfirmedAcquisition.amount, null);
  assert.equal(mixedReturns.netConfirmedAcquisition.status, 'BLOCKED');

  const crossMetric = summarizeCertificationTotals([
    { metricCode: 'CONFIRMED_ACQUISITION_VALUE', amount: '10.01', currency: 'RUB' },
    { metricCode: 'CONFIRMED_RETURN_VALUE', amount: '2.00', currency: 'USD' },
  ]);
  assert.equal(crossMetric.netConfirmedAcquisition.amount, null);
  assert.equal(crossMetric.netConfirmedAcquisition.status, 'BLOCKED');
  assert.equal(crossMetric.netConfirmedAcquisition.reason, 'MULTI_CURRENCY_REQUIRES_SEPARATE_REPORT');
});

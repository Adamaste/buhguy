import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSupportedMetric, buildAnalyticsSummary, buildAnalyticsTrace, buildBlockedBreakdown } from '../src/analytics.js';

const fact = (metricCode, amount, status, extra = {}) => ({ metricCode, amount: String(amount), status, currency: 'RUB', eventAt: extra.eventAt ?? '2026-01-01T00:00:00Z', reasonCode: extra.reasonCode ?? null, ruleCode: 'rule', ruleVersion: 'v1', ledgerEntryId: extra.ledgerEntryId ?? 1, businessEventId: extra.businessEventId ?? 1, graphEvidenceId: extra.graphEvidenceId ?? 1, sourceStateKey: 'a'.repeat(64), subjectId: extra.subjectId ?? 1 });

test('Xiaomi-style prepayment is not double counted', () => {
  const report = { model: 'certification', sourceStateKey: 'a'.repeat(64), metrics: { merchantAdvanceBalance: { amount: '0.00', currency: 'RUB', status: 'CERTIFIED' } }, proofFacts: [fact('FISCAL_NEW_MONEY', 32380, 'PROVISIONAL'), fact('CONFIRMED_ACQUISITION_VALUE', 32380, 'CERTIFIED')] };
  const summary = buildAnalyticsSummary({ report });
  assert.equal(summary.metrics.CONFIRMED_ACQUISITION_VALUE.amount, '32380.00');
  assert.equal(summary.metrics.FISCAL_NEW_MONEY.amount, '32380.00');
  assert.equal(summary.metrics.MERCHANT_ADVANCE_BALANCE.amount, '0.00');
});

test('return without refund has net zero but certified receivable', () => {
  const report = { proofFacts: [fact('CONFIRMED_ACQUISITION_VALUE', 100, 'CERTIFIED'), fact('CONFIRMED_RETURN_VALUE', 100, 'CERTIFIED'), fact('OUTSTANDING_REFUND_RECEIVABLE', 100, 'CERTIFIED')] };
  const summary = buildAnalyticsSummary({ report });
  assert.equal(summary.metrics.NET_CONFIRMED_ACQUISITION.amount, '0.00');
  assert.equal(summary.metrics.OUTSTANDING_REFUND_RECEIVABLE.amount, '100.00');
  assert.equal(summary.metrics.FISCAL_NEW_MONEY.amount, '0.00');
});

test('blocked exposure is excluded from certified metrics and broken down by reason', () => {
  const report = { proofFacts: [fact('BLOCKED_EXPOSURE', 98042, 'BLOCKED', { reasonCode: 'UNSUPPORTED_BUSINESS_EVENT_TYPE' }), fact('CONFIRMED_ACQUISITION_VALUE', 10, 'CERTIFIED')] };
  const summary = buildAnalyticsSummary({ report });
  const blocked = buildBlockedBreakdown({ report });
  assert.equal(summary.metrics.BLOCKED_EXPOSURE.amount, '98042.00');
  assert.equal(summary.metrics.CONFIRMED_ACQUISITION_VALUE.amount, '10.00');
  assert.deepEqual(blocked.buckets.map((row) => [row.reasonCode, row.amount]), [['UNSUPPORTED_BUSINESS_EVENT_TYPE', '98042.00']]);
});

test('period is explicit, half-open, and trace output is deterministic', () => {
  const report = { proofFacts: [fact('CONFIRMED_ACQUISITION_VALUE', 1, 'CERTIFIED', { eventAt: '2026-01-01T00:00:00Z', subjectId: 2 }), fact('CONFIRMED_ACQUISITION_VALUE', 2, 'CERTIFIED', { eventAt: '2026-02-01T00:00:00Z', subjectId: 1 })] };
  const summary = buildAnalyticsSummary({ report, from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' });
  const trace = buildAnalyticsTrace({ report, from: summary.period.from, to: summary.period.to });
  assert.equal(summary.period.timezone, 'Europe/Moscow');
  assert.equal(summary.period.semantics.includes('half-open'), true);
  assert.deepEqual(trace.rows.map((row) => row.subjectId), [2]);
});

test('mixed currencies are blocked instead of combined', () => {
  const report = { proofFacts: [fact('CONFIRMED_ACQUISITION_VALUE', 1, 'CERTIFIED'), { ...fact('CONFIRMED_ACQUISITION_VALUE', 2, 'CERTIFIED'), currency: 'USD' }] };
  const summary = buildAnalyticsSummary({ report });
  assert.equal(summary.metrics.CONFIRMED_ACQUISITION_VALUE.status, 'BLOCKED');
  assert.equal(summary.metrics.CONFIRMED_ACQUISITION_VALUE.reason, 'MULTI_CURRENCY_REQUIRES_SEPARATE_REPORT');
});

test('bank spend cannot be requested as certified analytics', () => {
  assert.throws(() => assertSupportedMetric('BANK_SPEND'), /BANK_SPEND_NOT_CERTIFIED/);
});

test('analytics source code never aggregates receipt total_sum directly', async () => {
  const source = await readFile(path.join(process.cwd(), 'src', 'analytics.js'), 'utf8');
  assert.equal(/receipts?\.total_sum|SUM\s*\(\s*total_sum\s*\)/i.test(source), false);
});

test('exact NUMERIC(18,2) money stays exact beyond JavaScript safe integers', () => {
  const report = {
    proofFacts: [
      fact('CONFIRMED_ACQUISITION_VALUE', '90071992547409.91', 'CERTIFIED'),
      fact('CONFIRMED_ACQUISITION_VALUE', '0.09', 'CERTIFIED'),
      fact('CONFIRMED_RETURN_VALUE', '0.01', 'CERTIFIED'),
    ],
  };
  const summary = buildAnalyticsSummary({ report });
  assert.equal(summary.metrics.CONFIRMED_ACQUISITION_VALUE.amount, '90071992547410.00');
  assert.equal(summary.metrics.CONFIRMED_RETURN_VALUE.amount, '0.01');
  assert.equal(summary.metrics.NET_CONFIRMED_ACQUISITION.amount, '90071992547409.99');
});

test('analytics rejects facts from multiple certification source states', () => {
  const report = {
    sourceStateKey: 'a'.repeat(64),
    proofFacts: [
      fact('CONFIRMED_ACQUISITION_VALUE', '10.00', 'CERTIFIED'),
      { ...fact('CONFIRMED_ACQUISITION_VALUE', '5.00', 'CERTIFIED'), sourceStateKey: 'b'.repeat(64) },
    ],
  };
  assert.throws(() => buildAnalyticsSummary({ report }), /MULTIPLE_SOURCE_STATES_NOT_ALLOWED|SOURCE_STATE_IDENTITY_MISSING_OR_MISMATCHED/);
});

test('analytics keeps item-grain out of purchase-grain aggregation', () => {
  const report = {
    proofFacts: [fact('CONFIRMED_ACQUISITION_VALUE', '20.00', 'CERTIFIED', { subjectId: 42 })],
  };
  const summary = buildAnalyticsSummary({ report });
  assert.equal(summary.metrics.CONFIRMED_ACQUISITION_VALUE.amount, '20.00');
});

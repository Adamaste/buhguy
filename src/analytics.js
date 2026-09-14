import { certificationReport } from './certification.js';

export const ANALYTICS_MODEL_VERSION = 'analytics-v1';
export const ACCOUNTING_TIMEZONE = 'Europe/Moscow';
const METRICS = ['CONFIRMED_ACQUISITION_VALUE', 'CONFIRMED_RETURN_VALUE', 'FISCAL_NEW_MONEY', 'MERCHANT_ADVANCE_BALANCE', 'OUTSTANDING_REFUND_RECEIVABLE', 'BLOCKED_EXPOSURE'];
const money = (value) => Number(value ?? 0).toFixed(2);
const inPeriod = (value, from, to) => (!from || new Date(value) >= new Date(from)) && (!to || new Date(value) < new Date(to));

export class AnalyticsContractError extends Error {}

function period({ from = null, to = null, timezone = ACCOUNTING_TIMEZONE } = {}) {
  if (from && Number.isNaN(Date.parse(from))) throw new AnalyticsContractError('Invalid analytics period from');
  if (to && Number.isNaN(Date.parse(to))) throw new AnalyticsContractError('Invalid analytics period to');
  if (from && to && new Date(from) >= new Date(to)) throw new AnalyticsContractError('Analytics period must be half-open and from < to');
  return { from, to, timezone, semantics: 'certification event_at, half-open [from,to)' };
}

function grouped(rows) {
  const out = new Map();
  for (const row of rows ?? []) {
    const key = `${row.metricCode}|${row.status}|${row.reasonCode ?? ''}|${row.currency ?? ''}`;
    const current = out.get(key) ?? { metricCode: row.metricCode, status: row.status, reasonCode: row.reasonCode ?? null, currency: row.currency ?? null, amount: 0, count: 0 };
    current.amount += Number(row.amount ?? 0); current.count += 1; out.set(key, current);
  }
  return [...out.values()].map((row) => ({ ...row, amount: money(row.amount) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function metricContract(code, rows, defaultStatus, periodInfo) {
  const relevant = rows.filter((row) => row.metricCode === code);
  const currencies = [...new Set(relevant.map((row) => row.currency).filter(Boolean))].sort();
  if (currencies.length > 1) return { metricCode: code, amount: null, currency: null, status: 'BLOCKED', count: relevant.length, reason: 'MULTI_CURRENCY_REQUIRES_SEPARATE_REPORT', period: periodInfo };
  const amount = relevant.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const status = relevant.length ? [...new Set(relevant.map((row) => row.status))].sort().join('+') : defaultStatus;
  return { metricCode: code, amount: money(amount), currency: currencies[0] ?? null, status, count: relevant.length, reason: relevant[0]?.reasonCode ?? null, period: periodInfo };
}

export function buildAnalyticsSummary({ report, scopeKey = 'default', from = null, to = null, timezone = ACCOUNTING_TIMEZONE }) {
  const periodInfo = period({ from, to, timezone });
  const rows = (report?.proofFacts ?? []).filter((row) => inPeriod(row.eventAt, from, to));
  const metrics = {};
  for (const code of METRICS) {
    if (code === 'MERCHANT_ADVANCE_BALANCE') {
      const balance = report?.metrics?.merchantAdvanceBalance;
      metrics[code] = { metricCode: code, amount: money(balance?.amount ?? 0), currency: balance?.currency ?? 'RUB', status: balance?.status ?? 'CERTIFIED', count: 1, reason: balance?.reason ?? null, period: periodInfo };
    } else metrics[code] = metricContract(code, rows, code === 'BLOCKED_EXPOSURE' ? 'BLOCKED' : (code === 'FISCAL_NEW_MONEY' ? 'PROVISIONAL' : 'CERTIFIED'), periodInfo);
  }
  const acquisition = Number(metrics.CONFIRMED_ACQUISITION_VALUE.amount ?? 0);
  const returns = Number(metrics.CONFIRMED_RETURN_VALUE.amount ?? 0);
  metrics.NET_CONFIRMED_ACQUISITION = { metricCode: 'NET_CONFIRMED_ACQUISITION', amount: money(acquisition - returns), currency: metrics.CONFIRMED_ACQUISITION_VALUE.currency ?? metrics.CONFIRMED_RETURN_VALUE.currency, status: metrics.CONFIRMED_ACQUISITION_VALUE.status === 'CERTIFIED' && metrics.CONFIRMED_RETURN_VALUE.status === 'CERTIFIED' ? 'CERTIFIED' : 'BLOCKED', count: metrics.CONFIRMED_ACQUISITION_VALUE.count + metrics.CONFIRMED_RETURN_VALUE.count, reason: null, period: periodInfo };
  return { model: ANALYTICS_MODEL_VERSION, scopeKey, period: periodInfo, source: { model: report?.model ?? null, sourceStateKey: report?.sourceStateKey ?? null }, metrics, contract: { amountsAreLedgerOrCertificationDerived: true, receiptTotalSumIsNotAnAnalyticsSource: true } };
}

export function buildBlockedBreakdown({ report, scopeKey = 'default', from = null, to = null, timezone = ACCOUNTING_TIMEZONE }) {
  const periodInfo = period({ from, to, timezone });
  return { model: ANALYTICS_MODEL_VERSION, scopeKey, period: periodInfo, buckets: grouped((report?.proofFacts ?? []).filter((fact) => inPeriod(fact.eventAt, from, to) && fact.metricCode === 'BLOCKED_EXPOSURE' && fact.status === 'BLOCKED')).map((row) => ({ ...row, exposure: row.amount })) };
}

export function buildAnalyticsTrace({ report, metricCode = null, limit = 100, scopeKey = 'default', from = null, to = null, timezone = ACCOUNTING_TIMEZONE }) {
  const periodInfo = period({ from, to, timezone });
  const allowed = metricCode ? [metricCode] : METRICS;
  const facts = (report?.proofFacts ?? []).filter((fact) => inPeriod(fact.eventAt, from, to) && allowed.includes(fact.metricCode)).sort((a, b) => `${a.eventAt}|${a.subjectId}|${a.metricCode}`.localeCompare(`${b.eventAt}|${b.subjectId}|${b.metricCode}`)).slice(0, Math.max(0, Number(limit)));
  return { model: ANALYTICS_MODEL_VERSION, scopeKey, period: periodInfo, metricCode, rows: facts.map((fact) => ({ subjectId: fact.subjectId, metricCode: fact.metricCode, status: fact.status, amount: money(fact.amount), currency: fact.currency, eventAt: fact.eventAt, reasonCode: fact.reasonCode, ruleCode: fact.ruleCode, ruleVersion: fact.ruleVersion, ledgerEntryId: fact.ledgerEntryId, businessEventId: fact.businessEventId, graphEvidenceId: fact.graphEvidenceId, sourceStateKey: fact.sourceStateKey })) };
}

export async function analyticsSummary(pool, options = {}) { return buildAnalyticsSummary({ report: await certificationReport(pool, options), ...options }); }
export async function analyticsBlocked(pool, options = {}) { return buildBlockedBreakdown({ report: await certificationReport(pool, options), ...options }); }
export async function analyticsTrace(pool, options = {}) { return buildAnalyticsTrace({ report: await certificationReport(pool, options), ...options }); }

export function assertSupportedMetric(metricCode) {
  if (metricCode === 'BANK_SPEND' || metricCode === 'ACTUAL_BANK_CASH') throw new AnalyticsContractError('BANK_SPEND_NOT_CERTIFIED');
  if (metricCode && ![...METRICS, 'NET_CONFIRMED_ACQUISITION'].includes(metricCode)) throw new AnalyticsContractError(`Unsupported analytics metric: ${metricCode}`);
}

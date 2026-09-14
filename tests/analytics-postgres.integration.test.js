import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { analyticsSummary, analyticsBlocked, analyticsTrace } from '../src/analytics.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration('Analytics V1 clone is read-only, certification-aligned and scope-safe', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM receipts) AS receipts,
    (SELECT count(*) FROM receipt_items) AS items,
    (SELECT count(*) FROM receipt_raw) AS raw,
    (SELECT count(*) FROM business_events) AS events,
    (SELECT count(*) FROM business_event_evidence) AS evidence,
    (SELECT count(*) FROM business_event_edges) AS edges,
    (SELECT count(*) FROM business_event_allocations) AS allocations,
    (SELECT count(*) FROM ledger_entries) AS ledger_entries,
    (SELECT count(*) FROM ledger_postings) AS postings,
    (SELECT count(*) FROM ledger_source_links) AS links,
    (SELECT count(*) FROM reconciliation_runs) AS runs,
    (SELECT count(*) FROM reconciliation_results) AS results,
    (SELECT count(*) FROM certification_facts) AS facts`)).rows[0];
  try {
    const before = await counts();
    assert.equal(before.receipts, before.raw);
    assert.ok(Number(before.items) >= Number(before.receipts));
    for (const value of Object.values(before)) assert.ok(Number(value) >= 0);
    const summary = await analyticsSummary(pool, {});
    for (const code of ['CONFIRMED_ACQUISITION_VALUE', 'CONFIRMED_RETURN_VALUE', 'NET_CONFIRMED_ACQUISITION']) {
      assert.match(summary.metrics[code].amount, /^-?\d+(\.\d+)?$/);
    }
    assert.equal(summary.metrics.FISCAL_NEW_MONEY.status, 'PROVISIONAL');
    assert.match(summary.metrics.MERCHANT_ADVANCE_BALANCE.amount, /^-?\d+(\.\d+)?$/);
    assert.match(summary.metrics.OUTSTANDING_REFUND_RECEIVABLE.amount, /^-?\d+(\.\d+)?$/);
    assert.equal(summary.metrics.BLOCKED_EXPOSURE.status, 'BLOCKED');
    const blocked = await analyticsBlocked(pool, {});
    assert.equal(blocked.buckets.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2), Number(summary.metrics.BLOCKED_EXPOSURE.amount).toFixed(2));
    const month = await analyticsSummary(pool, { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
    assert.equal(month.period.semantics.includes('half-open'), true);
    const boundary = await analyticsSummary(pool, { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' });
    assert.ok(Number(boundary.metrics.CONFIRMED_ACQUISITION_VALUE.amount) >= 0);
    const trace = await analyticsTrace(pool, { metricCode: 'CONFIRMED_ACQUISITION_VALUE', limit: 200 });
    assert.ok(trace.rows.length > 0);
    const refundCash = await pool.query(`SELECT count(*)::int AS count FROM analytics_certification_facts WHERE metric_code='REFUND_CASH_RECEIVED' AND status='CERTIFIED'`);
    assert.equal(refundCash.rows[0].count, 0);
    assert.deepEqual(await counts(), before);
  } finally { await pool.end(); }
});

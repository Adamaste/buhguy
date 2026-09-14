import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { certificationReport, rebuildCertification, refreshCertificationForEvents } from '../src/certification.js';

test('Certification V1 clone is idempotent, scoped, balanced and rollback-safe', { skip: !process.env.TEST_DATABASE_URL, concurrency: false }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM receipts) AS receipts,
    (SELECT count(*) FROM receipt_items) AS items,
    (SELECT count(*) FROM receipt_raw) AS raw,
    (SELECT count(*) FROM business_events) AS events,
    (SELECT count(*) FROM ledger_entries) AS ledger_entries,
    (SELECT count(*) FROM certification_facts) AS facts`)).rows[0];
  try {
    const period = (await pool.query("SELECT to_char(date_trunc('day', MIN(le.event_at)), 'YYYY-MM-DD') AS from_day, to_char(date_trunc('day', MIN(le.event_at)) + interval '1 day', 'YYYY-MM-DD') AS to_day FROM ledger_entries le JOIN business_events e ON e.id=le.source_event_id WHERE le.event_at IS NOT NULL")).rows[0];
    assert.ok(period.from_day && period.to_day);
    const from = period.from_day;
    const to = period.to_day;
    const first = await rebuildCertification(pool, { persist: true, replace: true, from, to });
    assert.match(first.balances.merchantAdvance, /^-?\d+(\.\d+)?$/);
    assert.match(first.results.find((item) => item.metricCode === 'CONFIRMED_ACQUISITION_VALUE').amount, /^-?\d+(\.\d+)?$/);
    assert.equal(first.results.find((item) => item.metricCode === 'FISCAL_NEW_MONEY').status, 'PROVISIONAL');
    const firstRows = await pool.query('SELECT (SELECT count(*) FROM reconciliation_runs)::int AS runs, (SELECT count(*) FROM reconciliation_results)::int AS results');
    assert.ok(firstRows.rows[0].runs > 0);
    assert.ok(firstRows.rows[0].results > 0);
    const bounded = await refreshCertificationForEvents(pool, { eventIds: [44, 45] });
    assert.equal(bounded.bounded, true);
    const second = await rebuildCertification(pool, { persist: true, from, to });
    assert.equal(second.facts.length, first.facts.length);
    const secondRows = await pool.query('SELECT (SELECT count(*) FROM reconciliation_runs)::int AS runs, (SELECT count(*) FROM reconciliation_results)::int AS results');
    assert.ok(secondRows.rows[0].runs >= firstRows.rows[0].runs);
    assert.ok(secondRows.rows[0].results >= firstRows.rows[0].results);
    const repeated = [];
    for (let index = 0; index < 3; index += 1) repeated.push(await rebuildCertification(pool, { persist: true, from, to }));
    assert.equal(repeated.length, 3);
    const baseline = await counts();
    await assert.rejects(() => rebuildCertification(pool, { persist: true, replace: true, from, to, failAfter: 1 }), /injected certification failure/);
    const afterFailure = await counts();
    assert.deepEqual(afterFailure, baseline);
    const report = await certificationReport(pool, { from, to });
    assert.match(report.metrics.netConfirmedAcquisition.amount, /^-?\d+(\.\d+)?$/);
    assert.match(report.metrics.merchantAdvanceBalance.amount, /^-?\d+(\.\d+)?$/);
    const proof = await pool.query('SELECT count(*)::int AS count FROM certification_facts WHERE ledger_entry_id IS NOT NULL AND business_event_id IS NOT NULL');
    assert.ok(Number(proof.rows[0].count) >= first.facts.length);
  } finally { await pool.end(); }
});

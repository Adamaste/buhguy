import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { certificationReport, certificationResultSemanticKey, rebuildCertification, refreshCertificationForEvents, CERTIFICATION_SOURCE_STATE_OVERRIDE } from '../src/certification.js';

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
    assert.equal(second.reused, true);
    const secondRows = await pool.query('SELECT (SELECT count(*) FROM reconciliation_runs)::int AS runs, (SELECT count(*) FROM reconciliation_results)::int AS results');
    assert.ok(secondRows.rows[0].runs >= firstRows.rows[0].runs);
    assert.ok(secondRows.rows[0].results >= firstRows.rows[0].results);
    const writeStatsBeforeReplay = (await pool.query(`SELECT relname,n_tup_ins,n_tup_upd,n_tup_del
      FROM pg_stat_user_tables WHERE relname IN ('reconciliation_runs','certification_facts','reconciliation_results') ORDER BY relname`)).rows;
    const snapshotBeforeReplay = (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM reconciliation_runs) x) AS runs,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM certification_facts) x) AS facts,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM reconciliation_results) x) AS results`)).rows[0];
    const repeated = [];
    for (let index = 0; index < 3; index += 1) repeated.push(await rebuildCertification(pool, { persist: true, from, to }));
    assert.equal(repeated.length, 3);
    assert.ok(repeated.every((result) => result.reused === true && result.refreshed === false));
    const writeStatsAfterReplay = (await pool.query(`SELECT relname,n_tup_ins,n_tup_upd,n_tup_del
      FROM pg_stat_user_tables WHERE relname IN ('reconciliation_runs','certification_facts','reconciliation_results') ORDER BY relname`)).rows;
    assert.deepEqual(writeStatsAfterReplay, writeStatsBeforeReplay);
    const snapshotAfterReplay = (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM reconciliation_runs) x) AS runs,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM certification_facts) x) AS facts,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM reconciliation_results) x) AS results`)).rows[0];
    assert.deepEqual(snapshotAfterReplay, snapshotBeforeReplay);
    const stateBeforeChange = second.sourceStateKey;
    await pool.query("UPDATE ledger_entries SET description=COALESCE(description,'') || ' noop-gate-fixture-change' WHERE id=(SELECT id FROM ledger_entries ORDER BY id LIMIT 1)");
    const changed = await rebuildCertification(pool, { persist: true, replace: true, reuseUnchanged: true, from, to });
    assert.notEqual(changed.sourceStateKey, stateBeforeChange);
    assert.equal(changed.reused, false);
    assert.equal(Number((await pool.query('SELECT count(*) FROM reconciliation_runs')).rows[0].count), 1);
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

test('same-source-state refresh is a byte-identical NOOP and corrupted snapshots fail closed', { skip: !process.env.TEST_DATABASE_URL, concurrency: false }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const snapshot = async (runId) => ({
    run: (await pool.query('SELECT * FROM reconciliation_runs WHERE id=$1', [runId])).rows,
    facts: (await pool.query('SELECT * FROM certification_facts WHERE run_id=$1 ORDER BY id', [runId])).rows,
    results: (await pool.query('SELECT * FROM reconciliation_results WHERE run_id=$1 ORDER BY id', [runId])).rows,
  });
  try {
    const baselineReceiptId = Number((await pool.query("INSERT INTO receipts(fns_id,source,total_sum,currency) VALUES($1,'cert-refresh-baseline',0,'RUB') RETURNING id", [`cert-refresh-baseline-${process.pid}-${Date.now()}`])).rows[0].id);
    await pool.query('INSERT INTO receipt_raw(receipt_id,payload) VALUES($1,$2)', [baselineReceiptId, JSON.stringify({ test: 'baseline-source-state' })]);
    const first = await refreshCertificationForEvents(pool, { scopeKey: 'default', eventIds: [44] });
    assert.ok(first.runId);
    assert.ok(first.sourceStateKey);
    const beforeRepeat = await snapshot(first.runId);
    const repeated = await refreshCertificationForEvents(pool, { scopeKey: 'default', eventIds: [44] });
    assert.equal(repeated.runId, first.runId);
    assert.equal(repeated.sourceStateKey, first.sourceStateKey);
    assert.deepEqual(await snapshot(repeated.runId), beforeRepeat);

    const scopeKey = `cert-refresh-state-${process.pid}-${Date.now()}`;
    const scopeId = Number((await pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, scopeKey])).rows[0].id);
    const oldRun = await snapshot(first.runId);
    const receiptId = Number((await pool.query("INSERT INTO receipts(fns_id,source,total_sum,currency) VALUES($1,'cert-refresh-test',0,'RUB') RETURNING id", [`cert-refresh-receipt-${process.pid}-${Date.now()}`])).rows[0].id);
    await pool.query('INSERT INTO receipt_raw(receipt_id,payload) VALUES($1,$2)', [receiptId, JSON.stringify({ test: 'source-state-change' })]);
    const changed = await refreshCertificationForEvents(pool, { scopeKey: 'default', eventIds: [44] });
    assert.notEqual(changed.runId, first.runId);
    assert.notEqual(changed.sourceStateKey, first.sourceStateKey);
    assert.deepEqual(await snapshot(first.runId), oldRun);
    await pool.query('DELETE FROM receipt_raw WHERE receipt_id=$1', [receiptId]);
    await pool.query('DELETE FROM receipts WHERE id=$1', [receiptId]);
    await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]);

    const current = await refreshCertificationForEvents(pool, { scopeKey: 'default', eventIds: [44] });
    const fact = (await pool.query('SELECT * FROM certification_facts WHERE run_id=$1 ORDER BY id LIMIT 1', [current.runId])).rows[0];
    assert.ok(fact, 'fixture must produce a certification fact');
    await pool.query('DELETE FROM certification_facts WHERE id=$1', [fact.id]);
    const missingSnapshot = await snapshot(current.runId);
    await assert.rejects(() => refreshCertificationForEvents(pool, { scopeKey: 'default', eventIds: [44] }), (error) => error.code === 'CERTIFICATION_CONFLICT');
    assert.deepEqual(await snapshot(current.runId), missingSnapshot);

    const replacement = (await pool.query('SELECT * FROM certification_facts WHERE run_id=$1 ORDER BY id LIMIT 1', [current.runId])).rows[0];
    assert.ok(replacement, 'fixture must retain a fact for conflict regression');
    await pool.query('UPDATE certification_facts SET amount=amount+1 WHERE id=$1', [replacement.id]);
    const conflictingSnapshot = await snapshot(current.runId);
    await assert.rejects(() => refreshCertificationForEvents(pool, { scopeKey: 'default', eventIds: [44] }), (error) => error.code === 'CERTIFICATION_CONFLICT');
    assert.deepEqual(await snapshot(current.runId), conflictingSnapshot);
  } finally { await pool.end(); }
});

test('persistent certification rejects a forged source-state identity without writes', { skip: !process.env.TEST_DATABASE_URL, concurrency: false }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const snapshot = async () => (await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM reconciliation_runs) x) AS runs,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM certification_facts) x) AS facts,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM reconciliation_results) x) AS results,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM ledger_entries) x) AS ledger_entries`)).rows[0];
  try {
    const before = await snapshot();
    await assert.rejects(
      () => rebuildCertification(pool, { persist: true, sourceStateKey: 'f'.repeat(64) }),
      (error) => error.code === CERTIFICATION_SOURCE_STATE_OVERRIDE,
    );
    assert.deepEqual(await snapshot(), before);
    const normal = await rebuildCertification(pool, { persist: true });
    assert.match(normal.sourceStateKey, /^[0-9a-f]{64}$/);
    assert.ok(normal.runId);
  } finally { await pool.end(); }
});

test('full READY certification can be reused by bounded refresh without mutation', { skip: !process.env.TEST_DATABASE_URL, concurrency: false }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const full = await rebuildCertification(pool, { scopeKey: 'default', persist: true, replace: true });
    const eventId = Number((await pool.query("SELECT source_event_id FROM ledger_entries WHERE scope_id=(SELECT id FROM accounting_scopes WHERE scope_key='default') ORDER BY id LIMIT 1")).rows[0].source_event_id);
    const before = (await pool.query(`SELECT
      (SELECT count(*) FROM reconciliation_runs)::int AS runs,
      (SELECT count(*) FROM certification_facts)::int AS facts,
      (SELECT count(*) FROM reconciliation_results)::int AS results`)).rows[0];
    const bounded = await refreshCertificationForEvents(pool, { scopeKey: 'default', eventIds: [eventId] });
    assert.equal(bounded.runId, full.runId);
    assert.equal(bounded.sourceStateKey, full.sourceStateKey);
    assert.equal(bounded.reused, true);
    assert.equal(bounded.refreshed, false);
    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*) FROM reconciliation_runs)::int AS runs,
      (SELECT count(*) FROM certification_facts)::int AS facts,
      (SELECT count(*) FROM reconciliation_results)::int AS results`)).rows[0], before);
  } finally { await pool.end(); }
});

test('incomplete exact READY run is rejected instead of reused', { skip: !process.env.TEST_DATABASE_URL, concurrency: false }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const full = await rebuildCertification(pool, { scopeKey: 'default', persist: true });
    const before = (await pool.query(`SELECT
      (SELECT count(*)::int FROM reconciliation_runs) AS runs,
      (SELECT count(*)::int FROM certification_facts) AS facts,
      (SELECT count(*)::int FROM reconciliation_results) AS results`)).rows[0];
    await pool.query('UPDATE reconciliation_runs SET finished_at=NULL WHERE id=$1', [full.runId]);
    await assert.rejects(
      () => rebuildCertification(pool, { scopeKey: 'default', persist: true, reuseUnchanged: true }),
      (error) => error.code === 'CERTIFICATION_CONFLICT',
    );
    const after = (await pool.query(`SELECT
      (SELECT count(*)::int FROM reconciliation_runs) AS runs,
      (SELECT count(*)::int FROM certification_facts) AS facts,
      (SELECT count(*)::int FROM reconciliation_results) AS results`)).rows[0];
    assert.deepEqual(after, before);
    await pool.query('UPDATE reconciliation_runs SET finished_at=NOW() WHERE id=$1', [full.runId]);
  } finally { await pool.end(); }
});



test('existing READY result identity has golden parity and same-state reuse', { skip: !process.env.TEST_DATABASE_URL, concurrency: false }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const full = await rebuildCertification(pool, { scopeKey: 'default', persist: true });
    const stored = (await pool.query('SELECT * FROM reconciliation_results WHERE run_id=$1 ORDER BY id', [full.runId])).rows;
    const projected = await rebuildCertification(pool, { scopeKey: 'default', persist: false });
    assert.equal(projected.sourceStateKey, full.sourceStateKey);
    const sqlAggregates = (await pool.query(`SELECT metric_code,status,ROUND(SUM(amount),2) AS amount,currency,count(*)::int AS count_items,reason_code
      FROM certification_facts WHERE run_id=$1
      GROUP BY metric_code,status,currency,reason_code
      ORDER BY metric_code,status,currency,reason_code`, [full.runId])).rows;
    const jsAggregates = [...projected.results].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(sqlAggregates.map((row) => ({
      metricCode: row.metric_code,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      countItems: Number(row.count_items),
      reasonCode: row.reason_code,
    })), jsAggregates.map(({ metricCode, status, amount, currency, countItems, reasonCode }) => ({ metricCode, status, amount, currency, countItems, reasonCode })));
    for (const result of projected.results) {
      const row = stored.find((candidate) => candidate.metric_code === result.metricCode
        && candidate.currency === result.currency
        && candidate.status === result.status
        && candidate.reason_code === result.reasonCode);
      assert.ok(row, `persisted result missing for ${result.metricCode}`);
      assert.equal(row.amount, result.amount);
      assert.equal(Number(row.count_items), result.countItems);
      assert.equal(row.reason_code, result.reasonCode);
      assert.equal(row.semantic_key, certificationResultSemanticKey(result, full.runId));
    }
    const reused = await refreshCertificationForEvents(pool, { scopeKey: 'default', eventIds: [44] });
    assert.equal(reused.runId, full.runId);
    assert.equal(reused.sourceStateKey, full.sourceStateKey);
    assert.equal(reused.reused, true);
    assert.equal(reused.refreshed, false);
  } finally {
    await pool.end();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { rebuildLedger, refreshLedgerForReceipt } from '../src/ledger.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration('Ledger V1 clone persist, idempotency, concurrency and rollback', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const before = (await pool.query('SELECT (SELECT count(*) FROM receipts) AS receipts,(SELECT count(*) FROM receipt_items) AS items,(SELECT count(*) FROM receipt_raw) AS raw,(SELECT count(*) FROM receipt_fiscal_facts) AS facts,(SELECT count(*) FROM receipt_item_fiscal_facts) AS item_facts,(SELECT count(*) FROM business_events) AS events,(SELECT count(*) FROM business_event_edges) AS edges,(SELECT count(*) FROM business_event_allocations) AS allocations')).rows[0];
    const eventIds = (await pool.query('SELECT DISTINCT e.id FROM business_events e JOIN business_event_evidence ev ON ev.event_id=e.id ORDER BY e.id LIMIT 20')).rows.map((row) => Number(row.id));
    assert.ok(eventIds.length > 0);
    const first = await rebuildLedger(pool, { eventIds, dryRun: true });
    assert.ok(first.entries >= 0);
    assert.ok(first.postings >= 0);
    const second = await rebuildLedger(pool, { eventIds, dryRun: true });
    assert.deepEqual(second, first);
    const baselineEntries = Number((await pool.query('SELECT count(*) AS entries FROM ledger_entries')).rows[0].entries);
    assert.ok(baselineEntries >= 0);
    const after = (await pool.query('SELECT (SELECT count(*) FROM receipts) AS receipts,(SELECT count(*) FROM receipt_items) AS items,(SELECT count(*) FROM receipt_raw) AS raw,(SELECT count(*) FROM receipt_fiscal_facts) AS facts,(SELECT count(*) FROM receipt_item_fiscal_facts) AS item_facts,(SELECT count(*) FROM business_events) AS events,(SELECT count(*) FROM business_event_edges) AS edges,(SELECT count(*) FROM business_event_allocations) AS allocations')).rows[0];
    assert.deepEqual(after, before);
    const persistedFirst = await rebuildLedger(pool, { eventIds });
    const persistedSnapshotBeforeReplay = (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM ledger_entries) x) AS entries,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM ledger_postings) x) AS postings,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM ledger_source_links) x) AS links`)).rows[0];
    const writeStatsBeforeReplay = (await pool.query(`SELECT relname,n_tup_ins,n_tup_upd,n_tup_del
      FROM pg_stat_user_tables WHERE relname IN ('ledger_entries','ledger_postings','ledger_source_links') ORDER BY relname`)).rows;
    const persistedSecond = await rebuildLedger(pool, { eventIds });
    assert.equal(persistedSecond.changed, false);
    assert.equal(persistedSecond.created.entries, 0);
    assert.equal(persistedFirst.entries, persistedSecond.entries);
    const writeStatsAfterReplay = (await pool.query(`SELECT relname,n_tup_ins,n_tup_upd,n_tup_del
      FROM pg_stat_user_tables WHERE relname IN ('ledger_entries','ledger_postings','ledger_source_links') ORDER BY relname`)).rows;
    assert.deepEqual(writeStatsAfterReplay, writeStatsBeforeReplay);
    const persistedSnapshotAfterReplay = (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM ledger_entries) x) AS entries,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM ledger_postings) x) AS postings,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM (SELECT * FROM ledger_source_links) x) AS links`)).rows[0];
    assert.deepEqual(persistedSnapshotAfterReplay, persistedSnapshotBeforeReplay);
    const balance = await pool.query('SELECT count(*) AS violations FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING SUM(debit) <> SUM(credit)) q');
    assert.equal(Number(balance.rows[0].violations), 0);
  } finally {
    await pool.end();
  }
});

integration('ledger no-op fails closed for a missing scope', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await assert.rejects(
      () => rebuildLedger(pool, { scopeKey: `missing-ledger-scope-${process.pid}-${Date.now()}` }),
      (error) => error.code === 'ACCOUNTING_SCOPE_NOT_FOUND',
    );
  } finally {
    await pool.end();
  }
});

integration('identical certified bounded refresh preserves ledger identity', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  let scopeId = null;
  let eventId = null;
  let receiptId = null;
  let ledgerEntryId = null;
  let runId = null;
  try {
    await pool.query('BEGIN');
    const scope = (await pool.query("INSERT INTO accounting_scopes(scope_key,label) VALUES('bounded-certified-refresh','fixture') RETURNING id")).rows[0];
    scopeId = Number(scope.id);
    receiptId = Number((await pool.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES('bounded-certified-refresh-receipt',NOW(),'fixture',10,'RUB') RETURNING id")).rows[0].id);
    await pool.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,cash_total_sum,ecash_total_sum,cash_total_state,ecash_total_state,prepaid_state,credit_state,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',repeat('e',64),repeat('f',64),'READY',0,10,'PRESENT_VALUE','PRESENT_VALUE','EXPLICIT_ZERO','EXPLICIT_ZERO','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','NORMAL')", [receiptId]);
    await pool.query("INSERT INTO business_graph_rules(rule_code,rule_version,description) VALUES('STANDALONE_PURCHASE_V1','v1','fixture') ON CONFLICT DO NOTHING");
    const event = (await pool.query("INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency) VALUES($1,'PURCHASE','CONFIRMED','SYSTEM_DERIVED','business-graph-v1','STANDALONE_PURCHASE_V1','v1',repeat('a',64),10,'RUB') RETURNING id", [scope.id])).rows[0];
    eventId = Number(event.id);
    await pool.query("INSERT INTO business_event_evidence(event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key) VALUES($1,$2,'fiscal-normalizer-v1','PURCHASE_EVIDENCE','SYSTEM_DERIVED','business-graph-v1','STANDALONE_PURCHASE_V1','v1',repeat('g',64))", [eventId,receiptId]);
    await pool.query('COMMIT');
    await rebuildLedger(pool, { scopeKey: 'bounded-certified-refresh', eventIds: [eventId] });
    ledgerEntryId = Number((await pool.query("SELECT id FROM ledger_entries WHERE source_event_id=$1 AND origin='SYSTEM_DERIVED'", [eventId])).rows[0].id);
    const run = (await pool.query("INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status) VALUES($1,'certification-v1',repeat('c',64),'READY') RETURNING id", [scope.id])).rows[0];
    runId = Number(run.id);
    await pool.query("INSERT INTO certification_facts(run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,semantic_key,source_state_key) VALUES($1,$2,'LEDGER_ENTRY',$3,'FIXTURE','BUSINESS_CERTIFICATION','CERTIFIED',10,'RUB',NOW(),'FIXTURE','STANDALONE_PURCHASE_V1','v1',$3,$4,repeat('d',64),repeat('c',64))", [run.id,scope.id,ledgerEntryId,event.id]);
    const snapshot = async (entryId = ledgerEntryId) => ({
      entry: (await pool.query('SELECT id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description FROM ledger_entries WHERE id=$1', [entryId])).rows,
      postings: (await pool.query('SELECT p.id,a.account_code,p.currency,p.debit,p.credit,p.source_allocation_id,p.source_receipt_id FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.ledger_entry_id=$1 ORDER BY p.id', [entryId])).rows,
      links: (await pool.query('SELECT id,business_event_id,graph_evidence_id,graph_allocation_id,receipt_id,normalization_version,link_role FROM ledger_source_links WHERE ledger_entry_id=$1 ORDER BY id', [entryId])).rows,
      certification: (await pool.query('SELECT id,run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key FROM certification_facts WHERE ledger_entry_id=$1 ORDER BY id', [entryId])).rows,
    });
    const before = await snapshot();
    const result = await refreshLedgerForReceipt(pool, { scopeKey: 'bounded-certified-refresh', receiptId });
    assert.equal(result.bounded, true);
    assert.equal(result.changed, false);
    const after = await snapshot();
    assert.deepEqual(after, before);
    assert.equal(Number(after.entry[0]?.id), ledgerEntryId);
    const replay = await refreshLedgerForReceipt(pool, { scopeKey: 'bounded-certified-refresh', receiptId });
    assert.equal(replay.bounded, true);
    assert.equal(replay.changed, false);
    assert.deepEqual(await snapshot(), before);

    await pool.query("INSERT INTO business_event_evidence(event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key) VALUES($1,$2,'fiscal-normalizer-v1','ADDITIONAL_PURCHASE_EVIDENCE','SYSTEM_DERIVED','business-graph-v1','STANDALONE_PURCHASE_V1','v1',repeat('h',64))", [eventId, receiptId]);
    const evidenceChanged = await refreshLedgerForReceipt(pool, { scopeKey: 'bounded-certified-refresh', receiptId });
    assert.equal(evidenceChanged.bounded, true);
    assert.equal(evidenceChanged.changed, true);
    const currentEntryId = Number((await pool.query("SELECT id FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2 AND origin='SYSTEM_DERIVED' ORDER BY id DESC LIMIT 1", [scopeId, eventId])).rows[0].id);
    const afterEvidenceChange = await snapshot(currentEntryId);
    const postingContent = (rows) => rows.map(({ id, ...content }) => content);
    assert.deepEqual(postingContent(afterEvidenceChange.postings), postingContent(before.postings));
    assert.equal(afterEvidenceChange.links.length, before.links.length + 1);
    assert.equal(afterEvidenceChange.certification.length, 3);
    const currentEvidenceIds = new Set(afterEvidenceChange.links.map((link) => Number(link.graph_evidence_id)));
    assert(afterEvidenceChange.certification.every((fact) => Number(fact.ledger_entry_id) === currentEntryId));
    assert(afterEvidenceChange.certification.every((fact) => currentEvidenceIds.has(Number(fact.graph_evidence_id))));
    const evidenceReplay = await refreshLedgerForReceipt(pool, { scopeKey: 'bounded-certified-refresh', receiptId });
    assert.equal(evidenceReplay.changed, false);
    assert.deepEqual(await snapshot(currentEntryId), afterEvidenceChange);
  } finally {
    await pool.query('ROLLBACK').catch(() => {});
    if (scopeId !== null) await pool.query('DELETE FROM certification_facts WHERE scope_id=$1', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM reconciliation_results WHERE run_id IN (SELECT id FROM reconciliation_runs WHERE scope_id=$1)', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM reconciliation_runs WHERE scope_id=$1', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM ledger_source_links WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1)', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM ledger_postings WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1)', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM ledger_entries WHERE scope_id=$1', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM ledger_accounts WHERE scope_id=$1', [scopeId]);
    if (eventId !== null) await pool.query('DELETE FROM business_event_evidence WHERE event_id=$1', [eventId]);
    if (eventId !== null) await pool.query('DELETE FROM business_events WHERE id=$1', [eventId]);
    if (receiptId !== null) await pool.query('DELETE FROM receipt_fiscal_facts WHERE receipt_id=$1', [receiptId]);
    if (receiptId !== null) await pool.query('DELETE FROM receipts WHERE id=$1', [receiptId]);
    if (scopeId !== null) await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]);
    await pool.end();
  }
});

integration('blocked bounded refresh preserves provenance and is idempotent', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  let scopeId = null;
  let eventId = null;
  let receiptId = null;
  try {
    await pool.query('BEGIN');
    const scope = (await pool.query("INSERT INTO accounting_scopes(scope_key,label) VALUES('blocked-bounded-refresh','fixture') RETURNING id")).rows[0];
    scopeId = Number(scope.id);
    receiptId = Number((await pool.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES('blocked-bounded-refresh-receipt',NOW(),'fixture',10,'RUB') RETURNING id")).rows[0].id);
    await pool.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,cash_total_sum,ecash_total_sum,cash_total_state,ecash_total_state,prepaid_state,credit_state,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',repeat('e',64),repeat('f',64),'READY',0,10,'PRESENT_VALUE','PRESENT_VALUE','EXPLICIT_ZERO','EXPLICIT_ZERO','EXPLICIT_ZERO','INCOMPLETE','SETTLEMENT_ONLY','NORMAL')", [receiptId]);
    await pool.query("INSERT INTO business_graph_rules(rule_code,rule_version,description) VALUES('STANDALONE_PURCHASE_V1','v1','fixture') ON CONFLICT DO NOTHING");
    const event = (await pool.query("INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency) VALUES($1,'PURCHASE','CONFIRMED','SYSTEM_DERIVED','business-graph-v1','STANDALONE_PURCHASE_V1','v1',repeat('b',64),10,'RUB') RETURNING id", [scope.id])).rows[0];
    eventId = Number(event.id);
    await pool.query("INSERT INTO business_event_evidence(event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key) VALUES($1,$2,'fiscal-normalizer-v1','PURCHASE_EVIDENCE','SYSTEM_DERIVED','business-graph-v1','STANDALONE_PURCHASE_V1','v1',repeat('c',64))", [eventId, receiptId]);
    await pool.query('COMMIT');

    const first = await refreshLedgerForReceipt(pool, { scopeKey: 'blocked-bounded-refresh', receiptId });
    assert.equal(first.bounded, true);
    assert.equal(first.changed, true);
    const before = (await pool.query("SELECT e.id, e.derivation_status, l.id AS link_id, l.graph_evidence_id FROM ledger_entries e LEFT JOIN ledger_source_links l ON l.ledger_entry_id=e.id WHERE e.scope_id=$1 AND e.source_event_id=$2 ORDER BY l.id", [scopeId, eventId])).rows;
    assert.equal(before.length, 1);
    assert.equal(before[0].derivation_status, 'BLOCKED');
    assert.notEqual(before[0].link_id, null);

    const second = await refreshLedgerForReceipt(pool, { scopeKey: 'blocked-bounded-refresh', receiptId });
    assert.equal(second.bounded, true);
    assert.equal(second.changed, false);
    const after = (await pool.query("SELECT e.id, e.derivation_status, l.id AS link_id, l.graph_evidence_id FROM ledger_entries e LEFT JOIN ledger_source_links l ON l.ledger_entry_id=e.id WHERE e.scope_id=$1 AND e.source_event_id=$2 ORDER BY l.id", [scopeId, eventId])).rows;
    assert.deepEqual(after, before);
    assert.equal((await pool.query('SELECT count(*) FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2', [scopeId, eventId])).rows[0].count, '1');
    assert.equal((await pool.query('SELECT count(*) FROM ledger_source_links WHERE ledger_entry_id=(SELECT id FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2)', [scopeId, eventId])).rows[0].count, '1');
  } finally {
    await pool.query('ROLLBACK').catch(() => {});
    if (scopeId !== null) await pool.query('DELETE FROM certification_facts WHERE scope_id=$1', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM reconciliation_results WHERE run_id IN (SELECT id FROM reconciliation_runs WHERE scope_id=$1)', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM reconciliation_runs WHERE scope_id=$1', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM ledger_source_links WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1)', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM ledger_postings WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1)', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM ledger_entries WHERE scope_id=$1', [scopeId]);
    if (scopeId !== null) await pool.query('DELETE FROM ledger_accounts WHERE scope_id=$1', [scopeId]);
    if (eventId !== null) await pool.query('DELETE FROM business_event_evidence WHERE event_id=$1', [eventId]);
    if (eventId !== null) await pool.query('DELETE FROM business_events WHERE id=$1', [eventId]);
    if (receiptId !== null) await pool.query('DELETE FROM receipt_fiscal_facts WHERE receipt_id=$1', [receiptId]);
    if (receiptId !== null) await pool.query('DELETE FROM receipts WHERE id=$1', [receiptId]);
    if (scopeId !== null) await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]);
    await pool.end();
  }
});

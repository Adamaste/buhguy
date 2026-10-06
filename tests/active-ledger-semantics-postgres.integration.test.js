import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { analyticsSummary } from '../src/analytics.js';
import { loadCoverageRows } from '../src/accounting-coverage.js';
import { rebuildCertification } from '../src/certification.js';
import { rebuildLedger, refreshLedgerForReceipt } from '../src/ledger.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration('active-ledger semantics exclude superseded history and protect refreshes', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const suffix = `${Date.now()}-${process.pid}`;
  const scopeKey = `active-ledger-${suffix}`;
  let scopeId = null;
  let eventId = null;
  let receiptId = null;
  let oldEntryId = null;
  let replacementEntryId = null;
  let finalEntryId = null;
  try {
    const scope = (await pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, 'active-ledger fixture'])).rows[0];
    scopeId = Number(scope.id);
    receiptId = Number((await pool.query('INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES($1,NOW(),$2,12,\'RUB\') RETURNING id', [`active-ledger-receipt-${suffix}`, 'fixture'])).rows[0].id);
    await pool.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,cash_total_sum,ecash_total_sum,cash_total_state,ecash_total_state,prepaid_state,credit_state,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',repeat('a',64),repeat('b',64),'READY',0,12,'PRESENT_VALUE','PRESENT_VALUE','EXPLICIT_ZERO','EXPLICIT_ZERO','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','NORMAL')", [receiptId]);
    await pool.query("INSERT INTO business_graph_rules(rule_code,rule_version,description) VALUES('STANDALONE_PURCHASE_V1','v1','active-ledger fixture') ON CONFLICT DO NOTHING");
    const event = (await pool.query("INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency) VALUES($1,'PURCHASE','CONFIRMED','SYSTEM_DERIVED','business-graph-v1','STANDALONE_PURCHASE_V1','v1',repeat('c',64),12,'RUB') RETURNING id", [scopeId])).rows[0];
    eventId = Number(event.id);
    const evidence = (await pool.query("INSERT INTO business_event_evidence(event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key) VALUES($1,$2,'fiscal-normalizer-v1','PURCHASE_EVIDENCE','SYSTEM_DERIVED','business-graph-v1','STANDALONE_PURCHASE_V1','v1',repeat('d',64)) RETURNING id", [eventId, receiptId])).rows[0];
    const accounts = {};
    for (const code of ['UNCLASSIFIED_ACQUISITION', 'FISCAL_PAYMENT_CLEARING']) {
      accounts[code] = Number((await pool.query('INSERT INTO ledger_accounts(scope_id,account_code,account_type,description) VALUES($1,$2,$3,$4) RETURNING id', [scopeId, code, 'CONTROL', code])).rows[0].id);
    }
    const insertEntry = async (semanticKey, description) => Number((await pool.query("INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,description) VALUES($1,$2,'RUB',NOW(),$3,'LEDGER_STANDALONE_PURCHASE_V1','v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED',$4) RETURNING id", [scopeId, eventId, semanticKey, description])).rows[0].id);
    oldEntryId = await insertEntry('1'.repeat(64), 'historical fiscal clearing');
    replacementEntryId = await insertEntry('2'.repeat(64), 'bank-funded replacement');
    finalEntryId = await insertEntry('3'.repeat(64), 'final bank-funded replacement');
    for (const entryId of [oldEntryId, replacementEntryId, finalEntryId]) {
      await pool.query('INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit) VALUES($1,$2,\'RUB\',12,0),($1,$3,\'RUB\',0,12)', [entryId, accounts.UNCLASSIFIED_ACQUISITION, accounts.FISCAL_PAYMENT_CLEARING]);
      await pool.query("INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,receipt_id,normalization_version,link_role,semantic_key) VALUES($1,$2,$3,$4,'fiscal-normalizer-v1','FISCAL_EVIDENCE',$5)", [entryId, eventId, evidence.id, receiptId, `${entryId}`.padStart(64, '0')]);
    }

    const before = await rebuildCertification(pool, { scopeKey });
    assert.equal(before.facts.filter((fact) => fact.metricCode === 'FISCAL_NEW_MONEY').length, 3);
    assert.equal(before.facts.filter((fact) => fact.metricCode === 'CONFIRMED_ACQUISITION_VALUE').length, 3);
    await rebuildCertification(pool, { scopeKey, persist: true });

    await pool.query("INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code) VALUES($1,$2,$3,$4,repeat('e',64),repeat('f',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, oldEntryId, replacementEntryId, eventId]);
    const middle = await rebuildCertification(pool, { scopeKey });
    assert.equal(middle.facts.filter((fact) => fact.metricCode === 'FISCAL_NEW_MONEY').length, 2);
    assert.equal(middle.facts.every((fact) => fact.ledgerEntryId !== oldEntryId), true);

    await pool.query("INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code) VALUES($1,$2,$3,$4,repeat('0',64),repeat('1',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, replacementEntryId, finalEntryId, eventId]);

    const after = await rebuildCertification(pool, { scopeKey });
    assert.notEqual(after.sourceStateKey, before.sourceStateKey);
    assert.equal(after.facts.filter((fact) => fact.metricCode === 'FISCAL_NEW_MONEY').length, 1);
    assert.equal(after.facts.filter((fact) => fact.metricCode === 'CONFIRMED_ACQUISITION_VALUE').length, 1);
    assert.equal(after.results.find((result) => result.metricCode === 'FISCAL_NEW_MONEY').amount, '12.00');
    assert.equal(after.results.find((result) => result.metricCode === 'CONFIRMED_ACQUISITION_VALUE').amount, '12.00');

    const analytics = await analyticsSummary(pool, { scopeKey });
    assert.equal(analytics.metrics.FISCAL_NEW_MONEY.amount, '12.00');
    assert.equal(analytics.metrics.CONFIRMED_ACQUISITION_VALUE.amount, '12.00');
    await rebuildCertification(pool, { scopeKey, persist: true });
    const coverageRows = await loadCoverageRows(pool, { scopeKey });
    const coverageEvent = coverageRows.find((row) => Number(row.id) === receiptId)?.related?.events.find((item) => Number(item.eventId) === eventId);
    assert.equal(Number(coverageEvent?.ledgerEntryId), finalEntryId);
    assert.notEqual(Number(coverageEvent?.ledgerEntryId), oldEntryId);
    assert.notEqual(Number(coverageEvent?.ledgerEntryId), replacementEntryId);
    assert.equal(after.facts.every((fact) => fact.ledgerEntryId === finalEntryId), true);

    await rebuildCertification(pool, { scopeKey, persist: true, replace: true });
    const snapshot = async () => ({
      entries: (await pool.query('SELECT id,semantic_key FROM ledger_entries WHERE scope_id=$1 ORDER BY id', [scopeId])).rows,
      postings: (await pool.query('SELECT ledger_entry_id,account_id,debit,credit FROM ledger_postings WHERE ledger_entry_id IN ($1,$2,$3) ORDER BY id', [oldEntryId, replacementEntryId, finalEntryId])).rows,
      links: (await pool.query('SELECT ledger_entry_id,semantic_key FROM ledger_source_links WHERE ledger_entry_id IN ($1,$2,$3) ORDER BY id', [oldEntryId, replacementEntryId, finalEntryId])).rows,
      facts: (await pool.query('SELECT ledger_entry_id,metric_code,amount,source_state_key FROM certification_facts WHERE scope_id=$1 ORDER BY id', [scopeId])).rows,
      runs: (await pool.query('SELECT id,source_state_key FROM reconciliation_runs WHERE scope_id=$1 ORDER BY id', [scopeId])).rows,
      results: (await pool.query('SELECT run_id,metric_code,amount FROM reconciliation_results WHERE run_id IN (SELECT id FROM reconciliation_runs WHERE scope_id=$1) ORDER BY id', [scopeId])).rows,
      supersessions: (await pool.query('SELECT superseded_ledger_entry_id,replacement_ledger_entry_id,semantic_key FROM ledger_entry_supersessions WHERE scope_id=$1 ORDER BY id', [scopeId])).rows,
    });
    const protectedBefore = await snapshot();
    await assert.rejects(
      () => refreshLedgerForReceipt(pool, { scopeKey, receiptId }),
      (error) => error?.code === 'LEDGER_SUPERSESSION_PROTECTED',
    );
    await assert.rejects(
      () => rebuildLedger(pool, { scopeKey, replace: true, eventIds: [eventId], projection: { entries: [] } }),
      (error) => error?.code === 'LEDGER_SUPERSESSION_PROTECTED',
    );
    await assert.rejects(
      () => rebuildLedger(pool, { scopeKey, replace: true }),
      (error) => error?.code === 'LEDGER_SUPERSESSION_PROTECTED',
    );
    assert.deepEqual(await snapshot(), protectedBefore);
  } finally {
    if (scopeId !== null) {
      await pool.query('DELETE FROM certification_facts WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM reconciliation_results WHERE run_id IN (SELECT id FROM reconciliation_runs WHERE scope_id=$1)', [scopeId]);
      await pool.query('DELETE FROM reconciliation_runs WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM ledger_entry_supersessions WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM ledger_source_links WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1)', [scopeId]);
      await pool.query('DELETE FROM ledger_postings WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1)', [scopeId]);
      await pool.query('DELETE FROM ledger_entries WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM ledger_accounts WHERE scope_id=$1', [scopeId]);
    }
    if (eventId !== null) await pool.query('DELETE FROM business_event_evidence WHERE event_id=$1', [eventId]);
    if (eventId !== null) await pool.query('DELETE FROM business_events WHERE id=$1', [eventId]);
    if (receiptId !== null) await pool.query('DELETE FROM receipt_fiscal_facts WHERE receipt_id=$1', [receiptId]);
    if (receiptId !== null) await pool.query('DELETE FROM receipts WHERE id=$1', [receiptId]);
    if (scopeId !== null) await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]);
    await pool.end();
  }
});

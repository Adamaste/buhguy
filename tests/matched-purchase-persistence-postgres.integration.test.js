import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import pg from 'pg';
import { loadBankReceiptMatching } from '../src/bank-receipt-matching.js';
import { persistMatchedPurchase, persistMatchedPurchaseForTest } from '../src/matched-purchase-persistence.js';
import { businessEventEvidenceSemanticKey, BusinessEventGraphRepository, GRAPH_MODEL_VERSION, SYSTEM_DERIVED } from '../src/business-event-graph.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';
import { rebuildLedger, refreshLedgerForReceipt } from '../src/ledger.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const hash = (letter) => letter.repeat(64);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
let fixtureSequence = 0;

async function createFixture(pool, prefix, { standalone = false, amount = '12.34' } = {}) {
  const suffix = `${process.pid}-${Date.now()}-${fixtureSequence += 1}`;
  const scopeKey = `${prefix}-scope-${suffix}`;
  const receiptKey = `${prefix}-receipt-${suffix}`;
  const sourceKey = `${prefix}-source-${suffix}`;
  const fnsKey = `${prefix}-fns-${suffix}`;
  const client = await pool.connect();
  let fixture;
  try {
    await client.query('BEGIN');
    const scopeId = Number((await client.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, prefix])).rows[0].id);
    const personId = Number((await client.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, `${prefix}-person-${suffix}`, prefix])).rows[0].id);
    const accountId = Number((await client.query('INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,$2,$3,\'RUB\') RETURNING id', [scopeId, `${prefix}-bank-${suffix}`, `${prefix} account`])).rows[0].id);
    const sourceId = Number((await client.query('INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,\'ANDROID_NOTIFICATION\',$2) RETURNING id', [sourceKey, prefix])).rows[0].id);
    await client.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [sourceId, personId]);
    await client.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES($1,$2,'OWNER','fixture','fixture')", [accountId, personId]);
    const observationId = Number((await client.query('INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256) VALUES($1,$2,NOW(),NOW(),\'{}\',$3) RETURNING id', [sourceId, digest(`dedup:${suffix}`), digest(`payload:${suffix}`)])).rows[0].id);
    const tx = (await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality) VALUES($1,NOW(),$2,'RUB','DEBIT','PURCHASE','READY','fixture','EXACT') RETURNING id,occurred_at", [observationId, amount])).rows[0];
    const txId = Number(tx.id);
    await client.query("INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES($1,$2,'EXACT','fixture','fixture')", [txId, accountId]);
    const receipt = (await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES($1,NOW(),'fixture',$2,'RUB') RETURNING id,date_time", [receiptKey, amount])).rows[0];
    const receiptId = Number(receipt.id);
    const fnsSourceId = Number((await client.query('INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref) VALUES($1,$2,$3,\'fixture\',\'fixture\') RETURNING id', [scopeId, fnsKey, prefix])).rows[0].id);
    await client.query('INSERT INTO fns_source_person(fns_source_id,person_id) VALUES($1,$2)', [fnsSourceId, personId]);
    await client.query("INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,$3)", [receiptId, fnsSourceId, `source-receipt-${suffix}`]);
    const itemId = Number((await client.query("INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum) VALUES($1,0,'fixture','1',$2,$2) RETURNING id", [receiptId, amount])).rows[0].id);
    await client.query("INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256) VALUES($1,'fiscal-normalizer-v1',4,$2)", [itemId, digest(`item:${suffix}`)]);
    await client.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO',$4,'PRESENT_VALUE','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','UNKNOWN')", [receiptId, digest(`source:${suffix}`), digest(`normalized:${suffix}`), amount]);
    await client.query('COMMIT');
    fixture = { scopeId, scopeKey, personId, accountId, sourceId, observationId, txId, txOccurredAt: tx.occurred_at, receiptId, receiptDateTime: receipt.date_time, suffix };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  if (standalone) {
    await persistStandalonePurchases(pool, { scopeKey, receiptIds: [fixture.receiptId] });
    fixture.eventId = Number((await pool.query("SELECT ev.event_id FROM business_event_evidence ev JOIN business_events e ON e.id=ev.event_id WHERE ev.receipt_id=$1 AND e.scope_id=$2 AND ev.evidence_role='PURCHASE_EVIDENCE'", [fixture.receiptId, fixture.scopeId])).rows[0].event_id);
    await rebuildLedger(pool, { scopeKey, eventIds: [fixture.eventId] });
  }
  return fixture;
}

async function writerOptions(fixture) {
  return { scopeKey: fixture.scopeKey, internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000 };
}

async function snapshotScope(pool, scopeId) {
  const queries = {
    matches: ['SELECT * FROM bank_receipt_matches WHERE scope_id=$1 ORDER BY id', [scopeId]],
    events: ['SELECT * FROM business_events WHERE scope_id=$1 ORDER BY id', [scopeId]],
    evidence: ['SELECT ev.* FROM business_event_evidence ev JOIN business_events e ON e.id=ev.event_id WHERE e.scope_id=$1 ORDER BY ev.id', [scopeId]],
    bankEvidence: ['SELECT * FROM business_event_bank_evidence WHERE scope_id=$1 ORDER BY id', [scopeId]],
    accounts: ['SELECT * FROM ledger_accounts WHERE scope_id=$1 ORDER BY id', [scopeId]],
    entries: ['SELECT * FROM ledger_entries WHERE scope_id=$1 ORDER BY id', [scopeId]],
    postings: ['SELECT p.* FROM ledger_postings p JOIN ledger_entries e ON e.id=p.ledger_entry_id WHERE e.scope_id=$1 ORDER BY p.id', [scopeId]],
    links: ['SELECT l.* FROM ledger_source_links l JOIN ledger_entries e ON e.id=l.ledger_entry_id WHERE e.scope_id=$1 ORDER BY l.id', [scopeId]],
    supersessions: ['SELECT * FROM ledger_entry_supersessions WHERE scope_id=$1 ORDER BY id', [scopeId]],
    runs: ['SELECT * FROM reconciliation_runs WHERE scope_id=$1 ORDER BY id', [scopeId]],
    facts: ['SELECT f.* FROM certification_facts f WHERE f.scope_id=$1 ORDER BY f.id', [scopeId]],
  };
  const result = {};
  for (const [name, [sql, params]] of Object.entries(queries)) result[name] = (await pool.query(sql, params)).rows;
  return JSON.stringify(result);
}

integration('matched purchase writer persists one atomic, replayable bank-funded purchase', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let scopeId; let accountId; let receiptId; let txId; let eventId; let sourceId; let observationId; let personId; let fnsSourceId;
  try {
    await client.query('BEGIN');
    scopeId = Number((await client.query("INSERT INTO accounting_scopes(scope_key,label) VALUES('writer-v1-scope','fixture') RETURNING id")).rows[0].id);
    personId = Number((await client.query("INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,'writer-v1-person','fixture') RETURNING id", [scopeId])).rows[0].id);
    accountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'writer-bank','writer account','RUB') RETURNING id", [scopeId])).rows[0].id);
    sourceId = Number((await client.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES('writer-v1-source','ANDROID_NOTIFICATION','fixture') RETURNING id")).rows[0].id);
    await client.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [sourceId, personId]);
    await client.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES($1,$2,'OWNER','fixture','fixture')", [accountId, personId]);
    observationId = Number((await client.query("INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256) VALUES($1,$2,NOW(),NOW(),'{}',$3) RETURNING id", [sourceId, hash('a'), hash('b')])).rows[0].id);
    const txRow = (await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality) VALUES($1,NOW(),'12.34','RUB','DEBIT','PURCHASE','READY','fixture','EXACT') RETURNING id,occurred_at", [observationId])).rows[0];
    txId = Number(txRow.id);
    await client.query("INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES($1,$2,'EXACT','fixture','fixture')", [txId, accountId]);
    const receiptRow = (await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES('writer-v1-receipt',NOW(),'fixture','12.34','RUB') RETURNING id,date_time")).rows[0];
    receiptId = Number(receiptRow.id);
    fnsSourceId = Number((await client.query("INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref) VALUES($1,'writer-v1-fns-source','fixture','fixture','fixture') RETURNING id", [scopeId])).rows[0].id);
    await client.query("INSERT INTO fns_source_person(fns_source_id,person_id) VALUES($1,$2)", [fnsSourceId, personId]);
    await client.query("INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,'writer-v1-source-receipt')", [receiptId, fnsSourceId]);
    const itemId = Number((await client.query("INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum) VALUES($1,0,'fixture','1','12.34','12.34') RETURNING id", [receiptId])).rows[0].id);
    await client.query("INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256) VALUES($1,'fiscal-normalizer-v1',4,$2)", [itemId, hash('e')]);
    await client.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO','12.34','PRESENT_VALUE','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','UNKNOWN')", [receiptId, hash('c'), hash('d')]);
    await client.query('COMMIT');

    const writerOptions = { scopeKey: 'writer-v1-scope', internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000 };
    const matching = await loadBankReceiptMatching(pool, writerOptions);
    assert.equal(matching.matches.length, 1, JSON.stringify({
      summary: matching.summary,
      bankStatuses: matching.bankStatuses,
      receiptStatuses: matching.receiptStatuses,
    }));
    const result = await persistMatchedPurchase(pool, writerOptions);
    const replay = await persistMatchedPurchase(pool, writerOptions);
    assert.equal(result.matchId, replay.matchId);
    assert.equal(result.eventId, replay.eventId);
    assert.equal(result.ledgerEntryId, replay.ledgerEntryId);
    assert.equal(result.enrichmentKey, replay.enrichmentKey);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM bank_receipt_matches WHERE bank_transaction_id=$1", [txId])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_entries WHERE source_event_id=$1 AND derivation_rule='LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1'", [result.eventId])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM certification_facts WHERE ledger_entry_id=$1 AND metric_code='FISCAL_NEW_MONEY'", [result.ledgerEntryId])).rows[0].count, 0);
    const link = (await pool.query("SELECT graph_evidence_id FROM ledger_source_links WHERE ledger_entry_id=$1 AND bank_receipt_match_id=$2", [result.ledgerEntryId, result.matchId])).rows[0];
    const receiptEvidence = (await pool.query("SELECT id FROM business_event_evidence WHERE event_id=$1 AND receipt_id=$2 AND evidence_role='PURCHASE_EVIDENCE'", [result.eventId, receiptId])).rows[0];
    assert.equal(Number(link.graph_evidence_id), Number(receiptEvidence.id));
    assert.equal((await pool.query("SELECT enrichment_key FROM business_event_bank_evidence WHERE id=$1", [result.bankEvidenceId])).rows[0].enrichment_key, result.enrichmentKey);
    eventId = result.eventId;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    if (scopeId) await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]).catch(() => {});
    client.release(); await pool.end();
  }
});

integration('real standalone purchase is refined append-only and replays through canonical evidence', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'refine', { standalone: true });
    const options = await writerOptions(fixture);
    const before = await pool.query('SELECT id,scope_id,source_event_id,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description FROM ledger_entries WHERE scope_id=$1 ORDER BY id', [fixture.scopeId]);
    const oldEntry = before.rows.find((row) => row.derivation_rule === 'LEDGER_STANDALONE_PURCHASE_V1');
    const oldPostings = (await pool.query('SELECT * FROM ledger_postings WHERE ledger_entry_id=$1 ORDER BY id', [oldEntry.id])).rows;
    const oldLinks = (await pool.query('SELECT * FROM ledger_source_links WHERE ledger_entry_id=$1 ORDER BY id', [oldEntry.id])).rows;
    const result = await persistMatchedPurchase(pool, options);
    const replay = await persistMatchedPurchase(pool, options);
    assert.equal(replay.enrichmentKey, result.enrichmentKey);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_entry_supersessions WHERE scope_id=$1", [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger_entries e WHERE e.scope_id=$1 AND e.source_event_id=$2 AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)`, [fixture.scopeId, fixture.eventId])).rows[0].count, 1);
    assert.deepEqual((await pool.query('SELECT id,scope_id,source_event_id,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description FROM ledger_entries WHERE id=$1', [oldEntry.id])).rows, before.rows.filter((row) => Number(row.id) === Number(oldEntry.id)));
    assert.deepEqual((await pool.query('SELECT * FROM ledger_postings WHERE ledger_entry_id=$1 ORDER BY id', [oldEntry.id])).rows, oldPostings);
    assert.deepEqual((await pool.query('SELECT * FROM ledger_source_links WHERE ledger_entry_id=$1 ORDER BY id', [oldEntry.id])).rows, oldLinks);
    const evidence = (await pool.query("SELECT * FROM business_event_evidence WHERE event_id=$1 AND receipt_id=$2 AND evidence_role='PURCHASE_EVIDENCE'", [fixture.eventId, fixture.receiptId])).rows[0];
    assert.equal(evidence.semantic_key, businessEventEvidenceSemanticKey({ scopeKey: fixture.scopeKey, eventId: fixture.eventId, receiptId: fixture.receiptId, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'PURCHASE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'STANDALONE_PURCHASE_V1', ruleVersion: 'standalone-purchase-v1', resolutionStatus: 'CONFIRMED' }));
  } finally { await pool.end(); }
});

integration('public authoritative writer is concurrent-safe and stable with unrelated evidence', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'concurrency');
    const options = await writerOptions(fixture);
    const [first, second] = await Promise.all([persistMatchedPurchase(pool, options), persistMatchedPurchase(pool, options)]);
    assert.equal(first.matchId, second.matchId);
    assert.equal(first.eventId, second.eventId);
    assert.equal(first.ledgerEntryId, second.ledgerEntryId);
    assert.equal(first.enrichmentKey, second.enrichmentKey);
    const graph = new BusinessEventGraphRepository(pool);
    await graph.createEvidenceLink({ eventId: first.eventId, receiptId: fixture.receiptId, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'UNRELATED_REVIEW_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'STANDALONE_PURCHASE_V1', ruleVersion: 'standalone-purchase-v1' });
    const replay = await persistMatchedPurchase(pool, options);
    assert.equal(replay.eventId, first.eventId);
    assert.equal(replay.enrichmentKey, first.enrichmentKey);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM business_event_bank_evidence WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_entries WHERE scope_id=$1 AND derivation_rule='LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1'", [fixture.scopeId])).rows[0].count, 1);
  } finally { await pool.end(); }
});

integration('writer rollback restores every writer-owned table at each failure boundary', { concurrency: false }, async () => {
  const stages = ['match', 'purchase', 'ledger', 'certification'];
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    for (const stage of stages) {
      const fixture = await createFixture(pool, `rollback-${stage}`);
      const before = await snapshotScope(pool, fixture.scopeId);
      const options = await writerOptions(fixture);
      await assert.rejects(() => persistMatchedPurchase(pool, { ...options, failAfter: stage }), (error) => error.code === 'INJECTED_WRITER_FAILURE');
      assert.equal(await snapshotScope(pool, fixture.scopeId), before, `rollback changed state after ${stage}`);
    }
  } finally { await pool.end(); }
});

integration('refresh and rebuild fail closed for future and refined protected states', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    for (const [prefix, standalone] of [['future-refresh', false], ['refine-refresh', true]]) {
      const fixture = await createFixture(pool, prefix, { standalone });
      const options = await writerOptions(fixture);
      await persistMatchedPurchase(pool, options);
      const before = await snapshotScope(pool, fixture.scopeId);
      await assert.rejects(() => refreshLedgerForReceipt(pool, { scopeKey: fixture.scopeKey, receiptId: fixture.receiptId }), (error) => error.code === 'LEDGER_SUPERSESSION_PROTECTED');
      await assert.rejects(() => rebuildLedger(pool, { scopeKey: fixture.scopeKey, eventIds: [fixture.eventId], replace: true }), (error) => error.code === 'LEDGER_SUPERSESSION_PROTECTED');
      assert.equal(await snapshotScope(pool, fixture.scopeId), before);
    }
  } finally { await pool.end(); }
});

integration('persisted provenance conflicts fail closed without writer mutation', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const cases = ['foreign-link', 'wrong-posting', 'bank-evidence', 'malformed-supersession'];
    for (const kind of cases) {
      const fixture = await createFixture(pool, `conflict-${kind}`, { standalone: kind === 'malformed-supersession' });
      const options = await writerOptions(fixture);
      const initial = await persistMatchedPurchase(pool, options);
      if (kind === 'foreign-link') {
        const foreign = await createFixture(pool, `foreign-${fixture.suffix}`);
        const foreignResult = await persistMatchedPurchase(pool, await writerOptions(foreign));
        await pool.query('UPDATE ledger_source_links SET bank_receipt_match_id=$1,bank_transaction_id=$2 WHERE ledger_entry_id=$3', [foreignResult.matchId, foreign.txId, initial.ledgerEntryId]);
      } else if (kind === 'wrong-posting') {
        const control = Number((await pool.query("SELECT id FROM ledger_accounts WHERE scope_id=$1 AND account_code='UNCLASSIFIED_ACQUISITION'", [fixture.scopeId])).rows[0].id);
        await pool.query('UPDATE ledger_postings SET account_id=$1 WHERE ledger_entry_id=$2 AND credit>0', [control, initial.ledgerEntryId]);
      } else if (kind === 'bank-evidence') {
        await pool.query("UPDATE business_event_bank_evidence SET enrichment_key=$1 WHERE business_event_id=$2", [hash('z'), initial.eventId]);
      } else {
        await pool.query("UPDATE ledger_entry_supersessions SET reason_code='MALFORMED' WHERE business_event_id=$1", [initial.eventId]);
      }
      const before = await snapshotScope(pool, fixture.scopeId);
      await assert.rejects(() => persistMatchedPurchase(pool, options), (error) => ['LEDGER_CONFLICT', 'LEDGER_SOURCE_LINK_CONFLICT', 'BANK_EVIDENCE_CONFLICT', 'LEDGER_SUPERSESSION_CONFLICT'].includes(error.code));
      assert.equal(await snapshotScope(pool, fixture.scopeId), before, kind);
    }
  } finally { await pool.end(); }
});

integration('ambiguous test-only matcher hook is isolated and fails closed', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'ambiguous-loader');
    const options = await writerOptions(fixture);
    const matching = await loadBankReceiptMatching(pool, options);
    const before = await snapshotScope(pool, fixture.scopeId);
    await assert.rejects(() => persistMatchedPurchaseForTest(pool, { ...options, matchingLoader: async () => ({ matches: [matching.matches[0], { ...matching.matches[0], matchKey: hash('q') }] }) }), (error) => error.code === 'MATCH_SELECTION_REQUIRED');
    assert.equal(await snapshotScope(pool, fixture.scopeId), before);
  } finally { await pool.end(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadBankReceiptMatching } from '../src/bank-receipt-matching.js';
import { persistMatchedPurchase, persistMatchedPurchaseForTest } from '../src/matched-purchase-persistence.js';
import { loadMatchedPurchaseEnrichment, LEDGER_DISPOSITIONS } from '../src/matched-purchase-enrichment-projection.js';
import { businessEventEvidenceSemanticKey, BusinessEventGraphRepository, GRAPH_MODEL_VERSION, SYSTEM_DERIVED } from '../src/business-event-graph.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';
import { certificationSourceStateKey, CERTIFICATION_MODEL_VERSION } from '../src/certification.js';
import { rebuildLedger, refreshLedgerForReceipt } from '../src/ledger.js';
import { bindBankSourceProviderAccount } from '../src/bank-source-provider-binding.js';
import { lockMatchedPurchaseBankTransaction, lockMatchedPurchaseSourceProvider } from '../src/matched-purchase-locks.js';
import { resolveBankTransactionAccount } from '../src/bank-account-resolution.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const hash = (letter) => letter.repeat(64);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
let fixtureSequence = 0;

async function createFixture(pool, prefix, { standalone = false, amount = '12.34', receiptCurrency = 'RUB' } = {}) {
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
    const receipt = (await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency,operation_type) VALUES($1,NOW(),'fixture',$2,$3,1) RETURNING id,date_time", [receiptKey, amount, receiptCurrency])).rows[0];
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
    results: ['SELECT r.* FROM reconciliation_results r JOIN reconciliation_runs rr ON rr.id=r.run_id WHERE rr.scope_id=$1 ORDER BY r.id', [scopeId]],
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
    assert.equal(evidence.semantic_key, businessEventEvidenceSemanticKey({ scopeKey: fixture.scopeKey, eventId: fixture.eventId, receiptId: fixture.receiptId, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'PURCHASE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'STANDALONE_PURCHASE_V1', ruleVersion: 'standalone-purchase-v1', resolutionStatus: 'CONFIRMED', currency: 'RUB' }));
  } finally { await pool.end(); }
});

integration('FNS source contract derives RUB for writer revalidation without changing receipt currency', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'derived-rub', { receiptCurrency: null });
    const options = await writerOptions(fixture);
    const matching = await loadBankReceiptMatching(pool, options);
    assert.equal(matching.matches.length, 1);
    assert.equal(matching.matches[0].currency, 'RUB');
    assert.equal(matching.matches[0].receiptCurrencyResolution.basis, 'FNS_SOURCE_CONTRACT');
    const result = await persistMatchedPurchase(pool, options);
    const receipt = (await pool.query('SELECT currency FROM receipts WHERE id=$1', [fixture.receiptId])).rows[0];
    assert.equal(receipt.currency, null);
    assert.equal((await pool.query('SELECT currency FROM bank_receipt_matches WHERE id=$1', [result.matchId])).rows[0].currency, 'RUB');
  } finally { await pool.end(); }
});

integration('FNS-derived RUB refines a real standalone purchase through the public writer', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'derived-rub-refine', { standalone: true, receiptCurrency: null });
    const options = await writerOptions(fixture);
    const matching = await loadBankReceiptMatching(pool, options);
    assert.equal(matching.matches.length, 1);
    assert.equal(matching.matches[0].receiptCurrencyResolution.basis, 'FNS_SOURCE_CONTRACT');
    const enrichment = await loadMatchedPurchaseEnrichment(pool, {
      ...options,
      matchKey: matching.matches[0].matchKey,
      matchingLoader: async () => matching,
    });
    assert.equal(enrichment.ledgerDisposition, LEDGER_DISPOSITIONS.REFINE_EXISTING_FISCAL_FUNDING);
    const oldEntry = (await pool.query("SELECT * FROM ledger_entries WHERE scope_id=$1 AND derivation_rule='LEDGER_STANDALONE_PURCHASE_V1'", [fixture.scopeId])).rows[0];
    const oldPostings = (await pool.query('SELECT * FROM ledger_postings WHERE ledger_entry_id=$1 ORDER BY id', [oldEntry.id])).rows;
    const oldLinks = (await pool.query('SELECT * FROM ledger_source_links WHERE ledger_entry_id=$1 ORDER BY id', [oldEntry.id])).rows;
    const result = await persistMatchedPurchase(pool, options);
    const firstSnapshot = await snapshotScope(pool, fixture.scopeId);
    assert.equal(result.eventId, fixture.eventId);
    assert.equal((await pool.query('SELECT currency FROM receipts WHERE id=$1', [fixture.receiptId])).rows[0].currency, null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM business_event_bank_evidence WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
    const supersession = (await pool.query('SELECT * FROM ledger_entry_supersessions WHERE scope_id=$1', [fixture.scopeId])).rows;
    assert.equal(supersession.length, 1);
    assert.equal(Number(supersession[0].superseded_ledger_entry_id), Number(oldEntry.id));
    assert.equal(Number(supersession[0].replacement_ledger_entry_id), Number(result.ledgerEntryId));
    assert.deepEqual((await pool.query('SELECT * FROM ledger_entries WHERE id=$1', [oldEntry.id])).rows, [oldEntry]);
    assert.deepEqual((await pool.query('SELECT * FROM ledger_postings WHERE ledger_entry_id=$1 ORDER BY id', [oldEntry.id])).rows, oldPostings);
    assert.deepEqual((await pool.query('SELECT * FROM ledger_source_links WHERE ledger_entry_id=$1 ORDER BY id', [oldEntry.id])).rows, oldLinks);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger_entries e
      WHERE e.scope_id=$1 AND e.source_event_id=$2 AND e.origin='SYSTEM_DERIVED'
        AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)`, [fixture.scopeId, fixture.eventId])).rows[0].count, 1);
    const newPostings = (await pool.query(`SELECT p.*, a.account_code FROM ledger_postings p
      JOIN ledger_accounts a ON a.id=p.account_id WHERE p.ledger_entry_id=$1 ORDER BY p.id`, [result.ledgerEntryId])).rows;
    assert.deepEqual(newPostings.map((row) => ({ accountCode: row.account_code, currency: row.currency, debit: String(row.debit), credit: String(row.credit), sourceReceiptId: Number(row.source_receipt_id) })).sort((a, b) => a.accountCode.localeCompare(b.accountCode)), [
      { accountCode: 'FINANCIAL_ACCOUNT:' + fixture.accountId, currency: 'RUB', debit: '0.00', credit: '12.34', sourceReceiptId: fixture.receiptId },
      { accountCode: 'UNCLASSIFIED_ACQUISITION', currency: 'RUB', debit: '12.34', credit: '0.00', sourceReceiptId: fixture.receiptId },
    ].sort((a, b) => a.accountCode.localeCompare(b.accountCode)));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM certification_facts WHERE ledger_entry_id=$1", [oldEntry.id])).rows[0].count, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM certification_facts WHERE ledger_entry_id=$1 AND metric_code='FISCAL_NEW_MONEY'", [result.ledgerEntryId])).rows[0].count, 0);
    const replay = await persistMatchedPurchase(pool, options);
    assert.equal(replay.matchId, result.matchId);
    assert.equal(replay.eventId, result.eventId);
    assert.equal(replay.ledgerEntryId, result.ledgerEntryId);
    assert.equal(replay.enrichmentKey, result.enrichmentKey);
    assert.equal(replay.bankEvidenceId, result.bankEvidenceId);
    assert.equal(await snapshotScope(pool, fixture.scopeId), firstSnapshot);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM business_event_bank_evidence WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_entries WHERE scope_id=$1 AND derivation_rule='LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1'", [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_entry_supersessions WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_postings p JOIN ledger_entries e ON e.id=p.ledger_entry_id WHERE e.scope_id=$1 AND e.derivation_rule=\'LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1\'', [fixture.scopeId])).rows[0].count, 2);
  } finally { await pool.end(); }
});

integration('protected purchase overlay survives an independent ledger append and replay', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'protected-append', { standalone: true, amount: '12.34' });
    await persistMatchedPurchase(pool, await writerOptions(fixture));
    const protectedState = async () => ({
      entries: (await pool.query(`SELECT id,source_event_id,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,reason_code,description
        FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2 ORDER BY id`, [fixture.scopeId, fixture.eventId])).rows,
      postings: (await pool.query(`SELECT p.*,a.account_code FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
        WHERE p.ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2) ORDER BY p.id`, [fixture.scopeId, fixture.eventId])).rows,
      links: (await pool.query(`SELECT * FROM ledger_source_links WHERE ledger_entry_id IN
        (SELECT id FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2) ORDER BY id`, [fixture.scopeId, fixture.eventId])).rows,
      supersessions: (await pool.query('SELECT * FROM ledger_entry_supersessions WHERE scope_id=$1 AND business_event_id=$2 ORDER BY id', [fixture.scopeId, fixture.eventId])).rows,
    });
    const before = await protectedState();
    const suffix = `${process.pid}-${Date.now()}`;
    const receiptId = Number((await pool.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency,operation_type) VALUES($1,NOW(),'fixture',7.89,'RUB',1) RETURNING id", [`protected-append-receipt-${suffix}`])).rows[0].id);
    const fnsSourceId = Number((await pool.query('SELECT id FROM fns_sources WHERE scope_id=$1 ORDER BY id LIMIT 1', [fixture.scopeId])).rows[0].id);
    await pool.query('INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,$3)', [receiptId, fnsSourceId, `protected-append-source-${suffix}`]);
    const itemId = Number((await pool.query("INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum) VALUES($1,0,'independent','1',7.89,7.89) RETURNING id", [receiptId])).rows[0].id);
    await pool.query("INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256) VALUES($1,'fiscal-normalizer-v1',4,$2)", [itemId, hash('p')]);
    await pool.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO','7.89','PRESENT_VALUE','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','UNKNOWN')", [receiptId, hash('q'), hash('r')]);
    await persistStandalonePurchases(pool, { scopeKey: fixture.scopeKey, receiptIds: [receiptId] });
    const independentEventId = Number((await pool.query("SELECT ev.event_id FROM business_event_evidence ev JOIN business_events e ON e.id=ev.event_id WHERE ev.receipt_id=$1 AND e.scope_id=$2 AND ev.evidence_role='PURCHASE_EVIDENCE'", [receiptId, fixture.scopeId])).rows[0].event_id);
    const appended = await rebuildLedger(pool, { scopeKey: fixture.scopeKey });
    assert.equal(appended.changed, undefined);
    assert.equal(appended.created.entries, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2', [fixture.scopeId, independentEventId])).rows[0].count, 1);
    assert.deepEqual(await protectedState(), before);
    const replay = await rebuildLedger(pool, { scopeKey: fixture.scopeKey });
    assert.equal(replay.changed, false);
    assert.equal(replay.created.entries, 0);
    assert.deepEqual(await protectedState(), before);
  } finally { await pool.end(); }
});

integration('writer fails closed when FNS currency proof disappears before locked revalidation', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'derived-rub-proof-race', { receiptCurrency: null });
    const options = await writerOptions(fixture);
    const before = await snapshotScope(pool, fixture.scopeId);
    let calls = 0;
    await assert.rejects(() => persistMatchedPurchaseForTest(pool, {
      ...options,
      matchingLoader: async (client, loaderOptions) => {
        const result = await loadBankReceiptMatching(client, loaderOptions);
        calls += 1;
        if (calls === 1) await pool.query('DELETE FROM receipt_source_observations WHERE receipt_id=$1', [fixture.receiptId]);
        return result;
      },
    }), (error) => error.code === 'AUTHORITATIVE_MATCH_CHANGED' || error.code === 'AUTHORITATIVE_INPUT_CHANGED');
    assert.equal(await snapshotScope(pool, fixture.scopeId), before);
  } finally { await pool.end(); }
});

integration('public writer rejects unproven and non-RUB receipt currency without mutation', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const unproven = await createFixture(pool, 'currency-unproven', { receiptCurrency: null });
    await pool.query('DELETE FROM receipt_source_observations WHERE receipt_id=$1', [unproven.receiptId]);
    const unprovenBefore = await snapshotScope(pool, unproven.scopeId);
    const unprovenOptions = await writerOptions(unproven);
    await assert.rejects(() => persistMatchedPurchase(pool, unprovenOptions), (error) => error.code === 'MATCH_NOT_FOUND');
    assert.equal(await snapshotScope(pool, unproven.scopeId), unprovenBefore);

    const nonRub = await createFixture(pool, 'currency-non-rub', { receiptCurrency: 'USD' });
    const nonRubBefore = await snapshotScope(pool, nonRub.scopeId);
    const nonRubOptions = await writerOptions(nonRub);
    await assert.rejects(() => persistMatchedPurchase(pool, nonRubOptions), (error) => error.code === 'MATCH_NOT_FOUND');
    assert.equal(await snapshotScope(pool, nonRub.scopeId), nonRubBefore);
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
    assert.equal(first.bankEvidenceId, second.bankEvidenceId);
    assert.equal(first.ledgerEntryId, second.ledgerEntryId);
    assert.equal(first.enrichmentKey, second.enrichmentKey);

    const concurrentSourceStateKey = await certificationSourceStateKey(pool, fixture.scopeId);
    const certificationRuns = (await pool.query(`SELECT * FROM reconciliation_runs
      WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
        AND period_from IS NULL AND period_to IS NULL`, [fixture.scopeId, CERTIFICATION_MODEL_VERSION, concurrentSourceStateKey])).rows;
    assert.equal(certificationRuns.length, 1);
    assert.equal(certificationRuns[0].status, 'READY');
    const certificationRun = certificationRuns[0];
    const certificationSnapshot = async (runId) => ({
      run: (await pool.query('SELECT * FROM reconciliation_runs WHERE id=$1', [runId])).rows,
      facts: (await pool.query('SELECT * FROM certification_facts WHERE run_id=$1 ORDER BY id', [runId])).rows,
      results: (await pool.query('SELECT * FROM reconciliation_results WHERE run_id=$1 ORDER BY id', [runId])).rows,
    });
    const beforeReplay = await certificationSnapshot(certificationRun.id);

    const sameStateReplay = await persistMatchedPurchase(pool, options);
    assert.equal(sameStateReplay.matchId, first.matchId);
    assert.equal(sameStateReplay.eventId, first.eventId);
    assert.equal(sameStateReplay.bankEvidenceId, first.bankEvidenceId);
    assert.equal(sameStateReplay.ledgerEntryId, first.ledgerEntryId);
    assert.equal(sameStateReplay.enrichmentKey, first.enrichmentKey);
    assert.equal(await certificationSourceStateKey(pool, fixture.scopeId), concurrentSourceStateKey);
    assert.deepEqual(await certificationSnapshot(certificationRun.id), beforeReplay);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM reconciliation_runs
      WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
        AND period_from IS NULL AND period_to IS NULL`, [fixture.scopeId, CERTIFICATION_MODEL_VERSION, concurrentSourceStateKey])).rows[0].count, 1);

    const graph = new BusinessEventGraphRepository(pool);
    await graph.createEvidenceLink({ eventId: first.eventId, receiptId: fixture.receiptId, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'UNRELATED_REVIEW_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'STANDALONE_PURCHASE_V1', ruleVersion: 'standalone-purchase-v1' });
    const replay = await persistMatchedPurchase(pool, options);
    const changedSourceStateKey = await certificationSourceStateKey(pool, fixture.scopeId);
    assert.equal(replay.eventId, first.eventId);
    assert.equal(replay.enrichmentKey, first.enrichmentKey);
    assert.notEqual(changedSourceStateKey, concurrentSourceStateKey);
    const changedSourceStateRuns = (await pool.query(`SELECT * FROM reconciliation_runs
      WHERE scope_id=$1 AND model_version=$2 AND period_from IS NULL AND period_to IS NULL
      ORDER BY id`, [fixture.scopeId, CERTIFICATION_MODEL_VERSION])).rows;
    assert.equal(changedSourceStateRuns.length, 2);
    assert.equal(changedSourceStateRuns[0].source_state_key, concurrentSourceStateKey);
    assert.equal(changedSourceStateRuns[1].source_state_key, changedSourceStateKey);
    assert.equal(changedSourceStateRuns[0].status, 'READY');
    assert.equal(changedSourceStateRuns[1].status, 'READY');
    assert.deepEqual(await certificationSnapshot(certificationRun.id), beforeReplay);
    const changedSnapshot = await certificationSnapshot(changedSourceStateRuns[1].id);
    assert.equal(changedSnapshot.facts.length > 0, true);
    assert.equal(changedSnapshot.results.length > 0, true);
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
      const result = await persistMatchedPurchase(pool, options);
      fixture.eventId = result.eventId;
      const before = await snapshotScope(pool, fixture.scopeId);
      await assert.rejects(() => refreshLedgerForReceipt(pool, { scopeKey: fixture.scopeKey, receiptId: fixture.receiptId }), (error) => error.code === 'LEDGER_SUPERSESSION_PROTECTED');
      await assert.rejects(() => rebuildLedger(pool, { scopeKey: fixture.scopeKey, eventIds: [fixture.eventId], replace: true }), (error) => error.code === 'LEDGER_SUPERSESSION_PROTECTED');
      await assert.rejects(
        () => rebuildLedger(pool, { scopeKey: fixture.scopeKey, eventIds: [fixture.eventId] }),
        (error) => error.code === 'LEDGER_PROTECTED_OVERLAY_CONFLICT',
      );
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
        await pool.query("UPDATE business_event_bank_evidence SET enrichment_key=$1 WHERE business_event_id=$2", [digest('malformed enrichment'), initial.eventId]);
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

integration('matched purchase writer is idempotent under the restricted runtime DML matrix', { concurrency: false }, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let runtime;
  let fixture;
  let roleCreated = false;
  const password = crypto.randomBytes(24).toString('base64url');
  const writerTables = [
    'bank_receipt_matches', 'business_graph_rules', 'business_events', 'business_event_evidence',
    'business_event_bank_evidence', 'ledger_accounts', 'ledger_entries', 'ledger_postings',
    'ledger_source_links', 'ledger_entry_supersessions', 'reconciliation_runs',
    'certification_facts', 'reconciliation_results',
  ];
  try {
    const existingRole = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='receipt_collector'");
    if (existingRole.rowCount) {
      await admin.query('DROP OWNED BY receipt_collector');
      await admin.query('DROP ROLE receipt_collector');
    }
    await admin.query(`CREATE ROLE receipt_collector LOGIN PASSWORD '${password}'`);
    roleCreated = true;
    await admin.query('GRANT USAGE ON SCHEMA public TO receipt_collector');
    for (const migration of [
      '016_runtime_identity_lookup_grants.sql',
      '017_bank_source_provider_account_bindings.sql',
      '020_runtime_payment_instrument_account_lookup.sql',
      '021_matched_purchase_writer_privileges.sql',
    ]) {
      await admin.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
    }

    const tableWideSelectCount = Number((await admin.query(`SELECT count(*)::int AS count
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND has_table_privilege('receipt_collector',c.oid,'SELECT')`)).rows[0].count);
    assert.equal(tableWideSelectCount, 0, 'runtime role must not receive table-wide SELECT grants');
    assert.equal((await admin.query("SELECT has_column_privilege('receipt_collector','public.bank_event_observations','payload','SELECT') AS allowed")).rows[0].allowed, false, 'runtime role must not read raw bank notification payloads');

    const privilegeRows = (await admin.query(`SELECT table_name,
        has_table_privilege('receipt_collector',format('public.%I',table_name),'INSERT') AS table_insert,
        has_table_privilege('receipt_collector',format('public.%I',table_name),'UPDATE')
        OR has_any_column_privilege('receipt_collector',format('public.%I',table_name),'UPDATE') AS any_update,
        has_table_privilege('receipt_collector',format('public.%I',table_name),'DELETE')
        OR has_table_privilege('receipt_collector',format('public.%I',table_name),'TRUNCATE') AS destructive
      FROM unnest($1::text[]) AS table_name`, [writerTables])).rows;
    assert.equal(privilegeRows.every((row) => row.any_update === false), true, 'writer migration must not grant UPDATE on writer tables or columns');
    assert.equal(privilegeRows.every((row) => row.table_insert === false), true, 'writer migration must not grant table-wide INSERT');
    assert.equal(privilegeRows.every((row) => row.destructive === false), true, 'writer migration must not grant DELETE or TRUNCATE');
    const sequenceCount = Number((await admin.query(`SELECT count(*)::int AS count FROM unnest($1::text[]) s(name)
      WHERE has_sequence_privilege('receipt_collector',format('public.%I',name),'USAGE')`, [[
      'bank_receipt_matches_id_seq', 'business_events_id_seq', 'business_event_evidence_id_seq',
      'business_event_bank_evidence_id_seq', 'ledger_accounts_id_seq', 'ledger_entries_id_seq',
      'ledger_postings_id_seq', 'ledger_source_links_id_seq', 'ledger_entry_supersessions_id_seq',
      'reconciliation_runs_id_seq', 'certification_facts_id_seq', 'reconciliation_results_id_seq',
    ]])).rows[0].count);
    assert.equal(sequenceCount, 12);
    const sequenceReadCount = Number((await admin.query(`SELECT count(*)::int AS count FROM unnest($1::text[]) s(name)
      WHERE has_sequence_privilege('receipt_collector',format('public.%I',name),'SELECT')
        OR has_sequence_privilege('receipt_collector',format('public.%I',name),'UPDATE')`, [[
      'bank_receipt_matches_id_seq', 'business_events_id_seq', 'business_event_evidence_id_seq',
      'business_event_bank_evidence_id_seq', 'ledger_accounts_id_seq', 'ledger_entries_id_seq',
      'ledger_postings_id_seq', 'ledger_source_links_id_seq', 'ledger_entry_supersessions_id_seq',
      'reconciliation_runs_id_seq', 'certification_facts_id_seq', 'reconciliation_results_id_seq',
    ]])).rows[0].count);
    assert.equal(sequenceReadCount, 0, 'writer migration must grant only sequence USAGE');

    fixture = await createFixture(admin, 'restricted-writer');
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = 'receipt_collector';
    runtimeUrl.password = password;
    runtime = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 4 });
    const options = await writerOptions(fixture);
    const [first, concurrent] = await Promise.all([
      persistMatchedPurchase(runtime, options),
      persistMatchedPurchase(runtime, options),
    ]);
    assert.equal(first.matchId, concurrent.matchId);
    assert.equal(first.eventId, concurrent.eventId);
    assert.equal(first.ledgerEntryId, concurrent.ledgerEntryId);
    assert.equal(first.certification.refreshed === true || first.certification.reused === true, true);
    assert.ok(first.certification.facts > 0);
    assert.ok(first.certification.runId > 0);
    const replay = await persistMatchedPurchase(runtime, options);
    assert.equal(replay.matchId, first.matchId);
    assert.equal(replay.eventId, first.eventId);
    assert.equal(replay.ledgerEntryId, first.ledgerEntryId);
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM business_events WHERE id=$1 AND scope_id=$2', [first.eventId, fixture.scopeId])).rows[0].count, 1);
    const certificationRows = (await admin.query(`SELECT
        (SELECT count(*)::int FROM reconciliation_runs WHERE id=$1 AND scope_id=$2 AND status='READY') AS runs,
        (SELECT count(*)::int FROM certification_facts WHERE run_id=$1 AND business_event_id=$3) AS facts,
        (SELECT count(*)::int FROM reconciliation_results WHERE run_id=$1) AS results`, [first.certification.runId, fixture.scopeId, first.eventId])).rows[0];
    assert.equal(certificationRows.runs, 1);
    assert.ok(certificationRows.facts > 0);
    assert.ok(certificationRows.results > 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ledger_entries e
      WHERE e.scope_id=$1 AND e.source_event_id=$2 AND NOT EXISTS
        (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)`, [fixture.scopeId, first.eventId])).rows[0].count, 1);
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE bank_transaction_id=$1 AND receipt_id=$2', [fixture.txId, fixture.receiptId])).rows[0].count, 1);
  } finally {
    if (runtime) await runtime.end();
    if (fixture) await admin.query('DELETE FROM accounting_scopes WHERE id=$1', [fixture.scopeId]).catch(() => {});
    if (roleCreated) {
      await admin.query('DROP OWNED BY receipt_collector').catch(() => {});
      await admin.query('DROP ROLE receipt_collector').catch(() => {});
    }
    await admin.end();
  }
});

integration('account resolution and source/provider binding serialize with matched writer advisory keys', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  let fixture;
  let client;
  try {
    fixture = await createFixture(pool, 'shared-writer-lock');
    const provider = 'fixture.provider';
    const sourceKey = `shared-writer-${fixture.suffix}`;
    await pool.query('UPDATE bank_sources SET source_key=$1 WHERE id=$2', [sourceKey, fixture.sourceId]);
    const binding = await bindBankSourceProviderAccount(pool, {
      sourceKey, provider, financialAccountId: fixture.accountId, reason: 'integration fixture',
    });

    client = await pool.connect();
    await client.query('BEGIN');
    await lockMatchedPurchaseSourceProvider(client, fixture.sourceId, provider);
    let bindingSettled = false;
    const bindingAttempt = bindBankSourceProviderAccount(pool, {
      sourceKey, provider, financialAccountId: fixture.accountId, reason: 'idempotent integration replay',
    }).then((value) => { bindingSettled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bindingSettled, false, 'binding writer must wait for the shared source/provider lock');
    await client.query('COMMIT');
    assert.equal((await bindingAttempt).id, binding.id);
    client.release();
    client = null;

    client = await pool.connect();
    await client.query('BEGIN');
    await lockMatchedPurchaseBankTransaction(client, fixture.txId);
    let resolutionSettled = false;
    const resolutionAttempt = resolveBankTransactionAccount(pool, {
      bankTransactionId: fixture.txId,
      financialAccountId: fixture.accountId,
      resolutionState: 'MANUAL',
      provenance: 'TEST_CONFIRMED',
      reason: 'integration concurrency assertion',
    }).then((value) => { resolutionSettled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(resolutionSettled, false, 'account-resolution writer must wait for the shared bank-transaction lock');
    await client.query('COMMIT');
    assert.equal((await resolutionAttempt).resolution_state, 'MANUAL');
  } finally {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    if (fixture) await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [fixture.scopeId]).catch(() => {});
    await pool.end();
  }
});

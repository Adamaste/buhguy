import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { loadBankReceiptMatching } from '../src/bank-receipt-matching.js';
import { persistMatchedPurchase } from '../src/matched-purchase-persistence.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const hash = (letter) => letter.repeat(64);

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

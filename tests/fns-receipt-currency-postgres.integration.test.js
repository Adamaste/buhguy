import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import test from 'node:test';
import { loadBankReceiptMatching } from '../src/bank-receipt-matching.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

integration('FNS currency derivation is authoritative, exact, and non-mutating', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    await client.query('BEGIN');
    const scopeKey = `fns-currency-${suffix}`;
    const scopeId = Number((await client.query("INSERT INTO accounting_scopes(scope_key,label) VALUES($1,'currency fixture') RETURNING id", [scopeKey])).rows[0].id);
    const personId = Number((await client.query("INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,'fixture') RETURNING id", [scopeId, `fns-currency-person-${suffix}`])).rows[0].id);
    const accountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency) VALUES($1,'FNS fixture','fns.fixture','FNS account','RUB') RETURNING id", [scopeId])).rows[0].id);
    await client.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES($1,$2,'OWNER','fixture','fixture')", [accountId, personId]);
    const bankSourceId = Number((await client.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,'ANDROID_NOTIFICATION','fixture') RETURNING id", [`fns-currency-bank-${suffix}`])).rows[0].id);
    await client.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [bankSourceId, personId]);
    const observationId = Number((await client.query("INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata) VALUES($1,$2,NOW(),NOW(),'{}',$3,$4) RETURNING id", [bankSourceId, digest(`dedup-${suffix}`), digest(`payload-${suffix}`), { provider: 'fns.fixture' }])).rows[0].id);
    const transactionId = Number((await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality) VALUES($1,'2026-10-07T10:00:00Z','12.34','RUB','DEBIT','PURCHASE','READY','fixture','EXACT') RETURNING id", [observationId])).rows[0].id);
    await client.query("INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES($1,$2,'EXACT','fixture','fixture')", [transactionId, accountId]);
    const receiptId = Number((await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency,operation_type) VALUES($1,'2026-10-07T10:00:05Z','fixture','12.34',NULL,1) RETURNING id", [`fns-currency-receipt-${suffix}`])).rows[0].id);
    const fnsSourceId = Number((await client.query("INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref) VALUES($1,$2,'fixture','fixture','fixture') RETURNING id", [scopeId, `fns-currency-source-${suffix}`])).rows[0].id);
    await client.query("INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,$3)", [receiptId, fnsSourceId, `fns-source-receipt-${suffix}`]);
    const itemId = Number((await client.query("INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum) VALUES($1,0,'fixture',1,'12.34','12.34') RETURNING id", [receiptId])).rows[0].id);
    await client.query("INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256) VALUES($1,'fiscal-normalizer-v1',4,$2)", [itemId, digest(`item-${suffix}`)]);
    await client.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO','12.34','PRESENT_VALUE','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','UNKNOWN')", [receiptId, digest(`source-${suffix}`), digest(`normalized-${suffix}`)]);
    await client.query('COMMIT');

    const before = (await pool.query('SELECT currency FROM receipts WHERE id=$1', [receiptId])).rows[0].currency;
    const result = await loadBankReceiptMatching(pool, { scopeKey, internalTransferMaxTimeDeltaMs: 60_000, receiptMaxTimeDeltaMs: 60_000 });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].currency, 'RUB');
    assert.equal(result.matches[0].receipt.currencyResolution.basis, 'FNS_SOURCE_CONTRACT');
    const after = (await pool.query('SELECT currency FROM receipts WHERE id=$1', [receiptId])).rows[0].currency;
    assert.equal(before, null);
    assert.equal(after, null);

    const standalone = await persistStandalonePurchases(pool, { scopeKey, receiptIds: [receiptId] });
    assert.equal(standalone.created, 1);
    const persistedEvent = (await pool.query("SELECT e.currency FROM business_events e JOIN business_event_evidence ev ON ev.event_id=e.id WHERE ev.receipt_id=$1 AND ev.evidence_role='PURCHASE_EVIDENCE'", [receiptId])).rows[0];
    assert.equal(persistedEvent.currency, 'RUB');
    assert.equal((await pool.query('SELECT currency FROM receipts WHERE id=$1', [receiptId])).rows[0].currency, null);
  } finally {
    client.release();
    await pool.end();
  }
});

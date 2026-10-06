import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

async function rejects(client, sql, params = []) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await client.query(sql, params);
    assert.fail('expected PostgreSQL constraint violation');
  } catch (error) {
    assert.notEqual(error.code, undefined);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
  }
}

integration('matched purchase persistence schema enforces reviewed contracts', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let scopeId;
  let otherScopeId;
  let accountId;
  let receiptId;
  let secondReceiptId;
  let transactionId;
  let secondTransactionId;
  let eventId;
  let firstEntryId;
  let secondEntryId;
  let thirdEntryId;
  try {
    await client.query('BEGIN');
    scopeId = Number((await client.query("INSERT INTO accounting_scopes(scope_key,label) VALUES('matched-persistence-scope','fixture') RETURNING id")).rows[0].id);
    otherScopeId = Number((await client.query("INSERT INTO accounting_scopes(scope_key,label) VALUES('matched-persistence-other-scope','fixture') RETURNING id")).rows[0].id);
    accountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'fixture-bank','fixture account','RUB') RETURNING id", [scopeId])).rows[0].id);
    const otherAccountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'fixture-bank','other account','RUB') RETURNING id", [otherScopeId])).rows[0].id);
    receiptId = Number((await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES('matched-persistence-r1',NOW(),'fixture',12.34,'RUB') RETURNING id")).rows[0].id);
    secondReceiptId = Number((await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES('matched-persistence-r2',NOW(),'fixture',12.34,'RUB') RETURNING id")).rows[0].id);
    const sourceId = Number((await client.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES('matched-persistence-source','ANDROID_NOTIFICATION','fixture') RETURNING id")).rows[0].id);
    const observationId = Number((await client.query("INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,payload,payload_sha256) VALUES($1,repeat('1',64),NOW(),'{}',repeat('2',64)) RETURNING id", [sourceId])).rows[0].id);
    transactionId = Number((await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,normalization_status,normalization_version,evidence_quality) VALUES($1,NOW(),12.34,'RUB','DEBIT','READY','fixture','EXACT') RETURNING id", [observationId])).rows[0].id);
    const secondObservationId = Number((await client.query("INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,payload,payload_sha256) VALUES($1,repeat('3',64),NOW(),'{}',repeat('4',64)) RETURNING id", [sourceId])).rows[0].id);
    secondTransactionId = Number((await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,normalization_status,normalization_version,evidence_quality) VALUES($1,NOW(),12.34,'RUB','DEBIT','READY','fixture','EXACT') RETURNING id", [secondObservationId])).rows[0].id);
    const event = (await client.query("INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency) VALUES($1,'PURCHASE','CONFIRMED','SYSTEM_DERIVED','fixture','STANDALONE_PURCHASE_V1','v1',repeat('5',64),12.34,'RUB') RETURNING id", [scopeId])).rows[0];
    eventId = Number(event.id);
    const accounts = await client.query("INSERT INTO ledger_accounts(scope_id,account_code,account_type,description) VALUES($1,'fixture-legacy','CONTROL','legacy') RETURNING id", [scopeId]);
    const mapped = await client.query("INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:fixture','ASSET','mapped',$2,'RUB') RETURNING id", [scopeId, accountId]);
    const bankAccountId = Number(accounts.rows[0].id);
    const mappedAccountId = Number(mapped.rows[0].id);
    assert.equal((await client.query('SELECT financial_account_id,account_currency FROM ledger_accounts WHERE id=$1', [bankAccountId])).rows[0].financial_account_id, null);
    await rejects(client, "INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:fixture-duplicate','ASSET','duplicate',$2,'RUB')", [scopeId, accountId]);
    await rejects(client, "INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:fixture-control','CONTROL','wrong type',$2,'RUB')", [scopeId, accountId]);
    await rejects(client, "INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:fixture-currency','ASSET','wrong currency',$2,'USD')", [scopeId, accountId]);
    await rejects(client, "INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:fixture-scope','ASSET','wrong scope',$2,'RUB')", [otherScopeId, accountId]);
    firstEntryId = Number((await client.query("INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin) VALUES($1,$2,'RUB',NOW(),repeat('6',64),'fixture','v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED') RETURNING id", [scopeId, eventId])).rows[0].id);
    secondEntryId = Number((await client.query("INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin) VALUES($1,$2,'RUB',NOW(),repeat('7',64),'fixture','v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED') RETURNING id", [scopeId, eventId])).rows[0].id);
    thirdEntryId = Number((await client.query("INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin) VALUES($1,$2,'RUB',NOW(),repeat('8',64),'fixture','v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED') RETURNING id", [scopeId, eventId])).rows[0].id);
    await client.query("INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit) VALUES($1,$2,'RUB',12.34)", [firstEntryId, mappedAccountId]);

    const matchParams = [scopeId, transactionId, receiptId, accountId];
    await client.query("INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,receipt_normalization_version,normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),repeat('e',64),'fixture',repeat('f',64),12.34,'RUB',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')", matchParams);
    await rejects(client, "INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,receipt_normalization_version,normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),'fixture',repeat('6',64),12.34,'RUB',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')", [scopeId, transactionId, secondReceiptId, accountId]);
    await rejects(client, "INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_normalization_version,normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('7',64),repeat('8',64),repeat('9',64),repeat('a',64),'fixture',repeat('b',64),12.34,'RUB',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')", [scopeId, secondTransactionId, receiptId, accountId]);
    await rejects(client, "INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_normalization_version,normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),'fixture',repeat('6',64),12.34,'USD',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')", [otherScopeId, secondTransactionId, secondReceiptId, otherAccountId]);
    await rejects(client, "INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_normalization_version,normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),'fixture',repeat('6',64),12.34,'RUB',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')", [otherScopeId, secondTransactionId, secondReceiptId, accountId]);

    await client.query("INSERT INTO business_event_bank_evidence(scope_id,business_event_id,bank_receipt_match_id,evidence_role,rule_version,semantic_key) VALUES($1,$2,1,'BANK_PURCHASE_MATCH','v1',repeat('9',64))", [scopeId, eventId]);
    await rejects(client, "INSERT INTO business_event_bank_evidence(scope_id,business_event_id,bank_receipt_match_id,evidence_role,rule_version,semantic_key) VALUES($1,$2,1,'BANK_PURCHASE_MATCH','v1',repeat('0',64))", [scopeId, eventId]);
    await client.query("INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,bank_receipt_match_id,bank_transaction_id,link_role,semantic_key) VALUES($1,$2,1, $3,'BANK_MATCH',repeat('1',64))", [firstEntryId, eventId, transactionId]);
    await client.query("INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,supersession_key,reason_code) VALUES($1,$2,$3,repeat('2',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, firstEntryId, secondEntryId]);
    await rejects(client, "INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,supersession_key,reason_code) VALUES($1,$2,$3,repeat('3',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, firstEntryId, thirdEntryId]);
    await rejects(client, "INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,supersession_key,reason_code) VALUES($1,$2,$3,repeat('4',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, thirdEntryId, secondEntryId]);
    await rejects(client, "INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,supersession_key,reason_code) VALUES($1,$2,$2,repeat('5',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, thirdEntryId]);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ledger_source_links WHERE bank_receipt_match_id=1')).rows[0].count, 1);
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

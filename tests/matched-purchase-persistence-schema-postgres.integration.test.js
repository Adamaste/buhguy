import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { STANDALONE_PURCHASE_VERSION } from '../src/standalone-purchase.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

async function rejects(client, sql, params, expectedCode) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await client.query(sql, params);
    assert.fail('expected PostgreSQL constraint violation');
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    assert.equal(error.code, expectedCode);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
  }
}

async function insertMatch(client, values) {
  const result = await client.query(`
    INSERT INTO bank_receipt_matches(
      scope_id, bank_transaction_id, receipt_id, financial_account_id,
      matcher_version, match_key, bank_ledger_key, bank_candidate_key,
      bank_journal_key, receipt_candidate_key, receipt_normalization_version,
      receipt_normalized_content_sha256, amount, currency, bank_occurred_at,
      receipt_date_time, time_delta_seconds, relationship_type, reason_code
    ) VALUES (
      $1, $2, $3, $4, 'fixture', repeat($5, 64), repeat($6, 64),
      repeat($7, 64), repeat($8, 64), repeat($9, 64), 'fixture',
      repeat($10, 64), $11, $12, NOW(), NOW(), 0, 'MATCHED_PURCHASE', 'fixture'
    ) RETURNING id
  `, [
    values.scopeId, values.transactionId, values.receiptId, values.accountId,
    values.matchKey, values.ledgerKey, values.candidateKey, values.journalKey,
    values.receiptCandidateKey, values.contentHash, values.amount ?? 12.34,
    values.currency ?? 'RUB',
  ]);
  return Number(result.rows[0].id);
}

integration('matched purchase persistence schema enforces reviewed contracts', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let scopeId;
  let otherScopeId;
  let accountId;
  let sameScopeAccountId;
  let otherAccountId;
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
    sameScopeAccountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'fixture-bank','second fixture account','RUB') RETURNING id", [scopeId])).rows[0].id);
    otherAccountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'fixture-bank','other account','RUB') RETURNING id", [otherScopeId])).rows[0].id);
    receiptId = Number((await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES('matched-persistence-r1',NOW(),'fixture',12.34,'RUB') RETURNING id")).rows[0].id);
    secondReceiptId = Number((await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES('matched-persistence-r2',NOW(),'fixture',12.34,'RUB') RETURNING id")).rows[0].id);
    const sourceId = Number((await client.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES('matched-persistence-source','ANDROID_NOTIFICATION','fixture') RETURNING id")).rows[0].id);
    const observationId = Number((await client.query("INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,payload,payload_sha256) VALUES($1,repeat('1',64),NOW(),'{}',repeat('2',64)) RETURNING id", [sourceId])).rows[0].id);
    transactionId = Number((await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,normalization_status,normalization_version,evidence_quality) VALUES($1,NOW(),12.34,'RUB','DEBIT','READY','fixture','EXACT') RETURNING id", [observationId])).rows[0].id);
    const secondObservationId = Number((await client.query("INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,payload,payload_sha256) VALUES($1,repeat('3',64),NOW(),'{}',repeat('4',64)) RETURNING id", [sourceId])).rows[0].id);
    secondTransactionId = Number((await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,normalization_status,normalization_version,evidence_quality) VALUES($1,NOW(),12.34,'RUB','DEBIT','READY','fixture','EXACT') RETURNING id", [secondObservationId])).rows[0].id);
    eventId = Number((await client.query("INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency) VALUES($1,'PURCHASE','CONFIRMED','SYSTEM_DERIVED','fixture','STANDALONE_PURCHASE_V1',$2,repeat('5',64),12.34,'RUB') RETURNING id", [scopeId, STANDALONE_PURCHASE_VERSION])).rows[0].id);

    const accounts = await client.query("INSERT INTO ledger_accounts(scope_id,account_code,account_type,description) VALUES($1,'fixture-legacy','CONTROL','legacy') RETURNING id", [scopeId]);
    const mapped = await client.query("INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,$2,'ASSET','mapped',$3,'RUB') RETURNING id", [scopeId, `FINANCIAL_ACCOUNT:${accountId}`, accountId]);
    const bankAccountId = Number(accounts.rows[0].id);
    const mappedAccountId = Number(mapped.rows[0].id);
    assert.equal((await client.query('SELECT financial_account_id,account_currency FROM ledger_accounts WHERE id=$1', [bankAccountId])).rows[0].financial_account_id, null);
    await rejects(client, "INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:duplicate','ASSET','duplicate',$2,'RUB')", [scopeId, accountId], '23505');
    await rejects(client, "INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:control','CONTROL','wrong type',$2,'RUB')", [scopeId, accountId], '23514');
    await rejects(client, "INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:currency','ASSET','wrong currency',$2,'USD')", [scopeId, sameScopeAccountId], '23503');
    await rejects(client, "INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,'FINANCIAL_ACCOUNT:scope','ASSET','wrong scope',$2,'RUB')", [otherScopeId, accountId], '23503');

    firstEntryId = Number((await client.query("INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin) VALUES($1,$2,'RUB',NOW(),repeat('6',64),'fixture','v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED') RETURNING id", [scopeId, eventId])).rows[0].id);
    secondEntryId = Number((await client.query("INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin) VALUES($1,$2,'RUB',NOW(),repeat('7',64),'fixture','v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED') RETURNING id", [scopeId, eventId])).rows[0].id);
    thirdEntryId = Number((await client.query("INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin) VALUES($1,$2,'RUB',NOW(),repeat('8',64),'fixture','v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED') RETURNING id", [scopeId, eventId])).rows[0].id);
    await client.query("INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit) VALUES($1,$2,'RUB',12.34)", [firstEntryId, mappedAccountId]);

    const matchId = await insertMatch(client, { scopeId, transactionId, receiptId, accountId, matchKey: 'a', ledgerKey: 'b', candidateKey: 'c', journalKey: 'd', receiptCandidateKey: 'e', contentHash: 'f' });
    await rejects(client, `INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,receipt_normalization_version,receipt_normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),'fixture',repeat('6',64),12.34,'RUB',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')`, [scopeId, transactionId, secondReceiptId, accountId], '23505');
    await rejects(client, `INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,receipt_normalization_version,receipt_normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('7',64),repeat('8',64),repeat('9',64),repeat('a',64),repeat('b',64),'fixture',repeat('c',64),12.34,'RUB',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')`, [scopeId, secondTransactionId, receiptId, accountId], '23505');
    await rejects(client, `INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,receipt_normalization_version,receipt_normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('d',64),repeat('e',64),repeat('f',64),repeat('a',64),repeat('b',64),'fixture',repeat('c',64),12.34,'USD',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')`, [otherScopeId, secondTransactionId, secondReceiptId, otherAccountId], '23503');
    await rejects(client, `INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,receipt_normalization_version,receipt_normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code) VALUES($1,$2,$3,$4,'fixture',repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),'fixture',repeat('6',64),12.34,'RUB',NOW(),NOW(),0,'MATCHED_PURCHASE','fixture')`, [otherScopeId, secondTransactionId, secondReceiptId, accountId], '23503');

    await client.query("INSERT INTO business_event_bank_evidence(scope_id,business_event_id,bank_receipt_match_id,enrichment_key,evidence_role,rule_version,semantic_key) VALUES($1,$2,$3,repeat('a',64),'BANK_PURCHASE_MATCH','v1',repeat('9',64))", [scopeId, eventId, matchId]);
    await rejects(client, "INSERT INTO business_event_bank_evidence(scope_id,business_event_id,bank_receipt_match_id,enrichment_key,evidence_role,rule_version,semantic_key) VALUES($1,$2,$3,repeat('b',64),'BANK_PURCHASE_MATCH','v1',repeat('0',64))", [scopeId, eventId, matchId], '23505');
    await client.query("INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,bank_receipt_match_id,bank_transaction_id,link_role,semantic_key) VALUES($1,$2,$3,$4,'BANK_MATCH',repeat('1',64))", [firstEntryId, eventId, matchId, transactionId]);
    await rejects(client, "INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,bank_receipt_match_id,bank_transaction_id,link_role,semantic_key) VALUES($1,$2,$3,NULL,'BANK_MATCH',repeat('2',64))", [firstEntryId, eventId, matchId], '23514');

    await client.query("INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code) VALUES($1,$2,$3,$4,repeat('a',64),repeat('2',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, firstEntryId, secondEntryId, eventId]);
    await rejects(client, "INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code) VALUES($1,$2,$3,$4,repeat('b',64),repeat('3',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, firstEntryId, thirdEntryId, eventId], '23505');
    await rejects(client, "INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code) VALUES($1,$2,$3,$4,repeat('c',64),repeat('4',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, thirdEntryId, secondEntryId, eventId], '23505');
    await rejects(client, "INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code) VALUES($1,$2,$3,$4,repeat('d',64),repeat('5',64),'MATCHED_PURCHASE_REFINEMENT')", [scopeId, thirdEntryId, thirdEntryId, eventId], '23514');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ledger_source_links WHERE bank_receipt_match_id=$1', [matchId])).rows[0].count, 1);
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

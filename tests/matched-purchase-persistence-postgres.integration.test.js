import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { persistMatchedPurchase } from '../src/matched-purchase-persistence.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const hash = (letter) => letter.repeat(64);

integration('matched purchase writer persists one atomic, replayable bank-funded purchase', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let scopeId; let accountId; let receiptId; let txId; let eventId; let sourceId; let observationId;
  try {
    await client.query('BEGIN');
    scopeId = Number((await client.query("INSERT INTO accounting_scopes(scope_key,label) VALUES('writer-v1-scope','fixture') RETURNING id")).rows[0].id);
    accountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'writer-bank','writer account','RUB') RETURNING id", [scopeId])).rows[0].id);
    sourceId = Number((await client.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES('writer-v1-source','ANDROID_NOTIFICATION','fixture') RETURNING id")).rows[0].id);
    observationId = Number((await client.query("INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256) VALUES($1,$2,NOW(),NOW(),'{}',$3) RETURNING id", [sourceId, hash('a'), hash('b')])).rows[0].id);
    const txRow = (await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,normalization_status,normalization_version,evidence_quality) VALUES($1,NOW(),'12.34','RUB','DEBIT','READY','fixture','EXACT') RETURNING id,occurred_at", [observationId])).rows[0];
    txId = Number(txRow.id);
    const receiptRow = (await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency) VALUES('writer-v1-receipt',NOW(),'fixture','12.34','RUB') RETURNING id,date_time")).rows[0];
    receiptId = Number(receiptRow.id);
    await client.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,fiscal_operation_type,household_cash_direction,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_state,credit_state,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','EXPLICIT_ZERO','12.34','PRESENT_VALUE','EXPLICIT_ZERO','EXPLICIT_ZERO','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','UNKNOWN')", [receiptId, hash('c'), hash('d')]);
    await client.query('COMMIT');

    const match = {
      modelVersion: 'bank-receipt-matching-v1', matchStatus: 'MATCHED', relationshipType: 'RECEIPT_EVIDENCE_FOR_BANK_PURCHASE',
      matchKey: hash('e'), scopeKey: 'writer-v1-scope', amount: '12.34', currency: 'RUB', reasonCode: 'ONE_TO_ONE_EXACT',
      bank: { ledgerKey: hash('f'), candidateKey: hash('g'), journalKey: hash('h'), bankTransactionId: txId, financialAccountId: accountId, occurredAt: txRow.occurred_at.toISOString() },
      receipt: { receiptCandidateKey: hash('i'), receiptId, normalizationVersion: 'fiscal-normalizer-v1', normalizedContentSha256: hash('d'), dateTime: receiptRow.date_time.toISOString(), amount: '12.34', currency: 'RUB' },
    };
    const result = await persistMatchedPurchase(pool, { scopeKey: 'writer-v1-scope', matchKey: match.matchKey, matchingLoader: async () => ({ matches: [match] }) });
    const replay = await persistMatchedPurchase(pool, { scopeKey: 'writer-v1-scope', matchKey: match.matchKey, matchingLoader: async () => ({ matches: [match] }) });
    assert.equal(result.matchId, replay.matchId);
    assert.equal(result.eventId, replay.eventId);
    assert.equal(result.ledgerEntryId, replay.ledgerEntryId);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM bank_receipt_matches WHERE match_key=$1", [match.matchKey])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_entries WHERE source_event_id=$1 AND derivation_rule='LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1'", [result.eventId])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM certification_facts WHERE ledger_entry_id=$1 AND metric_code='FISCAL_NEW_MONEY'", [result.ledgerEntryId])).rows[0].count, 0);
    eventId = result.eventId;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    if (scopeId) await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]).catch(() => {});
    client.release(); await pool.end();
  }
});

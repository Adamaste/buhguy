import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import test from 'node:test';
import { buildPreliminaryCandidateReadOnlyReport } from '../scripts/bank-receipt-provisional-candidates-read-only.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

integration('provisional candidate rows are read from one read-only snapshot and ignore currency and accounting eligibility', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const suffix = `${process.pid}-${Date.now()}`;
  const from = '2026-10-10T00:00:00.000Z';
  const to = '2026-10-11T00:00:00.000Z';
  try {
    const scopeId = (await pool.query("INSERT INTO accounting_scopes(scope_key,label) VALUES($1,'fixture') RETURNING id", [`provisional-${suffix}`])).rows[0].id;
    const personId = (await pool.query("INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,'fixture') RETURNING id", [scopeId, `person-${suffix}`])).rows[0].id;
    const accountId = (await pool.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'fixture','fixture','RUB') RETURNING id", [scopeId])).rows[0].id;
    const sourceId = (await pool.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,'ANDROID_NOTIFICATION','fixture') RETURNING id", [`bank-source-${suffix}`])).rows[0].id;
    await pool.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [sourceId, personId]);
    const observationId = (await pool.query(`INSERT INTO bank_event_observations
      (bank_source_id,source_event_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata)
      VALUES($1,$2,$3,$4,$4,'{}',$5,'{}') RETURNING id`, [sourceId, `evt-${suffix}`, digest(`dedup-${suffix}`), '2026-10-10T10:00:00Z', digest(`payload-${suffix}`)])).rows[0].id;
    const bankTransactionId = (await pool.query(`INSERT INTO bank_transactions
      (observation_id,occurred_at,amount,currency,direction,merchant,normalization_status,normalization_version,evidence_quality,event_type)
      VALUES($1,'2026-10-10T10:00:00Z','12.34','USD','DEBIT','Bank label','UNKNOWN','fixture','INSUFFICIENT','TRANSFER') RETURNING id`, [observationId])).rows[0].id;
    await pool.query(`INSERT INTO bank_transaction_account_resolution
      (bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
      VALUES($1,NULL,'UNKNOWN','fixture','not resolved')`, [bankTransactionId]);
    const duplicateLookingObservationId = (await pool.query(`INSERT INTO bank_event_observations
      (bank_source_id,source_event_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata)
      VALUES($1,$2,$3,$4,$4,'{}',$5,'{}') RETURNING id`, [sourceId, `evt-second-${suffix}`, digest(`dedup-second-${suffix}`), '2026-10-10T10:00:02Z', digest(`payload-second-${suffix}`)])).rows[0].id;
    const duplicateLookingBankTransactionId = (await pool.query(`INSERT INTO bank_transactions
      (observation_id,occurred_at,amount,currency,direction,merchant,normalization_status,normalization_version,evidence_quality,event_type)
      VALUES($1,'2026-10-10T10:00:02Z','12.34','USD','DEBIT','Bank label','UNKNOWN','fixture','INSUFFICIENT','TRANSFER') RETURNING id`, [duplicateLookingObservationId])).rows[0].id;
    await pool.query(`INSERT INTO bank_transaction_account_resolution
      (bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
      VALUES($1,NULL,'UNKNOWN','fixture','not resolved')`, [duplicateLookingBankTransactionId]);
    const receiptId = (await pool.query(`INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency,operation_type)
      VALUES($1,'2026-10-10T10:01:00Z','Receipt label','12.34',NULL,3) RETURNING id`, [`fns-${suffix}`])).rows[0].id;
    const fnsSourceId = (await pool.query(`INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref)
      VALUES($1,$2,'fixture','fixture','fixture') RETURNING id`, [scopeId, `fns-source-${suffix}`])).rows[0].id;
    await pool.query('INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,$3)', [receiptId, fnsSourceId, `source-receipt-${suffix}`]);

    const before = (await pool.query('SELECT count(*)::integer AS count FROM bank_receipt_matches')).rows[0].count;
    const ledgerBefore = (await pool.query('SELECT count(*)::integer AS count FROM ledger_entries')).rows[0].count;
    const report = await buildPreliminaryCandidateReadOnlyReport(pool, { from, to }, {
      enabled: false, canaryScopeKey: null, automaticPolicy: null, bankIngestedAfter: null,
    });
    assert.equal(report.candidates.length, 2);
    assert.deepEqual(new Set(report.candidates.map((row) => row.bankTransactionId)), new Set([String(bankTransactionId), String(duplicateLookingBankTransactionId)]));
    assert.ok(report.candidates.every((row) => row.receiptId === String(receiptId)));
    assert.ok(report.candidates.every((row) => row.candidateStatus === 'AMBIGUOUS'));
    assert.ok(report.candidates.every((row) => row.bank.currency === 'USD'));
    assert.ok(report.candidates.every((row) => row.receipt.currency === null));
    assert.ok(report.candidates.every((row) => row.bookkeepingReasonCodes.includes('BANK_NOT_PURCHASE')));
    assert.ok(report.candidates.every((row) => row.bookkeepingReasonCodes.includes('FNS_OPERATION_NOT_PURCHASE')));
    assert.ok(report.candidates.every((row) => row.ledgerWritesAllowed === false));
    assert.equal(report.summary.ledgerWritesPerformed, 0);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM bank_receipt_matches')).rows[0].count, before);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM ledger_entries')).rows[0].count, ledgerBefore);
  } finally { await pool.end(); }
});

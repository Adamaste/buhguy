import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/database.js';
import { loadBalancedBankJournalProjection } from '../src/balanced-bank-journal-projection.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const TABLES = [
  'bank_event_observations', 'bank_transactions', 'bank_transaction_account_resolution',
  'bank_transaction_payment_instrument_resolution',
  'business_events', 'business_event_evidence', 'business_event_edges', 'ledger_entries',
  'business_event_allocations', 'ledger_postings', 'ledger_source_links',
  'reconciliation_runs', 'reconciliation_results', 'certification_facts',
];

async function counts(pool) {
  const values = {};
  for (const table of TABLES) values[table] = (await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;
  return values;
}

integration('balanced bank journal projection is SELECT-only and preserves database counts', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = `${process.pid}-${Date.now()}`;
  const scopeKey = `journal-projection-${suffix}`;
  const sourceKey = `journal-source-${suffix}`;
  const personKey = `journal-person-${suffix}`;
  const observationIds = [];
  const transactionIds = [];
  let sourceId;
  let accountId;
  let personId;
  let scopeId;
  const createTransaction = async (values) => {
    const dedup = crypto.createHash('sha256').update(`${sourceId}:${values.key}`).digest('hex');
    const observation = (await pool.query(`INSERT INTO bank_event_observations(bank_source_id,source_event_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata)
      VALUES($1,NULL,$2,$3,$3,'{}'::jsonb,$2,'{}'::jsonb) RETURNING id`, [sourceId, dedup, '2026-10-04T10:00:00Z'])).rows[0];
    observationIds.push(observation.id);
    const transaction = (await pool.query(`INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality)
      VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-journal-projection-v1',$8) RETURNING id`, [observation.id, values.occurredAt ?? '2026-10-04T10:00:00Z', values.amount ?? '100.00', values.currency ?? 'RUB', values.direction, values.eventType, values.status ?? 'READY', values.evidenceQuality ?? 'EXACT'])).rows[0];
    transactionIds.push(transaction.id);
    if (values.resolution) await pool.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES($1,$2,$3,'SYNTHETIC_TEST','Synthetic journal projection evidence')`, [transaction.id, values.resolution.accountId, values.resolution.state]);
    return transaction.id;
  };
  try {
    await migrate(pool);
    scopeId = (await pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, 'Synthetic journal projection scope'])).rows[0].id;
    personId = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, personKey, 'Synthetic journal projection person'])).rows[0].id;
    sourceId = (await pool.query(`INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,'ANDROID_NOTIFICATION',$2) RETURNING id`, [sourceKey, 'Synthetic journal projection source'])).rows[0].id;
    await pool.query('INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,$3)', [sourceId, personId, 'OWNER']);
    accountId = (await pool.query(`INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency) VALUES($1,'Synthetic Bank','synthetic','Journal projection account','RUB') RETURNING id`, [scopeId])).rows[0].id;
    await createTransaction({ key: 'purchase', eventType: 'PURCHASE', direction: 'DEBIT', resolution: { accountId, state: 'EXACT' } });
    await createTransaction({ key: 'unknown-debit', eventType: 'UNKNOWN', direction: 'DEBIT' });
    await createTransaction({ key: 'unknown-direction', eventType: 'UNKNOWN', direction: 'UNKNOWN' });
    const before = await counts(pool);
    const report = await loadBalancedBankJournalProjection(pool, { scopeKey });
    const after = await counts(pool);
    assert.deepEqual(after, before);
    assert.equal(report.summary.totalTransactions, 3);
    assert.equal(report.summary.projectedTransactions, 2);
    assert.equal(report.summary.unresolvedTransactions, 1);
    assert.equal(report.projections.filter((row) => row.projectionStatus === 'PROJECTED').every((row) => row.postings.length === 2), true);
    assert.equal(report.projections.some((row) => row.postings.some((posting) => posting.account.code === 'INTERNAL_TRANSFER')), false);
  } finally {
    if (transactionIds.length) await pool.query('DELETE FROM bank_transactions WHERE id = ANY($1::bigint[])', [transactionIds]);
    if (observationIds.length) await pool.query('DELETE FROM bank_event_observations WHERE id = ANY($1::bigint[])', [observationIds]);
    if (sourceId) await pool.query('DELETE FROM bank_source_person WHERE bank_source_id=$1', [sourceId]);
    if (sourceId) await pool.query('DELETE FROM bank_sources WHERE id=$1', [sourceId]);
    if (accountId) await pool.query('DELETE FROM financial_accounts WHERE id=$1', [accountId]);
    if (personId) await pool.query('DELETE FROM persons WHERE id=$1', [personId]);
    if (scopeId) await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]);
    await pool.end();
  }
});

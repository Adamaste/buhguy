import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/database.js';
import { loadBankCashFlowProjection } from '../src/bank-cash-flow-projection.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const TABLES = [
  'bank_event_observations', 'bank_transactions', 'bank_transaction_account_resolution',
  'bank_transaction_payment_instrument_resolution', 'financial_accounts',
  'business_events', 'business_event_evidence', 'business_event_edges',
  'ledger_entries', 'ledger_postings', 'reconciliation_runs', 'reconciliation_results',
  'certification_facts',
];

async function counts(pool) {
  const values = {};
  for (const table of TABLES) values[table] = (await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;
  return values;
}

integration('bank cash-flow projection is SELECT-only and scope-safe', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = `${process.pid}-${Date.now()}`;
  const scopeAKey = `projection-a-${suffix}`;
  const scopeBKey = `projection-b-${suffix}`;
  const sourceAKey = `projection-source-a-${suffix}`;
  const sourceBKey = `projection-source-b-${suffix}`;
  const sourceAmbiguousKey = `projection-source-ambiguous-${suffix}`;
  const personIds = [];
  const sourceIds = [];
  const observationIds = [];
  const transactionIds = [];
  const accountIds = [];
  const createScope = async (key) => (await pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [key, `Synthetic projection ${key}`])).rows[0].id;
  const createPerson = async (scopeId, key) => {
    const row = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, key, 'Synthetic projection person'])).rows[0];
    personIds.push(row.id);
    return row.id;
  };
  const createSource = async (key) => {
    const row = (await pool.query(`INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,'ANDROID_NOTIFICATION',$2) RETURNING id`, [key, 'Synthetic projection source'])).rows[0];
    sourceIds.push(row.id);
    return row.id;
  };
  const createTransaction = async (sourceId, values) => {
    const dedup = crypto.createHash('sha256').update(`${sourceId}:${values.key}`).digest('hex');
    const observation = (await pool.query(`INSERT INTO bank_event_observations(bank_source_id,source_event_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata)
      VALUES($1,NULL,$2,$3,$3,'{}'::jsonb,$2,'{}'::jsonb) RETURNING id`, [sourceId, dedup, '2026-10-04T10:00:00Z'])).rows[0];
    observationIds.push(observation.id);
    const transaction = (await pool.query(`INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality)
      VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-projection-v1',$8) RETURNING id`, [observation.id, values.occurredAt ?? '2026-10-04T10:00:00Z', values.amount ?? null, values.currency ?? null, values.direction, values.eventType, values.status, values.evidenceQuality])).rows[0];
    transactionIds.push(transaction.id);
    if (values.resolution) await pool.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES($1,$2,$3,$4,$5)`, [transaction.id, values.resolution.accountId, values.resolution.state, 'SYNTHETIC_TEST', 'Synthetic projection evidence']);
    return transaction.id;
  };
  try {
    await migrate(pool);
    const scopeA = await createScope(scopeAKey);
    const scopeB = await createScope(scopeBKey);
    const personA = await createPerson(scopeA, `projection-person-a-${suffix}`);
    const personB = await createPerson(scopeB, `projection-person-b-${suffix}`);
    const sourceA = await createSource(sourceAKey);
    const sourceB = await createSource(sourceBKey);
    const sourceAmbiguous = await createSource(sourceAmbiguousKey);
    await pool.query('INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,$3),($4,$5,$3)', [sourceA, personA, 'OWNER', sourceAmbiguous, personA]);
    await pool.query('INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,$3),($4,$5,$3)', [sourceB, personB, 'OWNER', sourceAmbiguous, personB]);
    const accountA = (await pool.query(`INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency) VALUES($1,'Synthetic Bank','synthetic','Projection account A','RUB') RETURNING id`, [scopeA])).rows[0];
    const accountB = (await pool.query(`INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency) VALUES($1,'Synthetic Bank','synthetic','Projection account B','RUB') RETURNING id`, [scopeB])).rows[0];
    const accountAId = Number(accountA.id);
    const accountBId = Number(accountB.id);
    accountIds.push(accountAId, accountBId);

    const purchaseId = Number(await createTransaction(sourceA, { key: 'purchase', amount: '10.00', currency: 'RUB', direction: 'DEBIT', eventType: 'PURCHASE', status: 'READY', evidenceQuality: 'EXACT' }));
    const outgoingId = Number(await createTransaction(sourceA, { key: 'outgoing', amount: '20.00', currency: 'RUB', direction: 'DEBIT', eventType: 'OUTGOING_TRANSFER', status: 'READY', evidenceQuality: 'EXACT', resolution: { accountId: accountAId, state: 'EXACT' } }));
    const incomingId = Number(await createTransaction(sourceA, { key: 'incoming', amount: '30.00', currency: 'RUB', direction: 'CREDIT', eventType: 'INCOMING_TRANSFER', status: 'READY', evidenceQuality: 'EXACT', resolution: { accountId: null, state: 'UNKNOWN' } }));
    const unknownId = Number(await createTransaction(sourceA, { key: 'unknown', amount: '40.00', currency: 'RUB', direction: 'UNKNOWN', eventType: 'UNKNOWN', status: 'PARTIAL', evidenceQuality: 'PARTIAL' }));
    const conflictId = Number(await createTransaction(sourceA, { key: 'conflict', amount: '50.00', currency: 'RUB', direction: 'DEBIT', eventType: 'PURCHASE', status: 'READY', evidenceQuality: 'EXACT', resolution: { accountId: accountBId, state: 'EXACT' } }));
    const ambiguousId = Number(await createTransaction(sourceAmbiguous, { key: 'ambiguous', amount: '60.00', currency: 'RUB', direction: 'DEBIT', eventType: 'PURCHASE', status: 'READY', evidenceQuality: 'EXACT' }));
    const isolatedId = Number(await createTransaction(sourceB, { key: 'isolated', amount: '70.00', currency: 'RUB', direction: 'DEBIT', eventType: 'PURCHASE', status: 'READY', evidenceQuality: 'EXACT' }));
    const before = await counts(pool);
    const report = await loadBankCashFlowProjection(pool, { scopeKey: scopeAKey });
    const after = await counts(pool);
    assert.deepEqual(after, before);
    assert.equal(report.summary.totalTransactions, 6);
    assert.equal(report.summary.projectedTransactions, 3);
    assert.equal(report.summary.unresolvedTransactions, 3);
    assert.equal(report.summary.concreteAccountIdentity, 1);
    assert.equal(report.summary.unresolvedAccountIdentity, 5);
    const byId = new Map(report.projections.map((row) => [row.bankTransactionId, row]));
    assert.equal(byId.get(purchaseId).movementType, 'PURCHASE');
    assert.equal(byId.get(outgoingId).movementType, 'OUTGOING_TRANSFER');
    assert.equal(byId.get(outgoingId).financialAccountId, accountAId);
    assert.equal(byId.get(incomingId).accountIdentityStatus, 'UNRESOLVED');
    assert.equal(byId.get(unknownId).reasonCode, 'NORMALIZATION_NOT_READY');
    assert.equal(byId.get(conflictId).reasonCode, 'ACCOUNT_SCOPE_CONFLICT');
    assert.equal(byId.get(ambiguousId).reasonCode, 'SOURCE_SCOPE_AMBIGUOUS');
    assert.equal(byId.has(isolatedId), false);
    assert.equal(report.projections.some((row) => row.movementType === 'INTERNAL_TRANSFER'), false);
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE id = ANY($1::bigint[])', [transactionIds]);
    await pool.query('DELETE FROM bank_event_observations WHERE id = ANY($1::bigint[])', [observationIds]);
    await pool.query('DELETE FROM bank_source_person WHERE bank_source_id = ANY($1::bigint[])', [sourceIds]);
    await pool.query('DELETE FROM bank_sources WHERE id = ANY($1::bigint[])', [sourceIds]);
    await pool.query('DELETE FROM financial_accounts WHERE id = ANY($1::bigint[])', [accountIds]);
    await pool.query('DELETE FROM persons WHERE id = ANY($1::bigint[])', [personIds]);
    await pool.query('DELETE FROM accounting_scopes WHERE scope_key = ANY($1::text[])', [[scopeAKey, scopeBKey]]);
    await pool.end();
  }
});

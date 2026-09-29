import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/database.js';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { createBankAccountReference, createFinancialAccount, relateFinancialAccountPerson, resolveHistoricalBankTransactionAccountFromObservation } from '../src/bank-account-resolution.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

integration('historical bank account replay is dry-run, fail-closed, and idempotent', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = String(process.pid) + '-' + String(Date.now());
  const sourceKey = 'historical-resolution-' + suffix;
  const personKey = 'historical-person-' + suffix;
  const event = (sourceEventId, reference = '0271') => ({
    sourceKey, sourceEventId, observedAt: '2026-09-29T10:00:00Z', eventTime: '2026-09-29T09:59:00Z',
    payload: { amount: '100.00', currency: 'RUB', direction: 'CREDIT', accountReference: reference, accountReferenceKind: 'MASKED_ACCOUNT' },
    ingestionMetadata: { adapter: 'test', provider: 'historical.synthetic', schemaVersion: '1' },
  });
  let accountIds = [];
  try {
    await migrate(pool);
    const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
    const person = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scope.id, personKey, 'Synthetic historical context'])).rows[0];
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic historical source' });
    await linkBankSourcePerson(pool, { sourceKey, personId: person.id });
    const account = await createFinancialAccount(pool, { institution: 'Historical Synthetic', provider: 'historical.synthetic', displayName: 'Historical account' });
    accountIds = [account.id];
    await relateFinancialAccountPerson(pool, { financialAccountId: account.id, personId: person.id, relationType: 'OWNER', provenance: 'TEST_EXPLICIT', reason: 'Synthetic test context' });
    await createBankAccountReference(pool, { financialAccountId: account.id, provider: 'historical.synthetic', referenceKind: 'MASKED_ACCOUNT', referenceValue: '0271' });

    const created = await ingestBankEvent(pool, event('historical-exact'));
    assert.equal(created.status, 'created');
    const dryRun = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: created.observationId });
    assert.equal(dryRun.status, 'DRY_RUN');
    assert.equal(dryRun.resolutionState, 'RECONCILED');
    assert.equal(dryRun.provenance, 'HISTORICAL_OBSERVATION_REPLAY');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1 AND resolution_state=$2', [created.transactionId, 'UNKNOWN'])).rows[0].count, 1);

    const persisted = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: created.observationId, persist: true });
    assert.equal(persisted.status, 'RECONCILED');
    assert.equal(persisted.financial_account_id, account.id);
    const replay = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: created.observationId, persist: true });
    assert.equal(replay.status, 'ALREADY_RECONCILED');
    const concurrent = await Promise.all([
      resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: created.observationId, persist: true }),
      resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: created.observationId, persist: true }),
    ]);
    assert.ok(concurrent.every((item) => ['ALREADY_RECONCILED', 'RECONCILED'].includes(item.status)));

    const before = (await pool.query('SELECT resolution_state,financial_account_id FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [created.transactionId])).rows[0];
    const noCandidate = await ingestBankEvent(pool, event('historical-no-candidate', '0999'));
    const noCandidateResult = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: noCandidate.observationId });
    assert.equal(noCandidateResult.status, 'FAIL_CLOSED');
    assert.equal(noCandidateResult.candidateCount, 0);

    const second = await createFinancialAccount(pool, { institution: 'Historical Synthetic', provider: 'historical.synthetic', displayName: 'Historical duplicate account' });
    accountIds.push(second.id);
    await createBankAccountReference(pool, { financialAccountId: second.id, provider: 'historical.synthetic', referenceKind: 'MASKED_ACCOUNT', referenceValue: '0271' });
    const ambiguous = await ingestBankEvent(pool, event('historical-ambiguous'));
    const ambiguousResult = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: ambiguous.observationId });
    assert.equal(ambiguousResult.status, 'FAIL_CLOSED');
    assert.equal(ambiguousResult.candidateCount, 2);

    const after = (await pool.query('SELECT resolution_state,financial_account_id FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [created.transactionId])).rows[0];
    assert.deepEqual(after, before);
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    if (accountIds.length) await pool.query('DELETE FROM financial_accounts WHERE id=ANY($1::bigint[])', [accountIds]).catch(() => {});
    await pool.query('DELETE FROM persons WHERE person_key=$1', [personKey]).catch(() => {});
    await pool.end();
  }
});

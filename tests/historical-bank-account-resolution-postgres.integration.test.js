import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/database.js';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { createBankAccountReference, createFinancialAccount, relateFinancialAccountPerson, resolveBankTransactionAccount, resolveBankTransactionAccountFromReference, resolveHistoricalBankTransactionAccountFromObservation } from '../src/bank-account-resolution.js';

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
    await pool.query(`UPDATE bank_transactions
      SET amount=NULL, currency=NULL, direction='UNKNOWN', event_type='UNKNOWN',
          normalization_status='PARTIAL', evidence_quality='PARTIAL',
          account_reference=NULL, account_reference_kind=NULL
      WHERE id=$1`, [created.transactionId]);
    const beforeDryRun = (await pool.query(`SELECT occurred_at,amount,currency,direction,merchant,counterparty,
        account_reference,account_reference_kind,event_type,normalization_status,normalization_version,evidence_quality
      FROM bank_transactions WHERE id=$1`, [created.transactionId])).rows[0];
    const observationBefore = (await pool.query('SELECT payload_sha256,payload FROM bank_event_observations WHERE id=$1', [created.observationId])).rows[0];
    const dryRun = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: created.observationId });
    assert.equal(dryRun.status, 'DRY_RUN', JSON.stringify(dryRun));
    assert.equal(dryRun.resolutionState, 'RECONCILED');
    assert.equal(dryRun.provenance, 'HISTORICAL_OBSERVATION_REPLAY');
    assert.equal(dryRun.audit.compatibilityGate, 'PASS');
    assert.equal(dryRun.audit.compatibility.amount, 'REFINEMENT');
    assert.equal(dryRun.audit.compatibility.direction, 'REFINEMENT');
    assert.equal(dryRun.audit.compatibility.accountReference, 'REFINEMENT');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1 AND resolution_state=$2', [created.transactionId, 'UNKNOWN'])).rows[0].count, 1);
    assert.deepEqual((await pool.query(`SELECT occurred_at,amount,currency,direction,merchant,counterparty,
        account_reference,account_reference_kind,event_type,normalization_status,normalization_version,evidence_quality
      FROM bank_transactions WHERE id=$1`, [created.transactionId])).rows[0], beforeDryRun);
    assert.deepEqual((await pool.query('SELECT payload_sha256,payload FROM bank_event_observations WHERE id=$1', [created.observationId])).rows[0], observationBefore);

    const persisted = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: created.observationId, persist: true });
    assert.equal(persisted.status, 'RECONCILED');
    assert.equal(persisted.financial_account_id, account.id);
    const resolvedAt = (await pool.query('SELECT resolved_at FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [created.transactionId])).rows[0].resolved_at;
    const replay = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: created.observationId, persist: true });
    assert.equal(replay.status, 'ALREADY_RECONCILED');
    assert.equal((await pool.query('SELECT resolved_at FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [created.transactionId])).rows[0].resolved_at.getTime(), resolvedAt.getTime());

    const concurrentEvent = await ingestBankEvent(pool, event('historical-concurrent'));
    await pool.query(`UPDATE bank_transactions SET amount=NULL, currency=NULL, direction='UNKNOWN',
      event_type='UNKNOWN', normalization_status='PARTIAL', evidence_quality='PARTIAL',
      account_reference=NULL, account_reference_kind=NULL WHERE id=$1`, [concurrentEvent.transactionId]);
    const concurrent = await Promise.all([
      resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: concurrentEvent.observationId, persist: true }),
      resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: concurrentEvent.observationId, persist: true }),
    ]);
    assert.deepEqual(concurrent.map((item) => item.status).sort(), ['ALREADY_RECONCILED', 'RECONCILED']);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [concurrentEvent.transactionId])).rows[0].count, 1);

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

    const manual = await ingestBankEvent(pool, event('historical-manual', '0998'));
    await createBankAccountReference(pool, { financialAccountId: account.id, provider: 'historical.synthetic', referenceKind: 'MASKED_ACCOUNT', referenceValue: '0998' });
    await resolveBankTransactionAccount(pool, { bankTransactionId: manual.transactionId, financialAccountId: account.id, resolutionState: 'MANUAL', provenance: 'TEST_MANUAL', reason: 'Synthetic manual protection' });
    const manualResult = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: manual.observationId, persist: true });
    assert.equal(manualResult.status, 'FAIL_CLOSED');
    assert.match(manualResult.reason, /not UNKNOWN/);

    await createBankAccountReference(pool, { financialAccountId: account.id, provider: 'historical.synthetic', referenceKind: 'MASKED_ACCOUNT', referenceValue: '0997' });
    const exact = await ingestBankEvent(pool, event('historical-exact-protected', '0997'));
    await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: exact.transactionId });
    const exactResult = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: exact.observationId, persist: true });
    assert.equal(exactResult.status, 'FAIL_CLOSED');
    assert.match(exactResult.reason, /not UNKNOWN/);

    await createBankAccountReference(pool, { financialAccountId: account.id, provider: 'historical.synthetic', referenceKind: 'MASKED_ACCOUNT', referenceValue: '0995' });
    const conflicting = await ingestBankEvent(pool, event('historical-conflicting-reconciled', '0995'));
    await resolveBankTransactionAccount(pool, { bankTransactionId: conflicting.transactionId, financialAccountId: second.id, resolutionState: 'RECONCILED', provenance: 'TEST_RECONCILIATION', reason: 'Synthetic conflicting reconciliation' });
    const conflictingResult = await resolveHistoricalBankTransactionAccountFromObservation(pool, { observationId: conflicting.observationId, persist: true });
    assert.equal(conflictingResult.status, 'FAIL_CLOSED');
    assert.match(conflictingResult.reason, /conflicts/);
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    if (accountIds.length) await pool.query('DELETE FROM financial_accounts WHERE id=ANY($1::bigint[])', [accountIds]).catch(() => {});
    await pool.query('DELETE FROM persons WHERE person_key=$1', [personKey]).catch(() => {});
    await pool.end();
  }
});

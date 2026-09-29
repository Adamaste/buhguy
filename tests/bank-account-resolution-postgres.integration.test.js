import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { createBankAccountReference, createFinancialAccount, createPaymentInstrument, relateFinancialAccountPerson, resolveBankTransactionAccount, bankTransactionAccountCoverage } from '../src/bank-account-resolution.js';
import { migrate } from '../src/database.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

integration('bank account resolution keeps ownership, references, and unknown coverage explicit', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = `${process.pid}-${Date.now()}`;
  const sourceKey = `resolution-source-${suffix}`;
  const personKey = `resolution-person-${suffix}`;
  const secondPersonKey = `resolution-person-two-${suffix}`;
  let accountIds = [];
  const event = (sourceEventId, amount) => ({
    sourceKey, sourceEventId, observedAt: '2026-09-18T10:00:00Z', eventTime: '2026-09-18T09:59:00Z',
    payload: { amount, currency: 'RUB', direction: 'DEBIT', merchant: 'Synthetic account resolution' },
    ingestionMetadata: { adapter: 'test', schemaVersion: '1' },
  });
  try {
    await migrate(pool);
    const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
    const person = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scope.id, personKey, 'Synthetic source context'])).rows[0];
    const authorized = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scope.id, secondPersonKey, 'Synthetic authorized user'])).rows[0];
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic resolution source' });
    await linkBankSourcePerson(pool, { sourceKey, personId: person.id });

    const account = await createFinancialAccount(pool, { institution: 'Synthetic Bank', provider: 'synthetic.provider', displayName: 'Synthetic checking', currency: 'RUB' });
    const secondAccount = await createFinancialAccount(pool, { institution: 'Synthetic Bank', provider: 'synthetic.provider', displayName: 'Synthetic savings', currency: 'RUB' });
    accountIds = [account.id, secondAccount.id];
    await relateFinancialAccountPerson(pool, { financialAccountId: account.id, personId: person.id, relationType: 'OWNER', provenance: 'TEST_EXPLICIT', reason: 'Synthetic account owner evidence' });
    await relateFinancialAccountPerson(pool, { financialAccountId: account.id, personId: authorized.id, relationType: 'AUTHORIZED_USER', provenance: 'TEST_EXPLICIT', reason: 'Synthetic authorized-user evidence' });
    const otherScope = (await pool.query("INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id", [`resolution-scope-${suffix}`, 'Synthetic isolated scope'])).rows[0];
    const otherPerson = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [otherScope.id, `resolution-other-${suffix}`, 'Synthetic isolated person'])).rows[0];
    await assert.rejects(() => relateFinancialAccountPerson(pool, { financialAccountId: account.id, personId: otherPerson.id, relationType: 'OWNER', provenance: 'TEST', reason: 'cross-scope must fail' }), /same accounting scope/);
    await createPaymentInstrument(pool, { financialAccountId: account.id, instrumentType: 'CARD', provider: 'synthetic.provider', displayName: 'Masked test card' });
    await createBankAccountReference(pool, { financialAccountId: account.id, provider: 'synthetic.provider', referenceKind: 'MASKED_CARD', referenceValue: '****1111' });

    const first = await ingestBankEvent(pool, event('resolution-exact', '10.00'));
    const second = await ingestBankEvent(pool, event('resolution-manual', '20.00'));
    const third = await ingestBankEvent(pool, event('resolution-reconciled', '30.00'));
    const fourth = await ingestBankEvent(pool, event('resolution-unknown', '40.00'));
    assert.deepEqual([first.status, second.status, third.status, fourth.status], ['created', 'created', 'created', 'created']);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_transaction_account_resolution WHERE resolution_state=\'UNKNOWN\'')).rows[0].count, 4);

    await resolveBankTransactionAccount(pool, { bankTransactionId: first.transactionId, financialAccountId: account.id, resolutionState: 'EXACT', provenance: 'TEST_EXACT_REFERENCE', reason: 'Exact provider-scoped masked reference' });
    await resolveBankTransactionAccount(pool, { bankTransactionId: second.transactionId, financialAccountId: secondAccount.id, resolutionState: 'MANUAL', provenance: 'TEST_MANUAL', reason: 'Explicit operator mapping' });
    await resolveBankTransactionAccount(pool, { bankTransactionId: third.transactionId, financialAccountId: account.id, resolutionState: 'RECONCILED', provenance: 'TEST_RECONCILIATION', reason: 'Explicit later reconciliation' });
    const coverage = await bankTransactionAccountCoverage(pool);
    assert.deepEqual(coverage, { totalBankTransactions: 4, resolvedAccount: 3, unresolvedAccount: 1, exact: 1, manual: 1, reconciled: 1, unknown: 1, invariant: true });

    await assert.rejects(() => resolveBankTransactionAccount(pool, { bankTransactionId: fourth.transactionId, financialAccountId: account.id, resolutionState: 'UNKNOWN', provenance: 'TEST', reason: 'ambiguous mapping' }), /UNKNOWN resolution/);
    await assert.rejects(() => createBankAccountReference(pool, { financialAccountId: secondAccount.id, provider: 'synthetic.provider', referenceKind: 'MASKED_CARD', referenceValue: '****1111' }), (error) => error.code === '23505');
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM financial_account_person_relations WHERE financial_account_id=$1`, [account.id])).rows[0].count, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM financial_account_person_relations WHERE financial_account_id=$1 AND relation_type='OWNER'`, [secondAccount.id])).rows[0].count, 0);

    const replay = await ingestBankEvent(pool, event('resolution-exact', '10.00'));
    const conflict = await ingestBankEvent(pool, { ...event('resolution-exact', '10.00'), payload: { ...event('resolution-exact', '11.00').payload } });
    assert.equal(replay.status, 'duplicate');
    assert.deepEqual(conflict, { status: 'rejected', code: 'SOURCE_EVENT_CONFLICT' });
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    if (accountIds.length) await pool.query('DELETE FROM financial_accounts WHERE id=ANY($1::bigint[])', [accountIds]).catch(() => {});
    await pool.query('DELETE FROM persons WHERE person_key IN ($1,$2,$3)', [personKey, secondPersonKey, `resolution-other-${suffix}`]).catch(() => {});
    await pool.query('DELETE FROM accounting_scopes WHERE scope_key=$1', [`resolution-scope-${suffix}`]).catch(() => {});
    await pool.end();
  }
});

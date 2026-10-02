import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { createBankAccountReference, createFinancialAccount, createPaymentInstrument, relateFinancialAccountPerson, resolveBankTransactionAccount, resolveBankTransactionAccountFromReference, resolveBankTransactionPaymentInstrumentFromReference, bankTransactionAccountCoverage } from '../src/bank-account-resolution.js';
import { bindBankSourceProviderAccount, disableBankSourceProviderAccountBinding } from '../src/bank-source-provider-binding.js';
import { migrate } from '../src/database.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

integration('bank account resolution keeps ownership, references, and unknown coverage explicit', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = `${process.pid}-${Date.now()}`;
  const sourceKey = `resolution-source-${suffix}`;
  const personKey = `resolution-person-${suffix}`;
  const secondPersonKey = `resolution-person-two-${suffix}`;
  let accountIds = [];
  let instrumentIds = [];
  const event = (sourceEventId, amount, accountReference = null, eventSourceKey = sourceKey, accountReferenceKind = accountReference ? 'MASKED_ACCOUNT' : null) => ({
    sourceKey: eventSourceKey, sourceEventId, observedAt: '2026-09-18T10:00:00Z', eventTime: '2026-09-18T09:59:00Z',
    payload: { amount, currency: 'RUB', direction: 'DEBIT', merchant: 'Synthetic account resolution', ...(accountReference ? { accountReference, accountReferenceKind } : {}) },
    ingestionMetadata: { adapter: 'test', provider: 'synthetic.provider', schemaVersion: '1' },
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
    const card = await createPaymentInstrument(pool, { financialAccountId: account.id, instrumentType: 'CARD', provider: 'synthetic.provider', displayName: 'Masked test card' });
    const secondCard = await createPaymentInstrument(pool, { financialAccountId: secondAccount.id, instrumentType: 'CARD', provider: 'synthetic.provider', displayName: 'Second masked test card' });
    const uniqueCard = await createPaymentInstrument(pool, { scopeKey: 'default', instrumentType: 'CARD', provider: 'synthetic.provider', displayName: 'Unique masked test card' });
    instrumentIds = [secondCard.id, uniqueCard.id];
    await createBankAccountReference(pool, { paymentInstrumentId: card.id, provider: 'synthetic.provider', referenceKind: 'MASKED_CARD', referenceValue: '****1111' });
    await createBankAccountReference(pool, { paymentInstrumentId: secondCard.id, provider: 'synthetic.provider', referenceKind: 'MASKED_CARD', referenceValue: '****1111' });
    await createBankAccountReference(pool, { paymentInstrumentId: uniqueCard.id, provider: 'synthetic.provider', referenceKind: 'MASKED_CARD', referenceValue: '****4444' });
    await createBankAccountReference(pool, { financialAccountId: account.id, provider: 'synthetic.provider', referenceKind: 'MASKED_ACCOUNT', referenceValue: '****1111' });
    await createBankAccountReference(pool, { financialAccountId: secondAccount.id, provider: 'synthetic.provider', referenceKind: 'MASKED_ACCOUNT', referenceValue: '****1111' });
    await createBankAccountReference(pool, { financialAccountId: account.id, provider: 'synthetic.provider', referenceKind: 'MASKED_ACCOUNT', referenceValue: '****2222' });
    await createBankAccountReference(pool, { financialAccountId: secondAccount.id, provider: 'synthetic.provider', referenceKind: 'MASKED_ACCOUNT', referenceValue: '****3333' });

    const first = await ingestBankEvent(pool, event('resolution-ambiguous', '10.00', '****1111'));
    const second = await ingestBankEvent(pool, event('resolution-exact', '20.00', '****2222'));
    const third = await ingestBankEvent(pool, event('resolution-unmatched', '30.00', '****9999'));
    const fourth = await ingestBankEvent(pool, event('resolution-manual', '40.00'));
    const fifth = await ingestBankEvent(pool, event('resolution-reconciled', '50.00'));
    assert.deepEqual([first.status, second.status, third.status, fourth.status, fifth.status], ['created', 'created', 'created', 'created', 'created']);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_transaction_account_resolution WHERE resolution_state=\'UNKNOWN\'')).rows[0].count, 4);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_transaction_account_resolution WHERE resolution_state=\'EXACT\'')).rows[0].count, 1);

    const ambiguous = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: first.transactionId });
    assert.equal(ambiguous.resolution_state, 'UNKNOWN');
    assert.equal(ambiguous.candidateCount, 2);
    const exact = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: second.transactionId });
    assert.equal(exact.resolution_state, 'EXACT');
    assert.equal(exact.financial_account_id, account.id);
    const kindSpecific = await ingestBankEvent(pool, event('resolution-kind-specific', '25.00', '****3333', sourceKey, 'MASKED_ACCOUNT'));
    const kindSpecificResolution = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: kindSpecific.transactionId });
    assert.equal(kindSpecificResolution.resolution_state, 'EXACT');
    assert.equal(kindSpecificResolution.financial_account_id, secondAccount.id);
    const cardEvent = await ingestBankEvent(pool, event('resolution-card', '26.00', '****1111', sourceKey, 'MASKED_CARD'));
    const cardResolution = await resolveBankTransactionPaymentInstrumentFromReference(pool, { bankTransactionId: cardEvent.transactionId });
    assert.equal(cardResolution.resolution_state, 'UNKNOWN');
    assert.equal(cardResolution.candidateCount, 2);
    const accountResolutionForCard = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: cardEvent.transactionId });
    assert.equal(accountResolutionForCard.status, 'NOT_APPLICABLE');
    assert.equal(accountResolutionForCard.changed, false);
    assert.equal(accountResolutionForCard.candidateCount, 0);
    assert.equal((await pool.query('SELECT resolution_state FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [cardEvent.transactionId])).rows[0].resolution_state, 'UNKNOWN');
    const uniqueCardEvent = await ingestBankEvent(pool, event('resolution-unique-card', '27.00', '****4444', sourceKey, 'MASKED_CARD'));
    assert.equal(uniqueCardEvent.identityResolution.paymentInstrument.resolutionState, 'EXACT');
    assert.equal(uniqueCardEvent.identityResolution.paymentInstrument.paymentInstrumentId, Number(uniqueCard.id));
    assert.equal(uniqueCardEvent.identityResolution.account.resolutionState, 'UNKNOWN');
    const unmatched = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: third.transactionId });
    assert.equal(unmatched.resolution_state, 'UNKNOWN');
    assert.equal(unmatched.candidateCount, 0);
    const missingKind = await ingestBankEvent(pool, event('resolution-missing-kind', '35.00', '****2222', sourceKey, null));
    const missingKindResolution = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: missingKind.transactionId });
    assert.equal(missingKindResolution.resolution_state, 'UNKNOWN');
    assert.equal(missingKindResolution.candidateCount, 0);
    await resolveBankTransactionAccount(pool, { bankTransactionId: fourth.transactionId, financialAccountId: secondAccount.id, resolutionState: 'MANUAL', provenance: 'TEST_MANUAL', reason: 'Explicit operator mapping' });
    await resolveBankTransactionAccount(pool, { bankTransactionId: fifth.transactionId, financialAccountId: account.id, resolutionState: 'RECONCILED', provenance: 'TEST_RECONCILIATION', reason: 'Explicit later reconciliation' });
    const coverage = await bankTransactionAccountCoverage(pool);
    assert.deepEqual(coverage, { totalBankTransactions: 9, resolvedAccount: 4, unresolvedAccount: 5, exact: 2, manual: 1, reconciled: 1, unknown: 5, invariant: true });

    await assert.rejects(() => resolveBankTransactionAccount(pool, { bankTransactionId: first.transactionId, financialAccountId: account.id, resolutionState: 'EXACT', provenance: 'TEST', reason: 'arbitrary exact mapping' }), /proven account reference evidence/);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM financial_account_person_relations WHERE financial_account_id=$1`, [account.id])).rows[0].count, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM financial_account_person_relations WHERE financial_account_id=$1 AND relation_type='OWNER'`, [secondAccount.id])).rows[0].count, 0);

    await linkBankSourcePerson(pool, { sourceKey, personId: otherPerson.id });
    const multiScope = await ingestBankEvent(pool, event('resolution-multi-scope', '60.00', '****2222'));
    assert.equal((await pool.query('SELECT provenance FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [multiScope.transactionId])).rows[0].provenance, 'INGESTION_SCOPE_AMBIGUOUS');
    await assert.rejects(() => resolveBankTransactionAccountFromReference(pool, { bankTransactionId: multiScope.transactionId }), /accounting scope is not unique/);

    const noScopeKey = `resolution-no-scope-${suffix}`;
    await createBankSource(pool, { sourceKey: noScopeKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic no-scope source' });
    const noScope = await ingestBankEvent(pool, event('resolution-no-scope', '70.00', '****2222', noScopeKey));
    assert.equal((await pool.query('SELECT provenance FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [noScope.transactionId])).rows[0].provenance, 'INGESTION_SCOPE_UNRESOLVED');
    await assert.rejects(() => resolveBankTransactionAccountFromReference(pool, { bankTransactionId: noScope.transactionId }), /accounting scope is not unique/);
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [noScopeKey]);
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [noScopeKey]);
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [noScopeKey]);

    const replay = await ingestBankEvent(pool, event('resolution-exact', '20.00', '****2222'));
    const conflict = await ingestBankEvent(pool, { ...event('resolution-exact', '10.00'), payload: { ...event('resolution-exact', '11.00').payload } });
    assert.equal(replay.status, 'duplicate');
    assert.deepEqual(conflict, { status: 'rejected', code: 'SOURCE_EVENT_CONFLICT' });
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    if (instrumentIds.length) await pool.query('DELETE FROM bank_account_references WHERE payment_instrument_id=ANY($1::bigint[])', [instrumentIds]).catch(() => {});
    if (instrumentIds.length) await pool.query('DELETE FROM payment_instruments WHERE id=ANY($1::bigint[])', [instrumentIds]).catch(() => {});
    if (accountIds.length) await pool.query('DELETE FROM financial_accounts WHERE id=ANY($1::bigint[])', [accountIds]).catch(() => {});
    await pool.query('DELETE FROM persons WHERE person_key IN ($1,$2,$3)', [personKey, secondPersonKey, `resolution-other-${suffix}`]).catch(() => {});
    await pool.query('DELETE FROM accounting_scopes WHERE scope_key=$1', [`resolution-scope-${suffix}`]).catch(() => {});
    await pool.end();
  }
});

integration('source/provider binding is explicit, reference-first, scoped, and fail-closed', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = `${process.pid}-${Date.now()}`;
  const sourceKey = `binding-source-${suffix}`;
  const otherSourceKey = `binding-other-source-${suffix}`;
  const noScopeSourceKey = `binding-no-scope-${suffix}`;
  const multiScopeKey = `binding-multi-${suffix}`;
  let accountIds = [];
  let cardId;
  const event = (id, provider = 'binding.provider', payload = { amount: '12.00', currency: 'RUB', direction: 'UNKNOWN' }, key = sourceKey) => ({
    sourceKey: key, sourceEventId: id, observedAt: '2026-10-02T10:00:00Z', eventTime: '2026-10-02T09:59:00Z',
    payload, ingestionMetadata: { adapter: 'test', provider, schemaVersion: '1' },
  });
  try {
    await migrate(pool);
    const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
    const person = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scope.id, `binding-person-${suffix}`, 'Synthetic binding context'])).rows[0];
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic provider binding source' });
    await linkBankSourcePerson(pool, { sourceKey, personId: person.id });
    const boundAccount = await createFinancialAccount(pool, { institution: 'Binding Bank', provider: 'binding.provider', displayName: `Binding target ${suffix}` });
    const referenceAccount = await createFinancialAccount(pool, { institution: 'Binding Bank', provider: 'binding.provider', displayName: `Reference target ${suffix}` });
    accountIds = [boundAccount.id, referenceAccount.id];
    await createBankAccountReference(pool, { financialAccountId: referenceAccount.id, provider: 'binding.provider', referenceKind: 'MASKED_ACCOUNT', referenceValue: 'REF-2222' });
    const binding = await bindBankSourceProviderAccount(pool, { sourceKey, provider: 'binding.provider', financialAccountId: boundAccount.id, reason: 'Synthetic user-confirmed source/provider mapping' });
    const repeated = await bindBankSourceProviderAccount(pool, { sourceKey, provider: 'binding.provider', financialAccountId: boundAccount.id, reason: 'A different reason is not used for an existing exact bind' });
    assert.equal(Number(repeated.id), Number(binding.id));
    await assert.rejects(() => bindBankSourceProviderAccount(pool, { sourceKey, provider: 'binding.provider', financialAccountId: referenceAccount.id, reason: 'Conflicting target' }), (error) => error.code === 'BINDING_CONFLICT');

    const bound = await ingestBankEvent(pool, event('binding-no-reference'));
    assert.equal(bound.identityResolution.account.resolutionState, 'MANUAL');
    assert.equal(bound.identityResolution.account.financialAccountId, Number(boundAccount.id));
    assert.equal(bound.identityResolution.account.provenance, 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT');
    const noReferenceRetry = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: bound.transactionId });
    assert.equal(noReferenceRetry.status, 'NOT_APPLICABLE');
    assert.equal(noReferenceRetry.resolutionState, 'MANUAL');
    assert.equal(Number(noReferenceRetry.financialAccountId), Number(boundAccount.id));
    assert.equal(noReferenceRetry.changed, false);
    const boundPersisted = (await pool.query('SELECT financial_account_id,resolution_state,provenance FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [bound.transactionId])).rows[0];
    assert.equal(Number(boundPersisted.financial_account_id), Number(boundAccount.id));
    assert.equal(boundPersisted.resolution_state, 'MANUAL');
    assert.equal(boundPersisted.provenance, 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT');

    const otherProvider = await ingestBankEvent(pool, event('binding-other-provider', 'other.provider'));
    assert.equal(otherProvider.identityResolution.account.resolutionState, 'UNKNOWN');
    assert.equal(otherProvider.identityResolution.account.financialAccountId, null);

    await createBankSource(pool, { sourceKey: otherSourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic other binding source' });
    await linkBankSourcePerson(pool, { sourceKey: otherSourceKey, personId: person.id });
    const otherSource = await ingestBankEvent(pool, event('binding-other-source', 'binding.provider', undefined, otherSourceKey));
    assert.equal(otherSource.identityResolution.account.resolutionState, 'UNKNOWN');
    assert.equal(otherSource.identityResolution.account.financialAccountId, null);

    const exact = await ingestBankEvent(pool, event('binding-reference-wins', 'binding.provider', { amount: '13.00', currency: 'RUB', direction: 'UNKNOWN', accountReference: 'REF-2222', accountReferenceKind: 'MASKED_ACCOUNT' }));
    assert.equal(exact.identityResolution.account.resolutionState, 'EXACT');
    assert.equal(exact.identityResolution.account.financialAccountId, Number(referenceAccount.id));
    const unknownKind = await ingestBankEvent(pool, event('binding-unknown-kind', 'binding.provider', { amount: '14.00', currency: 'RUB', direction: 'UNKNOWN', accountReference: 'MASKED-UNKNOWN' }));
    assert.equal(unknownKind.identityResolution.account.resolutionState, 'UNKNOWN');

    const card = await createPaymentInstrument(pool, { scopeKey: 'default', instrumentType: 'CARD', provider: 'binding.provider', displayName: `Binding card ${suffix}` });
    cardId = Number(card.id);
    await createBankAccountReference(pool, { paymentInstrumentId: cardId, provider: 'binding.provider', referenceKind: 'MASKED_CARD', referenceValue: 'CARD-1111' });
    const cardEvent = await ingestBankEvent(pool, event('binding-card-no-account-fallback', 'binding.provider', { amount: '15.00', currency: 'RUB', direction: 'UNKNOWN', accountReference: 'CARD-1111', accountReferenceKind: 'MASKED_CARD' }));
    assert.equal(cardEvent.identityResolution.account.resolutionState, 'UNKNOWN');
    assert.equal(cardEvent.identityResolution.paymentInstrument.resolutionState, 'EXACT');

    await disableBankSourceProviderAccountBinding(pool, { sourceKey, provider: 'binding.provider' });
    const disabled = await ingestBankEvent(pool, event('binding-disabled'));
    assert.equal(disabled.identityResolution.account.resolutionState, 'UNKNOWN');
    assert.equal(disabled.identityResolution.account.provenance, 'SOURCE_PROVIDER_BINDING_UNRESOLVED');

    const otherScope = (await pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [multiScopeKey, 'Binding second scope'])).rows[0];
    const otherPerson = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [otherScope.id, `binding-other-${suffix}`, 'Synthetic second context'])).rows[0];
    await linkBankSourcePerson(pool, { sourceKey, personId: otherPerson.id });
    await assert.rejects(() => bindBankSourceProviderAccount(pool, { sourceKey, provider: 'other.provider', financialAccountId: boundAccount.id, reason: 'Ambiguous scope must fail' }), (error) => error.code === 'SOURCE_SCOPE_AMBIGUOUS');

    await createBankSource(pool, { sourceKey: noScopeSourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic no-scope binding source' });
    await assert.rejects(() => bindBankSourceProviderAccount(pool, { sourceKey: noScopeSourceKey, provider: 'binding.provider', financialAccountId: boundAccount.id, reason: 'No scope must fail' }), (error) => error.code === 'SOURCE_SCOPE_UNRESOLVED');
  } finally {
    for (const cleanupSourceKey of [sourceKey, otherSourceKey, noScopeSourceKey]) {
      await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [cleanupSourceKey]).catch(() => {});
      await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [cleanupSourceKey]).catch(() => {});
      await pool.query('DELETE FROM bank_source_person WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [cleanupSourceKey]).catch(() => {});
      await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [cleanupSourceKey]).catch(() => {});
    }
    if (cardId) await pool.query('DELETE FROM bank_account_references WHERE payment_instrument_id=$1', [cardId]).catch(() => {});
    if (cardId) await pool.query('DELETE FROM payment_instruments WHERE id=$1', [cardId]).catch(() => {});
    if (accountIds.length) await pool.query('DELETE FROM bank_account_references WHERE financial_account_id=ANY($1::bigint[])', [accountIds]).catch(() => {});
    if (accountIds.length) await pool.query('DELETE FROM financial_accounts WHERE id=ANY($1::bigint[])', [accountIds]).catch(() => {});
    await pool.query('DELETE FROM persons WHERE person_key IN ($1,$2)', [`binding-person-${suffix}`, `binding-other-${suffix}`]).catch(() => {});
    await pool.query('DELETE FROM accounting_scopes WHERE scope_key=$1', [multiScopeKey]).catch(() => {});
    await pool.end();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import {
  createBankAccountReference,
  createFinancialAccount,
  createPaymentInstrument,
  linkPaymentInstrumentAccount,
  relatePaymentInstrumentPerson,
  resolveBankTransactionAccountFromReference,
  resolveBankTransactionPaymentInstrumentFromReference,
} from '../src/bank-account-resolution.js';
import { migrate } from '../src/database.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

integration('payment instruments preserve standalone card identity and fail closed account linkage', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = `${process.pid}-${Date.now()}`;
  const sourceKey = `instrument-source-${suffix}`;
  const personKey = `instrument-person-${suffix}`;
  const secondPersonKey = `instrument-person-two-${suffix}`;
  const event = (sourceEventId, reference, kind) => ({
    sourceKey,
    sourceEventId,
    observedAt: '2026-09-18T10:00:00Z',
    eventTime: '2026-09-18T09:59:00Z',
    payload: { amount: '10.00', currency: 'RUB', direction: 'DEBIT', merchant: 'Synthetic instrument test', accountReference: reference, accountReferenceKind: kind },
    ingestionMetadata: { adapter: 'test', provider: 'instrument.provider', schemaVersion: '1' },
  });
  try {
    await migrate(pool);
    const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
    const person = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scope.id, personKey, 'Synthetic instrument owner'])).rows[0];
    const secondPerson = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scope.id, secondPersonKey, 'Synthetic second owner'])).rows[0];
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic instrument source' });
    await linkBankSourcePerson(pool, { sourceKey, personId: person.id });

    const account = await createFinancialAccount(pool, { institution: 'Synthetic Bank', provider: 'instrument.provider', displayName: 'Synthetic checking' });
    const card = await createPaymentInstrument(pool, { scopeKey: 'default', instrumentType: 'CARD', provider: 'instrument.provider', displayName: 'Synthetic standalone card' });
    assert.equal(card.financial_account_id, null);

    await relatePaymentInstrumentPerson(pool, { paymentInstrumentId: card.id, personId: person.id, relationType: 'OWNER', provenance: 'USER_CONFIRMED', reason: 'Synthetic explicit card owner evidence' });
    await assert.rejects(
      () => relatePaymentInstrumentPerson(pool, { paymentInstrumentId: card.id, personId: secondPerson.id, relationType: 'OWNER', provenance: 'CONFLICTING_TEST', reason: 'Must not overwrite owner' }),
      /duplicate key|unique/i,
    );

    await createBankAccountReference(pool, { paymentInstrumentId: card.id, provider: 'instrument.provider', referenceKind: 'MASKED_CARD', referenceValue: '****8451' });
    await createBankAccountReference(pool, { financialAccountId: account.id, provider: 'instrument.provider', referenceKind: 'MASKED_ACCOUNT', referenceValue: '****8451' });

    const cardEvent = await ingestBankEvent(pool, event('standalone-card', '****8451', 'MASKED_CARD'));
    const instrumentResolution = await resolveBankTransactionPaymentInstrumentFromReference(pool, { bankTransactionId: cardEvent.transactionId });
    assert.equal(instrumentResolution.resolution_state, 'EXACT');
    assert.equal(instrumentResolution.payment_instrument_id, card.id);
    const accountResolutionForCard = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: cardEvent.transactionId });
    assert.equal(accountResolutionForCard.resolution_state, 'UNKNOWN');
    assert.equal(accountResolutionForCard.financial_account_id, null);

    const accountEvent = await ingestBankEvent(pool, event('account-reference', '****8451', 'MASKED_ACCOUNT'));
    const accountResolution = await resolveBankTransactionAccountFromReference(pool, { bankTransactionId: accountEvent.transactionId });
    assert.equal(accountResolution.resolution_state, 'EXACT');
    assert.equal(accountResolution.financial_account_id, account.id);

    const secondCard = await createPaymentInstrument(pool, { scopeKey: 'default', instrumentType: 'CARD', provider: 'instrument.provider', displayName: 'Synthetic second standalone card' });
    await createBankAccountReference(pool, { paymentInstrumentId: secondCard.id, provider: 'instrument.provider', referenceKind: 'MASKED_CARD', referenceValue: '****8451' });
    const ambiguousEvent = await ingestBankEvent(pool, event('ambiguous-card', '****8451', 'MASKED_CARD'));
    const ambiguous = await resolveBankTransactionPaymentInstrumentFromReference(pool, { bankTransactionId: ambiguousEvent.transactionId });
    assert.equal(ambiguous.resolution_state, 'UNKNOWN');
    assert.equal(ambiguous.candidateCount, 2);

    await linkPaymentInstrumentAccount(pool, { paymentInstrumentId: card.id, financialAccountId: account.id });
    const linked = (await pool.query('SELECT financial_account_id FROM payment_instruments WHERE id=$1', [card.id])).rows[0];
    assert.equal(Number(linked.financial_account_id), account.id);
    const otherAccount = await createFinancialAccount(pool, { institution: 'Synthetic Bank', provider: 'instrument.provider', displayName: 'Synthetic second checking' });
    await assert.rejects(() => linkPaymentInstrumentAccount(pool, { paymentInstrumentId: card.id, financialAccountId: otherAccount.id }), /already linked/);
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM payment_instruments WHERE display_name IN ($1,$2)', ['Synthetic standalone card', 'Synthetic second standalone card']).catch(() => {});
    await pool.query('DELETE FROM financial_accounts WHERE display_name IN ($1,$2)', ['Synthetic checking', 'Synthetic second checking']).catch(() => {});
    await pool.query('DELETE FROM persons WHERE person_key IN ($1,$2)', [personKey, secondPersonKey]).catch(() => {});
    await pool.end();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { authenticateBankDevice, createBankDeviceCredential } from '../src/bank-device-auth.js';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { createBankAccountReference, createFinancialAccount, createPaymentInstrument } from '../src/bank-account-resolution.js';
import { createProvisionedBankSource, linkProvisionedBankSourcePerson, listProvisionedBankSources, setProvisionedBankSourceEnabled } from '../src/bank-source-provisioning.js';
import { migrate } from '../src/database.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

async function cleanupRuntimeRole(admin) {
  const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='receipt_collector'");
  if (!role.rowCount) return;
  await admin.query('DROP OWNED BY receipt_collector');
  await admin.query('DROP ROLE receipt_collector');
}

integration('bank ingestion is immutable, source-scoped, and deterministic', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await createBankSource(pool, { sourceKey: 'android-bank-test-a', sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic bank A' });
    await createBankSource(pool, { sourceKey: 'android-bank-test-b', sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic bank B' });
    const event = {
      sourceKey: 'android-bank-test-a', sourceEventId: 'evt-1', observedAt: '2026-09-18T10:00:00Z', eventTime: '2026-09-18T09:59:00Z',
      payload: { amount: '125.50', currency: 'RUB', direction: 'DEBIT', merchant: 'Synthetic shop' },
      ingestionMetadata: { adapter: 'test', schemaVersion: '1' },
    };
    const [exactFirst, exactSecond] = await Promise.all([
      ingestBankEvent(pool, event),
      ingestBankEvent(pool, event),
    ]);
    assert.deepEqual([exactFirst.status, exactSecond.status].sort(), ['created', 'duplicate']);
    const conflictEvent = { ...event, sourceEventId: 'evt-conflict' };
    const [conflictFirst, conflictSecond] = await Promise.all([
      ingestBankEvent(pool, conflictEvent),
      ingestBankEvent(pool, { ...conflictEvent, payload: { ...conflictEvent.payload, amount: '126.00' } }),
    ]);
    assert.deepEqual([conflictFirst.status, conflictSecond.status].sort(), ['created', 'rejected']);
    assert.equal([conflictFirst, conflictSecond].filter((result) => result.code === 'SOURCE_EVENT_CONFLICT').length, 1);
    assert.equal((await ingestBankEvent(pool, event)).status, 'duplicate');
    assert.equal((await ingestBankEvent(pool, { ...event, sourceKey: 'android-bank-test-b' })).status, 'created');
    const yandexPurchase = await ingestBankEvent(pool, {
      ...event,
      sourceEventId: 'evt-yandex-purchase',
      payload: { title: 'Покупка', description: 'Покупка на 42.10 RUB ТЕСТОВЫЙ МАГАЗИН' },
      ingestionMetadata: { adapter: 'android-notification', provider: 'com.yandex.bank', deviceType: 'android', schemaVersion: '1' },
    });
    const yandexIncoming = await ingestBankEvent(pool, {
      ...event,
      sourceEventId: 'evt-yandex-incoming',
      payload: { title: 'Входящий перевод', description: 'Пополнение на 100.00 RUB ТЕСТОВЫЙ ОТПРАВИТЕЛЬ' },
      ingestionMetadata: { adapter: 'android-notification', provider: 'com.yandex.bank', deviceType: 'android', schemaVersion: '1' },
    });
    assert.equal(yandexPurchase.status, 'created');
    assert.equal(yandexPurchase.normalization.eventType, 'PURCHASE');
    assert.equal(yandexIncoming.status, 'created');
    assert.equal(yandexIncoming.normalization.eventType, 'INCOMING_TRANSFER');
    const yandexBefore = (await pool.query(`SELECT id,payload,payload_sha256 FROM bank_event_observations WHERE source_event_id='evt-yandex-purchase'`)).rows[0];
    const yandexReplay = await ingestBankEvent(pool, {
      ...event,
      sourceEventId: 'evt-yandex-purchase',
      payload: { title: 'Покупка', description: 'Покупка на 42.10 RUB ТЕСТОВЫЙ МАГАЗИН' },
      ingestionMetadata: { adapter: 'android-notification', provider: 'com.yandex.bank', deviceType: 'android', schemaVersion: '1' },
    });
    assert.equal(yandexReplay.status, 'duplicate');
    assert.equal(yandexReplay.observationId, Number(yandexBefore.id));
    const yandexConflict = await ingestBankEvent(pool, {
      ...event,
      sourceEventId: 'evt-yandex-purchase',
      payload: { title: 'Покупка', description: 'Покупка на 43.10 RUB ТЕСТОВЫЙ МАГАЗИН' },
      ingestionMetadata: { adapter: 'android-notification', provider: 'com.yandex.bank', deviceType: 'android', schemaVersion: '1' },
    });
    assert.deepEqual(yandexConflict, { status: 'rejected', code: 'SOURCE_EVENT_CONFLICT' });
    const yandexAfter = (await pool.query(`SELECT id,payload,payload_sha256 FROM bank_event_observations WHERE source_event_id='evt-yandex-purchase'`)).rows[0];
    assert.deepEqual(yandexAfter, yandexBefore);
    const sberEvent = {
      ...event,
      sourceEventId: 'evt-sber-incoming',
      payload: { title: 'Перевод по СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ.', description: '+ 123 ₽ — Баланс: 6 789,01 ₽ Плат. счёт •• 0000' },
      ingestionMetadata: { adapter: 'android-notification', provider: 'ru.sberbankmobile', deviceType: 'android', schemaVersion: '1' },
    };
    const sberCreated = await ingestBankEvent(pool, sberEvent);
    assert.equal(sberCreated.status, 'created');
    assert.equal(sberCreated.normalization.eventType, 'INCOMING_TRANSFER');
    assert.equal(sberCreated.normalization.direction, 'CREDIT');
    assert.equal(sberCreated.normalization.amount, '123.00');
    assert.equal(sberCreated.normalization.normalizationVersion, 'sber-bank-normalizer-v4');
    assert.equal(sberCreated.normalization.accountReference, '0000');
    const sberBefore = (await pool.query(`SELECT id,payload,payload_sha256 FROM bank_event_observations WHERE source_event_id='evt-sber-incoming'`)).rows[0];
    const sberReplay = await ingestBankEvent(pool, sberEvent);
    assert.equal(sberReplay.status, 'duplicate');
    assert.equal(sberReplay.observationId, Number(sberBefore.id));
    const sberConflict = await ingestBankEvent(pool, { ...sberEvent, payload: { ...sberEvent.payload, description: '+ 124 ₽ — Баланс: 6 790,01 ₽ Плат. счёт •• 0000' } });
    assert.deepEqual(sberConflict, { status: 'rejected', code: 'SOURCE_EVENT_CONFLICT' });
    const sberAfter = (await pool.query(`SELECT id,payload,payload_sha256 FROM bank_event_observations WHERE source_event_id='evt-sber-incoming'`)).rows[0];
    assert.deepEqual(sberAfter, sberBefore);
    const counts = await pool.query(`SELECT (SELECT count(*) FROM bank_event_observations) AS observations,
      (SELECT count(*) FROM bank_transactions) AS transactions,
      (SELECT count(*) FROM information_schema.columns WHERE table_name='bank_transactions' AND column_name IN ('receipt_id','purchase_id')) AS forbidden_links`);
    assert.equal(Number(counts.rows[0].observations), 6);
    assert.equal(Number(counts.rows[0].transactions), 6);
    assert.equal(Number(counts.rows[0].forbidden_links), 0);
    const row = await pool.query('SELECT amount, currency, direction, event_type, normalization_status FROM bank_transactions ORDER BY id LIMIT 1');
    assert.equal(row.rows[0].amount, '125.50');
    assert.equal(row.rows[0].currency, 'RUB');
    assert.equal(row.rows[0].direction, 'DEBIT');
    assert.equal(row.rows[0].event_type, 'UNKNOWN');
    assert.equal(row.rows[0].normalization_status, 'READY');
    const yandexRows = await pool.query(`SELECT event_type,amount,currency,direction,normalization_status
      FROM bank_transactions WHERE observation_id IN
      (SELECT id FROM bank_event_observations WHERE source_event_id IN ('evt-yandex-purchase','evt-yandex-incoming','evt-sber-incoming'))
      ORDER BY event_type, amount`);
    assert.deepEqual(yandexRows.rows, [
      { event_type: 'INCOMING_TRANSFER', amount: '100.00', currency: 'RUB', direction: 'CREDIT', normalization_status: 'READY' },
      { event_type: 'INCOMING_TRANSFER', amount: '123.00', currency: 'RUB', direction: 'CREDIT', normalization_status: 'READY' },
      { event_type: 'PURCHASE', amount: '42.10', currency: 'RUB', direction: 'DEBIT', normalization_status: 'READY' },
    ]);
  } finally {
    await pool.end();
  }
});

integration('Sber outgoing-shaped partial evidence resolves only the proven account reference', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const sourceKey = `sber-outgoing-v4-${process.pid}-${Date.now()}`;
  let accountId;
  try {
    await migrate(pool);
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic Sber outgoing v4' });
    const person = (await pool.query("INSERT INTO persons(scope_id,person_key,display_name) SELECT id,$1,$2 FROM accounting_scopes WHERE scope_key='default' RETURNING id", [`person-${sourceKey}`, 'Synthetic Sber person'])).rows[0];
    await linkBankSourcePerson(pool, { sourceKey, personId: person.id });
    const account = await createFinancialAccount(pool, { institution: 'Synthetic Sber', provider: 'ru.sberbankmobile', displayName: `Synthetic Sber account ${sourceKey}` });
    accountId = Number(account.id);
    await createBankAccountReference(pool, { financialAccountId: accountId, provider: 'ru.sberbankmobile', referenceKind: 'MASKED_ACCOUNT', referenceValue: '0271' });

    const created = await ingestBankEvent(pool, {
      sourceKey,
      sourceEventId: 'synthetic-sber-outgoing-v4',
      observedAt: '2026-10-01T10:00:00Z',
      eventTime: '2026-10-01T09:59:00Z',
      payload: {
        title: 'ТЕСТОВЫЙ СЕРВИС‑ПЕРЕВОД',
        description: '1 234 ₽ — Баланс: 9 876,54 ₽ Плат. счёт •• 0271',
        text: '1 234 ₽ — Баланс: 9 876,54 ₽ Плат. счёт •• 0271',
      },
      ingestionMetadata: { adapter: 'android-notification', provider: 'ru.sberbankmobile', deviceType: 'android', schemaVersion: '1' },
    });

    assert.equal(created.status, 'created');
    assert.equal(created.normalization.normalizationVersion, 'sber-bank-normalizer-v4');
    assert.equal(created.normalization.normalizationStatus, 'PARTIAL');
    assert.equal(created.normalization.evidenceQuality, 'PARTIAL');
    assert.equal(created.normalization.eventType, 'UNKNOWN');
    assert.equal(created.normalization.direction, 'UNKNOWN');
    assert.equal(created.normalization.amount, '1234.00');
    assert.equal(created.normalization.currency, 'RUB');
    assert.equal(created.normalization.accountReference, '0271');
    assert.equal(created.normalization.accountReferenceKind, 'MASKED_ACCOUNT');
    assert.equal(created.identityResolution.account.resolutionState, 'EXACT');
    assert.equal(created.identityResolution.account.financialAccountId, accountId);
    assert.equal(created.identityResolution.account.provenance, 'OBSERVED_PROVIDER_REFERENCE');

    const persisted = (await pool.query(`SELECT bt.amount,bt.currency,bt.direction,bt.event_type,bt.normalization_status,
        bt.account_reference,bt.account_reference_kind,r.financial_account_id,r.resolution_state,r.provenance
      FROM bank_transactions bt
      JOIN bank_transaction_account_resolution r ON r.bank_transaction_id=bt.id
      WHERE bt.id=$1`, [created.transactionId])).rows[0];
    assert.deepEqual(persisted, {
      amount: '1234.00', currency: 'RUB', direction: 'UNKNOWN', event_type: 'UNKNOWN', normalization_status: 'PARTIAL',
      account_reference: '0271', account_reference_kind: 'MASKED_ACCOUNT', financial_account_id: String(accountId),
      resolution_state: 'EXACT', provenance: 'OBSERVED_PROVIDER_REFERENCE',
    });
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_source_person WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    if (accountId) {
      await pool.query('DELETE FROM bank_account_references WHERE financial_account_id=$1', [accountId]).catch(() => {});
      await pool.query('DELETE FROM financial_accounts WHERE id=$1', [accountId]).catch(() => {});
    }
    await pool.query('DELETE FROM persons WHERE person_key=$1', [`person-${sourceKey}`]).catch(() => {});
    await pool.end();
  }
});

integration('bank ingestion works under the restricted runtime role without extra privileges', { concurrency: false }, async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const password = crypto.randomBytes(24).toString('base64url');
  const sourceKey = `runtime-role-${process.pid}-${Date.now()}`;
  let runtime;
  try {
    await cleanupRuntimeRole(admin);
    await migrate(admin);
    await admin.query(`CREATE ROLE receipt_collector LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    await admin.query(readFileSync('scripts/apply-bank-ingestion-grants.sql', 'utf8'));
    await createBankSource(admin, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Runtime role synthetic' });
    const person = (await admin.query("INSERT INTO persons(scope_id,person_key,display_name) SELECT id,$1,$2 FROM accounting_scopes WHERE scope_key='default' RETURNING id", [`runtime-person-${sourceKey}`, 'Runtime synthetic person'])).rows[0];
    await linkBankSourcePerson(admin, { sourceKey, personId: person.id });
    const account = await createFinancialAccount(admin, { institution: 'Runtime synthetic bank', provider: 'runtime.provider', displayName: 'Runtime synthetic account' });
    await createBankAccountReference(admin, { financialAccountId: account.id, provider: 'runtime.provider', referenceKind: 'MASKED_ACCOUNT', referenceValue: '****0271' });
    const card = await createPaymentInstrument(admin, { scopeKey: 'default', instrumentType: 'CARD', provider: 'runtime.provider', displayName: 'Runtime synthetic card' });
    await createBankAccountReference(admin, { paymentInstrumentId: card.id, provider: 'runtime.provider', referenceKind: 'MASKED_CARD', referenceValue: '****1913' });
    const credential = await createBankDeviceCredential(admin, { sourceKey, displayName: 'Runtime role synthetic credential' });
    const runtimeUrl = new URL(process.env.TEST_DATABASE_URL);
    runtimeUrl.username = 'receipt_collector';
    runtimeUrl.password = password;
    runtime = new pg.Pool({ connectionString: runtimeUrl.toString() });

    assert.equal((await authenticateBankDevice(runtime, credential.token)).ok, true);
    const event = {
      sourceKey, sourceEventId: 'runtime-exact-event', observedAt: '2026-09-18T10:00:00Z', eventTime: '2026-09-18T09:59:00Z',
      payload: { amount: '125.50', currency: 'RUB', direction: 'DEBIT', merchant: 'Runtime role shop' },
      ingestionMetadata: { adapter: 'test', schemaVersion: '1' },
    };
    const [first, duplicate] = await Promise.all([ingestBankEvent(runtime, event), ingestBankEvent(runtime, event)]);
    assert.deepEqual([first.status, duplicate.status].sort(), ['created', 'duplicate']);
    const accountEvent = await ingestBankEvent(runtime, {
      ...event, sourceEventId: 'runtime-account-event',
      payload: { ...event.payload, accountReference: '****0271', accountReferenceKind: 'MASKED_ACCOUNT' },
      ingestionMetadata: { adapter: 'android-notification', provider: 'runtime.provider', deviceType: 'android', schemaVersion: '1' },
    });
    assert.equal(accountEvent.identityResolution.account.resolutionState, 'EXACT');
    assert.equal(accountEvent.identityResolution.account.financialAccountId, Number(account.id));
    const cardEvent = await ingestBankEvent(runtime, {
      ...event, sourceEventId: 'runtime-card-event',
      payload: { ...event.payload, accountReference: '****1913', accountReferenceKind: 'MASKED_CARD' },
      ingestionMetadata: { adapter: 'android-notification', provider: 'runtime.provider', deviceType: 'android', schemaVersion: '1' },
    });
    assert.equal(cardEvent.identityResolution.paymentInstrument.resolutionState, 'EXACT');
    assert.equal(cardEvent.identityResolution.paymentInstrument.paymentInstrumentId, Number(card.id));
    assert.equal(cardEvent.identityResolution.account.resolutionState, 'UNKNOWN');
    await assert.rejects(() => createFinancialAccount(runtime, { institution: 'Forbidden', displayName: 'Forbidden account' }), /permission denied/);
    await assert.rejects(() => createPaymentInstrument(runtime, { scopeKey: 'default', instrumentType: 'CARD', displayName: 'Forbidden card' }), /permission denied/);
    await assert.rejects(() => createBankAccountReference(runtime, { financialAccountId: account.id, provider: 'runtime.provider', referenceKind: 'MASKED_ACCOUNT', referenceValue: '****9999' }), /permission denied/);
    const conflict = await ingestBankEvent(runtime, { ...event, payload: { ...event.payload, amount: '126.00' } });
    assert.deepEqual(conflict, { status: 'rejected', code: 'SOURCE_EVENT_CONFLICT' });

    const privilegeRows = (await admin.query(`SELECT
      has_schema_privilege('receipt_collector','public','CREATE') AS schema_create,
      has_table_privilege('receipt_collector','public.bank_device_credentials','UPDATE') AS credential_table_update,
      has_column_privilege('receipt_collector','public.bank_device_credentials','last_used_at','UPDATE') AS credential_last_used_update,
      has_table_privilege('receipt_collector','public.bank_transactions','SELECT') AS transactions_table_select,
      has_table_privilege('receipt_collector','public.bank_event_observations','UPDATE') AS observations_update,
      has_table_privilege('receipt_collector','public.bank_event_observations','DELETE') AS observations_delete,
      has_table_privilege('receipt_collector','public.bank_transactions','DELETE') AS transactions_delete,
      has_table_privilege('receipt_collector','public.bank_sources','REFERENCES') AS sources_references,
      has_table_privilege('receipt_collector','public.bank_event_observations','REFERENCES') AS observations_references`)).rows[0];
    assert.equal(privilegeRows.schema_create, false);
    assert.equal(privilegeRows.credential_table_update, false);
    assert.equal(privilegeRows.credential_last_used_update, true);
    assert.equal(privilegeRows.transactions_table_select, false);
    assert.equal(privilegeRows.observations_update, false);
    assert.equal(privilegeRows.observations_delete, false);
    assert.equal(privilegeRows.transactions_delete, false);
    assert.equal(privilegeRows.sources_references, false);
    assert.equal(privilegeRows.observations_references, false);
  } finally {
    if (runtime) await runtime.end();
    await admin.query('DELETE FROM bank_device_credentials WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await admin.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await admin.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await admin.query('DELETE FROM bank_source_person WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await admin.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    await admin.query('DELETE FROM bank_account_references WHERE financial_account_id IN (SELECT id FROM financial_accounts WHERE display_name=$1) OR payment_instrument_id IN (SELECT id FROM payment_instruments WHERE display_name=$2)', ['Runtime synthetic account', 'Runtime synthetic card']).catch(() => {});
    await admin.query('DELETE FROM payment_instruments WHERE display_name=$1', ['Runtime synthetic card']).catch(() => {});
    await admin.query('DELETE FROM financial_accounts WHERE display_name=$1', ['Runtime synthetic account']).catch(() => {});
    await admin.query('DELETE FROM persons WHERE person_key=$1', [`runtime-person-${sourceKey}`]).catch(() => {});
    await cleanupRuntimeRole(admin);
    assert.equal((await admin.query("SELECT 1 FROM pg_roles WHERE rolname='receipt_collector'")).rowCount, 0);
    await admin.end();
  }
});

integration('bank source provisioning is DML-only, non-upserting, safe, and idempotent', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const sourceKey = `provisioning-${process.pid}-${Date.now()}`;
  try {
    await migrate(pool);
    const person = (await pool.query(`INSERT INTO persons(scope_id,person_key,display_name)
      SELECT id,$1,$2 FROM accounting_scopes WHERE scope_key='default' RETURNING person_key`, [`person-${sourceKey}`, 'Synthetic person'])).rows[0];
    const created = await createProvisionedBankSource(pool, { sourceKey, displayName: 'Synthetic phone' });
    assert.equal(created.source_type, 'ANDROID_NOTIFICATION');
    await assert.rejects(() => createProvisionedBankSource(pool, { sourceKey, displayName: 'Changed name', sourceType: 'BANK_API' }), (error) => error.code === 'SOURCE_ALREADY_EXISTS');
    const unchanged = (await pool.query('SELECT source_type,display_name,enabled FROM bank_sources WHERE source_key=$1', [sourceKey])).rows[0];
    assert.deepEqual(unchanged, { source_type: 'ANDROID_NOTIFICATION', display_name: 'Synthetic phone', enabled: true });
    await linkProvisionedBankSourcePerson(pool, { sourceKey, personKey: person.person_key });
    await linkProvisionedBankSourcePerson(pool, { sourceKey, personKey: person.person_key });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM bank_source_person sp JOIN bank_sources s ON s.id=sp.bank_source_id WHERE s.source_key=$1`, [sourceKey])).rows[0].count, 1);
    await setProvisionedBankSourceEnabled(pool, { sourceKey, enabled: false });
    assert.equal((await listProvisionedBankSources(pool)).find((source) => source.source_key === sourceKey).enabled, false);
    await pool.query('DELETE FROM bank_source_person WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]);
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]);
    await pool.query('DELETE FROM persons WHERE person_key=$1', [person.person_key]);
  } finally { await pool.end(); }
});

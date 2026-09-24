import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { authenticateBankDevice, createBankDeviceCredential } from '../src/bank-device-auth.js';
import { createBankSource, ingestBankEvent } from '../src/bank-ingestion.js';
import { createProvisionedBankSource, linkProvisionedBankSourcePerson, listProvisionedBankSources, setProvisionedBankSourceEnabled } from '../src/bank-source-provisioning.js';
import { migrate } from '../src/database.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

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
    const counts = await pool.query(`SELECT (SELECT count(*) FROM bank_event_observations) AS observations,
      (SELECT count(*) FROM bank_transactions) AS transactions,
      (SELECT count(*) FROM information_schema.columns WHERE table_name='bank_transactions' AND column_name IN ('receipt_id','purchase_id')) AS forbidden_links`);
    assert.equal(Number(counts.rows[0].observations), 3);
    assert.equal(Number(counts.rows[0].transactions), 3);
    assert.equal(Number(counts.rows[0].forbidden_links), 0);
    const row = await pool.query('SELECT amount, currency, direction, normalization_status FROM bank_transactions ORDER BY id LIMIT 1');
    assert.equal(row.rows[0].amount, '125.50');
    assert.equal(row.rows[0].currency, 'RUB');
    assert.equal(row.rows[0].direction, 'DEBIT');
    assert.equal(row.rows[0].normalization_status, 'READY');
  } finally {
    await pool.end();
  }
});

integration('bank ingestion works under the restricted runtime role without extra privileges', { concurrency: false }, async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const password = crypto.randomBytes(24).toString('base64url');
  const sourceKey = `runtime-role-${process.pid}-${Date.now()}`;
  let runtime;
  try {
    await admin.query('DROP ROLE IF EXISTS receipt_collector');
    await admin.query(`CREATE ROLE receipt_collector LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    await admin.query(readFileSync('scripts/apply-bank-ingestion-grants.sql', 'utf8'));
    await createBankSource(admin, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Runtime role synthetic' });
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
    await admin.query('DROP ROLE IF EXISTS receipt_collector').catch(() => {});
    await admin.query('DELETE FROM bank_device_credentials WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await admin.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await admin.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await admin.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
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

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
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
    const [first, second] = await Promise.all([
      ingestBankEvent(pool, event),
      ingestBankEvent(pool, { ...event, payload: { ...event.payload, amount: '126.00' } }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), ['created', 'rejected']);
    assert.equal([first, second].filter((result) => result.code === 'SOURCE_EVENT_CONFLICT').length, 1);
    assert.equal((await ingestBankEvent(pool, event)).status, 'duplicate');
    assert.equal((await ingestBankEvent(pool, { ...event, sourceKey: 'android-bank-test-b' })).status, 'created');
    const counts = await pool.query(`SELECT (SELECT count(*) FROM bank_event_observations) AS observations,
      (SELECT count(*) FROM bank_transactions) AS transactions,
      (SELECT count(*) FROM information_schema.columns WHERE table_name='bank_transactions' AND column_name IN ('receipt_id','purchase_id')) AS forbidden_links`);
    assert.equal(Number(counts.rows[0].observations), 2);
    assert.equal(Number(counts.rows[0].transactions), 2);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBankSource, ingestBankEvent } from '../src/bank-ingestion.js';
import { authenticateBankDevice, createBankDeviceCredential, listBankDeviceCredentials, revokeBankDeviceCredential } from '../src/bank-device-auth.js';
import { createBankIngestionServer } from '../src/bank-ingestion-http.js';
import { migrate } from '../src/database.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

integration('bank device auth binds credentials, preserves dedup and enforces HTTP contract', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const sourceKey = `android-http-${process.pid}-${Date.now()}`;
  try {
    await migrate(pool);
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic Android device' });
    const credential = await createBankDeviceCredential(pool, { sourceKey, displayName: 'Synthetic phone' });
    assert.equal((await authenticateBankDevice(pool, credential.token)).ok, true);
    const listed = await listBankDeviceCredentials(pool);
    const listedCredential = listed.find((row) => row.credential_key === credential.credential_key);
    assert.ok(listedCredential);
    assert.equal(Object.hasOwn(listedCredential, 'secret_hash'), false);
    assert.equal(listedCredential.token, undefined);
    const stored = await pool.query('SELECT secret_hash FROM bank_device_credentials WHERE credential_key=$1', [credential.credential_key]);
    assert.notEqual(stored.rows[0].secret_hash, credential.token);

    const server = createBankIngestionServer({ pool });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const event = { sourceKey, sourceEventId: 'http-event-1', observedAt: '2026-09-19T10:00:00Z', eventTime: '2026-09-19T09:59:00Z', payload: { amount: '12.50', currency: 'RUB', direction: 'DEBIT' }, ingestionMetadata: { adapter: 'test', schemaVersion: '1' } };
    const headers = { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' };
    try {
      const invalid = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers, body: '{"sourceKey":' });
      assert.equal(invalid.status, 400);
      const wrongContentType = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(wrongContentType.status, 415);
      const created = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers, body: JSON.stringify(event) });
      assert.equal(created.status, 201);
      const duplicate = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers, body: JSON.stringify(event) });
      assert.equal(duplicate.status, 200);
      const conflict = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers, body: JSON.stringify({ ...event, payload: { amount: '13.50', currency: 'RUB', direction: 'DEBIT' } }) });
      assert.equal(conflict.status, 409);
      const mismatch = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers, body: JSON.stringify({ ...event, sourceKey: 'other-source' }) });
      assert.equal(mismatch.status, 403);
      const oversized = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers, body: JSON.stringify({ ...event, payload: { text: 'x'.repeat(40 * 1024) } }) });
      assert.equal(oversized.status, 413);
    } finally { await new Promise((resolve) => server.close(resolve)); }

    await revokeBankDeviceCredential(pool, credential.credential_key);
    assert.equal((await authenticateBankDevice(pool, credential.token)).ok, false);
    const observations = await pool.query('SELECT count(*)::int AS count FROM bank_event_observations WHERE source_event_id=$1', ['http-event-1']);
    assert.equal(observations.rows[0].count, 1);
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]);
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]);
    await pool.query('DELETE FROM bank_device_credentials WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]);
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]);
  } finally { await pool.end(); }
});

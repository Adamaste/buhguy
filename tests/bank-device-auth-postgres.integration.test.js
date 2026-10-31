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
      async function authFailure(token) {
        const response = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(event) });
        return { status: response.status, body: await response.text() };
      }
      const invalidSecret = `${credential.token.slice(0, -1)}${credential.token.endsWith('A') ? 'B' : 'A'}`;
      const invalidResult = await authFailure(invalidSecret);
      assert.deepEqual(invalidResult, { status: 401, body: '{"status":"unauthorized","code":"AUTHENTICATION_FAILED"}' });
      await pool.query('UPDATE bank_device_credentials SET enabled=FALSE WHERE credential_key=$1', [credential.credential_key]);
      const disabledCredentialResult = await authFailure(credential.token);
      assert.deepEqual(disabledCredentialResult, invalidResult);
      await pool.query('UPDATE bank_device_credentials SET enabled=TRUE WHERE credential_key=$1', [credential.credential_key]);
      await pool.query('UPDATE bank_sources SET enabled=FALSE WHERE source_key=$1', [sourceKey]);
      const disabledSourceResult = await authFailure(credential.token);
      assert.deepEqual(disabledSourceResult, invalidResult);
      await pool.query('UPDATE bank_sources SET enabled=TRUE WHERE source_key=$1', [sourceKey]);
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
      await revokeBankDeviceCredential(pool, credential.credential_key);
      const revokedResult = await authFailure(credential.token);
      assert.deepEqual(revokedResult, invalidResult);
    } finally { await new Promise((resolve) => server.close(resolve)); }

    assert.equal((await authenticateBankDevice(pool, credential.token)).ok, false);
    const observations = await pool.query('SELECT count(*)::int AS count FROM bank_event_observations WHERE source_event_id=$1', ['http-event-1']);
    assert.equal(observations.rows[0].count, 1);
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]);
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]);
    await pool.query('DELETE FROM bank_device_credentials WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]);
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]);
  } finally { await pool.end(); }
});

integration('bank-only writer errors remain retryable across a duplicate ingestion without duplicate observations', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const sourceKey = `android-bank-only-retry-${process.pid}-${Date.now()}`;
  let server;
  try {
    await migrate(pool);
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic retry source' });
    const credential = await createBankDeviceCredential(pool, { sourceKey, displayName: 'Synthetic retry device' });
    const attempts = [];
    const logs = [];
    server = createBankIngestionServer({
      pool,
      bankOnlyPurchaseOptIn: { enabled: true, scopeKey: 'default', startAt: '2026-10-01T00:00:00.000Z', alfaStartAt: null },
      accountBankOnlyPurchase: async (_pool, { bankTransactionId }) => {
        attempts.push(bankTransactionId);
        if (attempts.length === 1) {
          throw Object.assign(new Error('database details must not be logged'), { code: '42501' });
        }
        return { status: 'PERSISTED', reasonCode: 'EXACT_BANK_PURCHASE_ACCOUNTED' };
      },
      logger: {
        info: (event, fields) => logs.push({ level: 'info', event, fields }),
        warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
        error: (event, fields) => logs.push({ level: 'error', event, fields }),
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const event = {
      sourceKey, sourceEventId: 'bank-only-retry-event',
      observedAt: new Date().toISOString(), eventTime: new Date(Date.now() - 1000).toISOString(),
      payload: { amount: '83.41', currency: 'RUB', direction: 'DEBIT', title: 'Purchase' },
      ingestionMetadata: { adapter: 'test', provider: 'bank.example', schemaVersion: '1' },
    };
    const headers = { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' };
    const send = () => fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers, body: JSON.stringify(event) });

    const first = await send();
    assert.equal(first.status, 503);
    const firstBody = await first.json();
    assert.equal(firstBody.status, 'created');
    assert.equal(firstBody.bankOnlyPurchase.status, 'ERROR');
    assert.equal(Object.hasOwn(firstBody, 'bankOnlyPurchaseRetryableFailure'), false);

    const retry = await send();
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.status, 'duplicate');
    assert.equal(retryBody.bankOnlyPurchase.status, 'PERSISTED');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1]);
    assert.equal(logs.filter(item => item.event === 'bank_only_purchase_after_ingestion').length, 2);
    assert.deepEqual(logs.map(item => item.fields.trigger), ['CREATED', 'DUPLICATE_RETRY']);
    assert.ok(logs.every(item => item.fields.bankTransactionId === attempts[0]));
    assert.doesNotMatch(JSON.stringify(logs), /database details|83\.41|Synthetic merchant|bank-only-retry-event/i);

    const rows = await pool.query(`SELECT
      (SELECT count(*)::int FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)) AS observations,
      (SELECT count(*)::int FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))) AS transactions`, [sourceKey]);
    assert.deepEqual(rows.rows[0], { observations: 1, transactions: 1 });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await pool.query('DELETE FROM bank_transactions WHERE observation_id IN (SELECT id FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1))', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_event_observations WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_device_credentials WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [sourceKey]).catch(() => {});
    await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    await pool.end();
  }
});

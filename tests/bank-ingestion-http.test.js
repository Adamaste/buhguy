import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankIngestionServer } from '../src/bank-ingestion-http.js';

async function withServer(pool, callback) {
  const server = createBankIngestionServer({ pool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('health and HTTP rejection contract do not expose internals', async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  await withServer(pool, async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const method = await fetch(`${base}/api/v1/bank/events`);
    assert.equal(method.status, 405);
    const auth = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(auth.status, 401);
    assert.deepEqual(await auth.json(), { status: 'unauthorized', code: 'AUTHENTICATION_FAILED' });
    const media = await fetch(`${base}/api/v1/bank/events`, { method: 'POST', headers: { authorization: 'Bearer malformed', 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(media.status, 415);
  });
});

test('HTTP infrastructure failures are generic and do not expose database details', async () => {
  const pool = { query: async () => { throw new Error('secret SQL, stack and DATABASE_URL must not escape'); } };
  await withServer(pool, async (base) => {
    const response = await fetch(`${base}/api/v1/bank/events`, {
      method: 'POST',
      headers: { authorization: 'Bearer bg1.credential-key.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body, '{"status":"error","code":"INTERNAL_ERROR"}');
    assert.doesNotMatch(body, /secret SQL|DATABASE_URL|stack|bg1\./i);
  });
});

test('HTTP rejects disabled and invalid credentials with the same generic response', async () => {
  const rows = {
    'invalid-key': { id: 1, secret_hash: '0'.repeat(64), enabled: true, revoked_at: null, bank_source_id: 1, source_key: 'android', source_enabled: true },
    'revoked-key': { id: 1, secret_hash: '0'.repeat(64), enabled: true, revoked_at: 'now', bank_source_id: 1, source_key: 'android', source_enabled: true },
    'disabled-key': { id: 1, secret_hash: '0'.repeat(64), enabled: false, revoked_at: null, bank_source_id: 1, source_key: 'android', source_enabled: true },
    'source-key': { id: 1, secret_hash: '0'.repeat(64), enabled: true, revoked_at: null, bank_source_id: 1, source_key: 'android', source_enabled: false },
  };
  const pool = { query: async (_sql, [key]) => ({ rows: [rows[key] ?? rows.invalid], rowCount: 1 }) };
  await withServer(pool, async (base) => {
    const request = (key) => fetch(`${base}/api/v1/bank/events`, {
      method: 'POST',
      headers: { authorization: `Bearer bg1.${key}.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12`, 'content-type': 'application/json' },
      body: '{}',
    });
    const responses = await Promise.all(['invalid-key', 'revoked-key', 'disabled-key', 'source-key'].map(request));
    const bodies = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.text() })));
    assert.deepEqual(bodies, bodies.map(() => ({ status: 401, body: '{"status":"unauthorized","code":"AUTHENTICATION_FAILED"}' })));
  });
});

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

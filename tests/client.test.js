import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FnsClient } from '../src/fns-client.js';
import { SessionStore } from '../src/session-store.js';
import { ApiError, SessionExpiredError } from '../src/errors.js';

function createMockFetch(handlers) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ url: String(url), options });
    const handler = handlers.shift();
    if (!handler) {
      throw new Error(`Unexpected request: ${pathname}`);
    }
    return handler({ url: String(url), options, pathname });
  };
  fetch.calls = calls;
  return fetch;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('list receipts does not hide 422 authentication failures', async () => {
  const fetchImpl = createMockFetch([
    () => jsonResponse({ code: 'no_data' }, { status: 422 }),
  ]);
  const client = new FnsClient({ fetchImpl });
  await assert.rejects(() => client.listReceipts(), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'no_data');
    return true;
  });
});

test('list receipts parses response', async () => {
  const fetchImpl = createMockFetch([
    ({ options }) => {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {
        limit: 10,
        offset: 0,
        dateFrom: null,
        dateTo: null,
        orderBy: null,
        inn: null,
        kktOwner: '',
      });
      return jsonResponse({
      hasMore: false,
      receipts: [{ key: '1', createdDate: '2026-09-04T10:00:00Z', kktOwner: 'Shop', totalSum: 99.5 }],
      brands: [],
      });
    },
  ]);
  const client = new FnsClient({ fetchImpl });
  const result = await client.listReceipts();
  assert.deepEqual(result.receipts, [
    { id: '1', dateTime: '2026-09-04T10:00:00Z', seller: 'Shop', sellerInn: null, totalSum: 99.5, currency: null },
  ]);
});

test('list receipts preserves browser-compatible kktOwner semantics', async () => {
  const bodies = [];
  const fetchImpl = createMockFetch([
    ({ options }) => { bodies.push(JSON.parse(options.body)); return jsonResponse({ hasMore: false, receipts: [], brands: [] }); },
    ({ options }) => { bodies.push(JSON.parse(options.body)); return jsonResponse({ hasMore: false, receipts: [], brands: [] }); },
    ({ options }) => { bodies.push(JSON.parse(options.body)); return jsonResponse({ hasMore: false, receipts: [], brands: [] }); },
    ({ options }) => { bodies.push(JSON.parse(options.body)); return jsonResponse({ hasMore: false, receipts: [], brands: [] }); },
  ]);
  const client = new FnsClient({ fetchImpl });

  await client.listReceipts();
  await client.listReceipts({ kktOwner: '' });
  await client.listReceipts({ kktOwner: 'owner-123' });
  await client.listReceipts({ kktOwner: null });

  assert.equal(bodies[0].kktOwner, '');
  assert.equal(bodies[1].kktOwner, '');
  assert.equal(bodies[2].kktOwner, 'owner-123');
  assert.equal(bodies[3].kktOwner, '');
  assert.ok(bodies.every((body) => body.kktOwner !== null && body.kktOwner !== undefined));
});

test('receipt detail parses receipt and items', async () => {
  const fetchImpl = createMockFetch([
    () => jsonResponse({
      key: 'r1',
      dateTime: '2026-09-04T10:00:00Z',
      user: 'Seller',
      userInn: '7700000000',
      totalSum: 100,
      items: [{ name: 'Milk', quantity: 2, price: 30, sum: 60 }],
    }),
  ]);
  const client = new FnsClient({ fetchImpl });
  const result = await client.getReceipt('r1');
  assert.deepEqual(result.items, [{ name: 'Milk', quantity: 2, price: 30, sum: 60 }]);
  assert.equal(result.seller, 'Seller');
});

test('request attaches bearer token and refreshes expired access token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'receipt-collector-'));
  const store = new SessionStore({ stateDir: dir });
  await store.save({
    deviceId: 'device-1',
    accessToken: 'expired-access',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
    refreshTokenExpiresAt: '2026-09-05T00:00:00.000Z',
    userAgent: 'Mozilla/5.0 (FNS browser)',
  });

  const fetchImpl = createMockFetch([
    ({ pathname, options }) => {
      assert.equal(pathname, '/api/v1/auth/token');
      assert.equal(JSON.parse(options.body).deviceInfo.metaDetails.userAgent, 'Mozilla/5.0 (FNS browser)');
      return jsonResponse({
        token: 'fresh-access',
        tokenExpireIn: 3600,
        refreshToken: 'fresh-refresh',
        refreshTokenExpiresIn: 7200,
      });
    },
    ({ pathname, options }) => {
      assert.equal(pathname, '/api/v1/receipt');
      assert.equal(options.headers.Authorization, 'Bearer fresh-access');
      return jsonResponse({ hasMore: false, receipts: [], brands: [] });
    },
  ]);

  const client = new FnsClient({ fetchImpl, sessionStore: store });
  await client.listReceipts();
  const loaded = await store.load();
  assert.equal(loaded.accessToken, 'fresh-access');
  assert.equal(loaded.refreshToken, 'fresh-refresh');
  await rm(dir, { recursive: true, force: true });
});

test('401 triggers refresh and retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'receipt-collector-'));
  const store = new SessionStore({ stateDir: dir });
  await store.save({
    deviceId: 'device-1',
    accessToken: 'old-access',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const fetchImpl = createMockFetch([
    ({ pathname, options }) => {
      assert.equal(pathname, '/api/v1/receipt');
      assert.equal(options.headers.Authorization, 'Bearer old-access');
      return jsonResponse({ code: 'Not Authenticated' }, { status: 401 });
    },
    ({ pathname }) => {
      assert.equal(pathname, '/api/v1/auth/token');
      return jsonResponse({ token: 'fresh-access', tokenExpireIn: 3600, refreshToken: 'refresh-2', refreshTokenExpiresIn: 7200 });
    },
    ({ pathname, options }) => {
      assert.equal(pathname, '/api/v1/receipt');
      assert.equal(options.headers.Authorization, 'Bearer fresh-access');
      return jsonResponse({ hasMore: false, receipts: [], brands: [] });
    },
  ]);

  const client = new FnsClient({ fetchImpl, sessionStore: store });
  await client.listReceipts();
  await rm(dir, { recursive: true, force: true });
});

test('machine-readable expired access token triggers one refresh and retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'receipt-collector-'));
  const store = new SessionStore({ stateDir: dir });
  await store.save({
    deviceId: 'device-1',
    accessToken: 'old-access',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const fetchImpl = createMockFetch([
    ({ pathname }) => {
      assert.equal(pathname, '/api/v1/receipt/fiscal_data');
      return jsonResponse({ code: 'authentication.failed.expired.token' }, { status: 422 });
    },
    ({ pathname }) => {
      assert.equal(pathname, '/api/v1/auth/token');
      return jsonResponse({ token: 'fresh-access', tokenExpireIn: 3600, refreshToken: 'refresh-2', refreshTokenExpiresIn: 7200 });
    },
    ({ pathname, options }) => {
      assert.equal(pathname, '/api/v1/receipt/fiscal_data');
      assert.equal(options.headers.Authorization, 'Bearer fresh-access');
      return jsonResponse({ key: 'r1', totalSum: 10, items: [] });
    },
  ]);

  const client = new FnsClient({ fetchImpl, sessionStore: store });
  const result = await client.getReceiptRaw('r1');
  assert.equal(result.key, 'r1');
  assert.equal(fetchImpl.calls.length, 3);
  await rm(dir, { recursive: true, force: true });
});

test('concurrent expired requests use one source refresh', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'receipt-collector-'));
  const store = new SessionStore({ stateDir: dir });
  await store.save({ deviceId: 'device-1', accessToken: 'old-access', refreshToken: 'refresh-1' });
  let refreshCalls = 0;
  let detailCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/v1/auth/token') {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ token: 'fresh-access', tokenExpireIn: 3600, refreshToken: 'refresh-2', refreshTokenExpiresIn: 7200 });
    }
    if (pathname === '/api/v1/receipt/fiscal_data') {
      detailCalls += 1;
      if (options.headers.Authorization === 'Bearer old-access') {
        return jsonResponse({ code: 'authentication.failed.expired.token' }, { status: 422 });
      }
      return jsonResponse({ key: `r${detailCalls}`, totalSum: 10, items: [] });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };
  const client = new FnsClient({ fetchImpl, sessionStore: store });
  const results = await Promise.all([client.getReceiptRaw('r1'), client.getReceiptRaw('r2')]);
  assert.equal(results.length, 2);
  assert.equal(refreshCalls, 1);
  await rm(dir, { recursive: true, force: true });
});

test('refresh failure is bounded and requires relogin', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'receipt-collector-'));
  const store = new SessionStore({ stateDir: dir });
  await store.save({ deviceId: 'device-1', accessToken: 'old-access', refreshToken: 'revoked-refresh' });
  let refreshCalls = 0;
  const fetchImpl = createMockFetch([
    () => jsonResponse({ code: 'authentication.failed.expired.token' }, { status: 422 }),
    () => { refreshCalls += 1; return jsonResponse({ code: 'refresh.token.device.change.error.code' }, { status: 422 }); },
  ]);
  const client = new FnsClient({ fetchImpl, sessionStore: store });
  await assert.rejects(() => client.getReceiptRaw('r1'), (error) => {
    assert.ok(error instanceof SessionExpiredError);
    assert.equal(error.code, 'AUTH_RELOGIN_REQUIRED');
    return true;
  });
  assert.equal(refreshCalls, 1);
  assert.equal(fetchImpl.calls.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('api errors include status and code', async () => {
  const fetchImpl = createMockFetch([
    () => jsonResponse({ code: 'bad_request', message: 'Bad request' }, { status: 400 }),
  ]);
  const client = new FnsClient({ fetchImpl });
  await assert.rejects(() => client.listReceipts(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'bad_request');
    return true;
  });
});

test('receipt list sanitizes missing fields', async () => {
  const fetchImpl = createMockFetch([
    () => jsonResponse({ hasMore: false, receipts: [{}], brands: [] }),
  ]);
  const client = new FnsClient({ fetchImpl });
  const result = await client.listReceipts();
  assert.equal(result.receipts[0].id, '');
  assert.equal(result.receipts[0].seller, null);
});

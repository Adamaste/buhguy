import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/session-store.js';

test('save and load session', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'receipt-collector-'));
  const store = new SessionStore({ stateDir: dir });
  await store.save({
    keepTokens: true,
    deviceId: 'device-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: '2026-09-04T11:00:00.000Z',
    refreshTokenExpiresAt: '2026-09-05T11:00:00.000Z',
  });

  const loaded = await store.load();
  assert.equal(loaded.deviceId, 'device-1');
  assert.equal(loaded.accessToken, 'access-1');
  assert.equal(loaded.refreshToken, 'refresh-1');
  assert.equal(loaded.accessTokenExpiresAt, '2026-09-04T11:00:00.000Z');

  const file = await readFile(path.join(dir, 'session.json'), 'utf8');
  assert.ok(file.includes('access-1'));
  await rm(dir, { recursive: true, force: true });
});

test('clear tokens removes secrets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'receipt-collector-'));
  const store = new SessionStore({ stateDir: dir });
  await store.save({
    deviceId: 'device-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
  });
  await store.clearTokens();
  const loaded = await store.load();
  assert.equal(loaded.accessToken, null);
  assert.equal(loaded.refreshToken, null);
  await rm(dir, { recursive: true, force: true });
});

test('save preserves device metadata and writes restrictive mode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'receipt-collector-'));
  const store = new SessionStore({ stateDir: dir });
  await store.save({
    deviceId: 'device-1',
    deviceInfo: { sourceDeviceId: 'device-1', sourceType: 'WEB', metaDetails: { userAgent: 'FNS' } },
  });
  const loaded = await store.load();
  assert.equal(loaded.deviceInfo.sourceDeviceId, 'device-1');
  if (process.platform !== 'win32') {
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(path.join(dir, 'session.json'))).mode & 0o777, 0o600);
  }
  await rm(dir, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankDeviceCredential, createDeviceToken, parseDeviceToken } from '../src/bank-device-auth.js';

test('device token is versioned and secret is stored only as a hash', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT id FROM bank_sources')) return { rows: [{ id: 7 }], rowCount: 1 };
      return { rows: [{ id: 11, credential_key: params[0], bank_source_id: 7, display_name: params[2], enabled: true, created_at: 'now', last_used_at: null, revoked_at: null }], rowCount: 1 };
    },
  };
  const result = await createBankDeviceCredential(pool, { sourceKey: 'android-test', displayName: 'Test device' });
  const parsed = parseDeviceToken(result.token);
  assert.equal(parsed.credentialKey, result.credential_key);
  assert.equal(parsed.secret.length, 43);
  assert.match(result.token, /^bg1\./);
  assert.notEqual(queries[1].params[3], result.token);
  assert.equal(queries[1].params[3].length, 64);
});

test('malformed device token is rejected without looking like a valid credential', () => {
  assert.equal(parseDeviceToken(''), null);
  assert.equal(parseDeviceToken(createDeviceToken('short', 'secret')), null);
  assert.equal(parseDeviceToken('bg1.key.secret-with-wrong-length'), null);
});

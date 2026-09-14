import test from 'node:test';
import assert from 'node:assert/strict';
import { redactDeep } from '../src/logger.js';

test('redacts secrets in nested structures', () => {
  const data = redactDeep({
    accessToken: 'super-secret-token',
    nested: {
      refreshToken: 'another-secret-token',
      ok: 'value',
    },
    list: [{ code: '123456' }],
  });

  const json = JSON.stringify(data);
  assert.ok(!json.includes('super-secret-token'));
  assert.ok(!json.includes('another-secret-token'));
  assert.ok(!json.includes('123456'));
  assert.ok(json.includes('[REDACTED]'));
});

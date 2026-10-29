import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  containsSensitiveAuthorizationContent,
  SENSITIVE_AUTH_NOTIFICATION_CODE,
} from '../src/bank-notification-security.js';
import { createDeviceToken } from '../src/bank-device-auth.js';
import { createBankIngestionHandler, ingestBankEvent, validateBankEventInput } from '../src/bank-ingestion.js';
import { createBankIngestionServer } from '../src/bank-ingestion-http.js';

const cleanEvent = {
  sourceKey: 'android-bank-test',
  sourceEventId: 'evt-synthetic-1',
  observedAt: '2026-10-29T10:00:00Z',
  eventTime: '2026-10-29T09:59:00Z',
  payload: { title: 'Purchase 350 RUB. Sample shop', text: 'Sample shop: 350.00 RUB', direction: 'DEBIT' },
  ingestionMetadata: { adapter: 'android-notification', schemaVersion: '1' },
};

const syntheticOtp = '000000';

test('recognizes SMS-style confirmation codes without returning matched text', () => {
  const sourceText = `Your verification code is ${syntheticOtp}. Do not share this code.`;
  assert.equal(containsSensitiveAuthorizationContent([sourceText]), true);
  assert.equal(containsSensitiveAuthorizationContent([syntheticOtp], { rejectBareShortCode: true }), true);
});

test('rejects an operation notice when it also contains a one-time code', () => {
  const event = {
    ...cleanEvent,
    payload: {
      ...cleanEvent.payload,
      description: `Purchase 350 RUB at Sample shop. One-time password: ${syntheticOtp}`,
    },
  };
  assert.throws(() => validateBankEventInput(event), (error) => {
    assert.equal(error.code, SENSITIVE_AUTH_NOTIFICATION_CODE);
    assert.equal(error.message.includes(syntheticOtp), false);
    return true;
  });
});

test('server independently rejects the bank authorization-message format', () => {
  const event = {
    ...cleanEvent,
    payload: { title: 'Сообщение авторизации', text: `Operation 16 RUB. ${syntheticOtp}` },
  };
  assert.throws(() => validateBankEventInput(event), (error) => {
    assert.equal(error.code, SENSITIVE_AUTH_NOTIFICATION_CODE);
    assert.equal(error.message.includes(syntheticOtp), false);
    return true;
  });
});

test('scans every persisted text field including source event identity', () => {
  const event = { ...cleanEvent, sourceEventId: `authorization code ${syntheticOtp}` };
  assert.throws(() => validateBankEventInput(event), (error) => error.code === SENSITIVE_AUTH_NOTIFICATION_CODE);
});

test('rejects a short numeric-only mapped text field without treating numeric amounts as codes', () => {
  assert.throws(() => validateBankEventInput({ ...cleanEvent, payload: { title: 'Bank', text: syntheticOtp } }), (error) => error.code === SENSITIVE_AUTH_NOTIFICATION_CODE);
  assert.doesNotThrow(() => validateBankEventInput({ ...cleanEvent, payload: { amount: '10000', currency: 'RUB', direction: 'DEBIT' } }));
});

test('ordinary purchases, transfers, refunds, and operation references remain eligible for normal handling', () => {
  for (const payload of [
    { title: 'Purchase 350 RUB. Sample shop', text: 'Sample shop: 350.00 RUB' },
    { title: 'Transfer 125 RUB', text: 'Operation code 123456' },
    { title: 'Refund 17 RUB', text: 'Returned to account' },
    { title: 'Top up 100 RUB', text: 'Transit card balance updated' },
  ]) {
    assert.doesNotThrow(() => validateBankEventInput({ ...cleanEvent, payload }));
  }
});

test('ingestion rejects sensitive content before making any database call', async () => {
  let databaseCalls = 0;
  const pool = {
    query: async () => { databaseCalls += 1; throw new Error('database must not be touched'); },
    connect: async () => { databaseCalls += 1; throw new Error('database must not be touched'); },
  };
  const event = { ...cleanEvent, payload: { text: `code: ${syntheticOtp}` } };

  await assert.rejects(() => ingestBankEvent(pool, event), (error) => error.code === SENSITIVE_AUTH_NOTIFICATION_CODE);
  assert.deepEqual(await createBankIngestionHandler({ pool })(event), {
    status: 'rejected', code: SENSITIVE_AUTH_NOTIFICATION_CODE,
  });
  assert.equal(databaseCalls, 0);
});

test('HTTP returns a generic permanent rejection and never persists or echoes the sensitive payload', async () => {
  const secret = 'a'.repeat(43);
  const credentialKey = 'synthetic-key';
  const token = createDeviceToken(credentialKey, secret);
  const secretHash = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  const queries = [];
  const logs = [];
  const pool = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('FROM bank_device_credentials')) {
        return { rows: [{ id: 1, secret_hash: secretHash, enabled: true, revoked_at: null, bank_source_id: 1, source_key: cleanEvent.sourceKey, source_enabled: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    connect: async () => { throw new Error('payload persistence must not be reached'); },
  };
  const server = createBankIngestionServer({ pool, logger: { error: (...args) => logs.push(args) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/bank/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...cleanEvent, payload: { text: `Purchase 350 RUB. Confirmation code: ${syntheticOtp}` } }),
    });
    const body = await response.text();
    assert.equal(response.status, 422);
    assert.equal(body, '{"status":"rejected","code":"SENSITIVE_AUTH_NOTIFICATION"}');
    assert.equal(body.includes(syntheticOtp), false);
    assert.equal(queries.some((sql) => /INSERT\s+INTO\s+bank_event_observations/i.test(sql)), false);
    assert.equal(queries.some((sql) => /INSERT\s+INTO\s+bank_transactions/i.test(sql)), false);
    assert.deepEqual(logs, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

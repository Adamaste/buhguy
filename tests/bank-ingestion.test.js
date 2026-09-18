import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankIngestionHandler, normalizeBankEvent, validateBankEventInput } from '../src/bank-ingestion.js';

const event = {
  sourceKey: 'android-bank-test',
  sourceEventId: 'evt-1',
  observedAt: '2026-09-18T10:00:00Z',
  eventTime: '2026-09-18T09:59:00Z',
  payload: { amount: '125.50', currency: 'RUB', direction: 'DEBIT', merchant: 'Synthetic shop' },
  ingestionMetadata: { adapter: 'test', schemaVersion: '1' },
};

test('bank normalization keeps explicit cash-flow facts and does not infer direction', () => {
  const validated = validateBankEventInput(event);
  assert.equal(normalizeBankEvent(validated).normalizationStatus, 'READY');
  assert.equal(normalizeBankEvent(validated).direction, 'DEBIT');
  const partial = normalizeBankEvent({ ...validated, payload: { merchant: 'Synthetic shop' } });
  assert.equal(partial.direction, 'UNKNOWN');
  assert.equal(partial.normalizationStatus, 'PARTIAL');
});

test('bank boundary rejects secret-shaped or unknown fields', () => {
  assert.throws(() => validateBankEventInput({ ...event, payload: { ...event.payload, accessToken: 'not stored' } }), /prohibited secret field/);
  assert.throws(() => validateBankEventInput({ ...event, payload: { ...event.payload, receiptId: 'not matched' } }), /field is not allowed/);
  assert.throws(() => validateBankEventInput({ ...event, payload: { text: 'x'.repeat(16 * 1024) } }), /too long/);
});

test('internal handler rejects an unknown source without receipt matching', async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const result = await createBankIngestionHandler({ pool })(event);
  assert.deepEqual(result, { status: 'rejected', code: 'UNKNOWN_SOURCE' });
});

test('internal handler returns stable rejection for malformed input', async () => {
  const pool = { query: async () => { throw new Error('database must not be touched'); } };
  const handler = createBankIngestionHandler({ pool });
  assert.deepEqual(await handler({ body: { sourceKey: 'bad input' } }), { status: 'rejected', code: 'INVALID_EVENT' });
  assert.deepEqual(await handler(null), { status: 'rejected', code: 'INVALID_EVENT' });
});

test('internal handler still throws unexpected infrastructure errors', async () => {
  const infrastructureError = new Error('database unavailable');
  const pool = { query: async () => { throw infrastructureError; } };
  await assert.rejects(() => createBankIngestionHandler({ pool })(event), infrastructureError);
});

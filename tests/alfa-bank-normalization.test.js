import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBankEvent } from '../src/bank-ingestion.js';

const base = {
  sourceKey: 'android-adam-samsung-s938b',
  sourceEventId: 'synthetic-alfa-normalization-1',
  observedAt: '2026-09-27T17:00:00Z',
  eventTime: '2026-09-27T16:59:00Z',
  ingestionMetadata: { adapter: 'android-notification', provider: 'ru.alfabank.mobile.android', deviceType: 'android', schemaVersion: '1' },
};

function result(payload, overrides = {}) {
  return normalizeBankEvent({ ...base, ...overrides, payload });
}

test('Alfa evidence-derived transfer candidate remains partial without proven cash-flow facts', () => {
  const normalized = result({ title: 'ТЕСТОВЫЙ ПЕРЕВОД', description: 'ТЕСТОВОЕ СООБЩЕНИЕ' });
  assert.equal(normalized.eventType, 'UNKNOWN');
  assert.equal(normalized.direction, 'UNKNOWN');
  assert.equal(normalized.amount, null);
  assert.equal(normalized.currency, null);
  assert.equal(normalized.normalizationStatus, 'PARTIAL');
  assert.equal(normalized.normalizationVersion, 'alfa-bank-normalizer-v1');
});

test('Alfa parser preserves event time while refusing unsupported amount grammar', () => {
  const normalized = result({ title: 'ТЕСТОВЫЙ ПЕРЕВОД', description: '1234,50 RUB' });
  assert.equal(normalized.occurredAt, '2026-09-27T16:59:00.000Z');
  assert.equal(normalized.amount, null);
  assert.equal(normalized.currency, null);
  assert.notEqual(normalized.normalizationStatus, 'READY');
});

test('Alfa parser fails closed for missing, malformed, or unsupported evidence', () => {
  for (const payload of [
    {},
    { title: 'ТЕСТОВАЯ ПОКУПКА' },
    { description: 'ТЕСТОВОЕ СООБЩЕНИЕ 12.34 USD' },
    { description: 'ТЕСТОВОЕ СООБЩЕНИЕ 1 234.50 RUB' },
    { description: 'ТЕСТОВОЕ СООБЩЕНИЕ 12,34 RUB' },
  ]) {
    const normalized = result(payload);
    assert.equal(normalized.eventType, 'UNKNOWN');
    assert.equal(normalized.direction, 'UNKNOWN');
    assert.notEqual(normalized.normalizationStatus, 'READY');
  }
});

test('Alfa provider parser is selected only for Alfa metadata', () => {
  const alfa = result({ title: 'ТЕСТОВАЯ ПОКУПКА', description: 'ТЕСТОВОЕ СООБЩЕНИЕ' });
  const other = result({ title: 'ТЕСТОВАЯ ПОКУПКА', description: 'ТЕСТОВОЕ СООБЩЕНИЕ' }, {
    ingestionMetadata: { ...base.ingestionMetadata, provider: 'other.bank' },
  });
  assert.equal(alfa.normalizationVersion, 'alfa-bank-normalizer-v1');
  assert.equal(other.normalizationVersion, 'bank-normalizer-v1');
});

test('Alfa parser does not infer merchant, counterparty, account, or direction', () => {
  const normalized = result({ title: 'ТЕСТОВАЯ ОПЕРАЦИЯ', description: 'ТЕСТОВЫЙ МАГАЗИН *0000' });
  assert.equal(normalized.merchant, null);
  assert.equal(normalized.counterparty, null);
  assert.equal(normalized.accountReference, null);
  assert.equal(normalized.direction, 'UNKNOWN');
});

test('Yandex dispatch remains unchanged beside Alfa provider dispatch', () => {
  const yandex = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, provider: 'com.yandex.bank' }, payload: {
    title: 'Покупка', description: 'Покупка на 12.00 RUB ТЕСТОВЫЙ МАГАЗИН',
  }});
  assert.equal(yandex.eventType, 'PURCHASE');
  assert.equal(yandex.direction, 'DEBIT');
  assert.equal(yandex.normalizationVersion, 'yandex-bank-normalizer-v1');
});

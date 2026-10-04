import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBankEvent } from '../src/bank-ingestion.js';

const base = {
  sourceKey: 'android-adam-samsung-s938b',
  observedAt: '2026-10-01T12:00:00Z',
  eventTime: '2026-10-01T11:59:00Z',
  ingestionMetadata: {
    provider: 'com.idamob.tinkoff.android',
    adapter: 'android-notification',
    schemaVersion: '1',
  },
};

const topUpBody = (amount = '2468', balance = '9 753,21', middle = 'ТЕСТОВЫЙ ОТПРАВИТЕЛЬ') =>
  `Пополнение на ${amount} ₽, счет RUB. ${middle} Доступно ${balance} ₽`;

function normalize(payload, overrides = {}) {
  return normalizeBankEvent({ ...base, ...overrides, payload });
}

test('T-Bank v2 top-up promotes the exact proven envelope with CREDIT only', () => {
  for (const payload of [
    { description: topUpBody() },
    { title: 'ТЕСТОВЫЙ-БАНК', description: topUpBody() },
  ]) {
    const result = normalize(payload);
    assert.equal(result.normalizationVersion, 'tbank-bank-normalizer-v2');
    assert.equal(result.amount, '2468.00');
    assert.equal(result.currency, 'RUB');
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'CREDIT');
    assert.equal(result.normalizationStatus, 'READY');
    assert.equal(result.evidenceQuality, 'EXACT');
    assert.equal(result.occurredAt, '2026-10-01T11:59:00.000Z');
    assert.equal(result.accountReference, null);
    assert.equal(result.accountReferenceKind, null);
    assert.equal(result.merchant, null);
    assert.equal(result.counterparty, null);
  }
});

test('T-Bank top-up extracts only the integer transaction amount, never the balance', () => {
  const result = normalize({ description: topUpBody('1357', '8 642,10') });
  assert.equal(result.amount, '1357.00');
  assert.equal(result.currency, 'RUB');
  assert.equal(result.eventType, 'UNKNOWN');
  assert.equal(result.direction, 'CREDIT');
  assert.equal(result.normalizationStatus, 'READY');
  assert.equal(result.evidenceQuality, 'EXACT');
});

test('T-Bank top-up prefers description and falls back from whitespace-only description to text', () => {
  const preferred = normalize({ description: 'not a proven T-Bank top-up', text: topUpBody() });
  assert.equal(preferred.amount, null);
  assert.equal(preferred.normalizationStatus, 'PARTIAL');
  assert.equal(preferred.direction, 'UNKNOWN');

  const fallback = normalize({ description: ' \n\t ', text: topUpBody() });
  assert.equal(fallback.amount, '2468.00');
  assert.equal(fallback.currency, 'RUB');
});

test('T-Bank top-up rejects malformed or unproven near-miss bodies', () => {
  const cases = [
    topUpBody('2 468'),
    topUpBody('2468,00'),
    topUpBody('2468', '9753.21'),
    topUpBody().replace('счет RUB.', 'счёт RUB.'),
    topUpBody().replace('Доступно', 'Баланс'),
    `ЛИШНИЙ ТЕКСТ ${topUpBody()}`,
    `${topUpBody()} ЛИШНИЙ ТЕКСТ`,
  ];
  for (const description of cases) {
    const result = normalize({ description });
    assert.equal(result.amount, null);
    assert.equal(result.currency, null);
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
    assert.notEqual(result.normalizationStatus, 'READY');
    assert.notEqual(result.evidenceQuality, 'EXACT');
  }
});

test('T-Bank top-up rejects missing amount, unsupported currency, and missing event time', () => {
  const missingAmount = normalize({ description: topUpBody().replace('2468 ₽', ' ₽') });
  assert.equal(missingAmount.amount, null);
  assert.equal(missingAmount.direction, 'UNKNOWN');

  const unsupportedCurrency = normalize({ description: topUpBody().replaceAll('RUB', 'USD') });
  assert.equal(unsupportedCurrency.amount, null);
  assert.equal(unsupportedCurrency.currency, null);
  assert.equal(unsupportedCurrency.direction, 'UNKNOWN');

  const missingEventTime = normalize({ description: topUpBody() }, { eventTime: null });
  assert.equal(missingEventTime.amount, null);
  assert.equal(missingEventTime.normalizationStatus, 'PARTIAL');
  assert.equal(missingEventTime.direction, 'UNKNOWN');
});

test('T-Bank top-up dispatch is isolated by provider, adapter, and schema version', () => {
  for (const ingestionMetadata of [
    { ...base.ingestionMetadata, provider: 'other.bank' },
    { ...base.ingestionMetadata, adapter: 'BANK_API' },
    { ...base.ingestionMetadata, schemaVersion: '2' },
    { provider: 'com.idamob.tinkoff.android', adapter: 'android-notification' },
  ]) {
    const result = normalize({ description: topUpBody() }, { ingestionMetadata });
    assert.equal(result.amount, null);
    assert.equal(result.currency, null);
    assert.equal(result.normalizationVersion, 'bank-normalizer-v1');
  }
});

test('T-Bank empty companion and informational families remain fail-closed', () => {
  const empty = normalize({});
  assert.equal(empty.amount, null);
  assert.equal(empty.currency, null);
  assert.equal(empty.eventType, 'UNKNOWN');
  assert.equal(empty.direction, 'UNKNOWN');

  const informational = normalize({ title: 'ТЕСТОВЫЙ — ИНФО', description: 'ТЕСТОВЫЕ УСЛОВИЯ 5%' });
  assert.equal(informational.amount, null);
  assert.equal(informational.currency, null);
  assert.equal(informational.eventType, 'UNKNOWN');
  assert.equal(informational.direction, 'UNKNOWN');
  assert.notEqual(informational.normalizationStatus, 'READY');
});

test('T-Bank top-up normalization does not mutate raw payload', () => {
  const payload = { description: topUpBody(), text: topUpBody() };
  const before = JSON.stringify(payload);
  normalize(payload);
  assert.equal(JSON.stringify(payload), before);
});

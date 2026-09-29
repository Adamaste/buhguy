import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBankEvent } from '../src/bank-ingestion.js';

const base = {
  sourceKey: 'android-adam-samsung-s938b',
  sourceEventId: 'synthetic-sber-normalization-1',
  observedAt: '2026-09-29T08:00:00Z',
  eventTime: '2026-09-29T07:59:00Z',
  ingestionMetadata: { adapter: 'android-notification', provider: 'ru.sberbankmobile', deviceType: 'android', schemaVersion: '1' },
};

const incoming = (overrides = {}) => ({
  title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ',
  description: '+ 123 ₽ — Теперь у вас: 6 789,01 ₽ Плат. счёт •• 0000',
  text: '+ 123 ₽ — Теперь у вас: 6 789,01 ₽ Плат. счёт •• 0000',
  ...overrides,
});

test('Sber controlled incoming format is normalized exactly', () => {
  const result = normalizeBankEvent({ ...base, payload: incoming() });
  assert.deepEqual(result, {
    eventType: 'INCOMING_TRANSFER',
    occurredAt: '2026-09-29T07:59:00.000Z',
    amount: '123.00',
    currency: 'RUB',
    direction: 'CREDIT',
    merchant: null,
    counterparty: null,
    accountReference: '0000',
    accountReferenceKind: 'MASKED_ACCOUNT',
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: 'sber-bank-normalizer-v1',
  });
});

test('Sber accepts only the two proven controlled title structures', () => {
  for (const title of [
    '💳 Он пришёл! Перевод от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ',
    '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ',
  ]) {
    const result = normalizeBankEvent({ ...base, payload: incoming({ title }) });
    assert.equal(result.normalizationStatus, 'READY');
    assert.equal(result.eventType, 'INCOMING_TRANSFER');
  }
});

test('Sber parser uses description before text and normalizes supported whitespace', () => {
  const result = normalizeBankEvent({ ...base, payload: incoming({
    description: '  ⭐ Баланс\nувеличился благодаря переводу  ',
    text: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000',
  }) });
  assert.equal(result.normalizationStatus, 'PARTIAL');

  const fallback = normalizeBankEvent({ ...base, payload: incoming({
    description: ' \n\t ',
    text: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000',
  }) });
  assert.equal(fallback.normalizationStatus, 'READY');
  assert.equal(fallback.amount, '12.00');
});

test('Sber parser fails closed for missing or malformed evidence', () => {
  const cases = [
    { title: 'ТЕСТ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { title: 'Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { title: '⭐ Баланс увеличился благодаря переводу ТЕСТ', description: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ ТЕСТ1', description: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { title: 'Новости', description: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: 'Перевод: 12 ₽' },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '+ 12,34 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '+ 12.34 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '+ 12 ₽ — ТЕСТ: 56,78 ₽' },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '+ 12 USD — Теперь у вас: 56,78 USD' },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000', eventTime: null },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '6 789,01 ₽' },
  ];
  for (const payload of cases) {
    const result = normalizeBankEvent({ ...base, eventTime: payload.eventTime === undefined ? base.eventTime : payload.eventTime, payload });
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
    assert.notEqual(result.normalizationStatus, 'READY');
    assert.equal(result.amount, null);
  }
});

test('Sber parser keeps the second monetary field out of the transaction amount', () => {
  const result = normalizeBankEvent({ ...base, payload: incoming() });
  assert.equal(result.amount, '123.00');
  assert.equal(result.currency, 'RUB');
  assert.equal(result.eventType, 'INCOMING_TRANSFER');
});

test('Sber summary/reference-only and similar unsupported wording stay fail closed', () => {
  for (const payload of [
    { title: 'Перевод', description: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { reference: 'ТЕСТОВАЯ ССЫЛКА' },
    { title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: '+ 12 ₽' },
  ]) {
    const result = normalizeBankEvent({ ...base, payload });
    assert.notEqual(result.normalizationStatus, 'READY');
  }
});

test('Sber parser is provider and adapter scoped; generic normalization remains available', () => {
  const otherProvider = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, provider: 'other.bank' }, payload: incoming() });
  assert.equal(otherProvider.eventType, 'UNKNOWN');
  assert.notEqual(otherProvider.normalizationStatus, 'READY');

  const nonAndroid = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, adapter: 'BANK_API' }, payload: {
    amount: '12.34', currency: 'RUB', direction: 'CREDIT', description: 'synthetic structured event',
  } });
  assert.equal(nonAndroid.eventType, 'UNKNOWN');
  assert.equal(nonAndroid.amount, '12.34');
  assert.equal(nonAndroid.direction, 'CREDIT');
  assert.equal(nonAndroid.normalizationStatus, 'READY');
});

test('Sber parser requires schemaVersion 1 and other versions use generic normalization', () => {
  for (const schemaVersion of ['2', undefined]) {
    const ingestionMetadata = { ...base.ingestionMetadata };
    if (schemaVersion === undefined) delete ingestionMetadata.schemaVersion;
    else ingestionMetadata.schemaVersion = schemaVersion;
    const result = normalizeBankEvent({
      ...base,
      ingestionMetadata,
      payload: { amount: '12.34', currency: 'RUB', direction: 'CREDIT', ...incoming() },
    });
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.amount, '12.34');
    assert.equal(result.direction, 'CREDIT');
    assert.equal(result.normalizationStatus, 'READY');
    assert.equal(result.normalizationVersion, 'bank-normalizer-v1');
  }
});

test('Sber normalization uses envelope eventTime and does not mutate raw observation payload', () => {
  const payload = incoming();
  const before = JSON.stringify(payload);
  const result = normalizeBankEvent({ ...base, payload });
  assert.equal(result.occurredAt, '2026-09-29T07:59:00.000Z');
  assert.equal(JSON.stringify(payload), before);
});

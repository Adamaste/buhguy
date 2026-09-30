import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBankEvent } from '../src/bank-ingestion.js';

const base = {
  sourceKey: 'android-adam-samsung-s938b',
  sourceEventId: 'synthetic-sber-normalization-v3',
  observedAt: '2026-09-30T08:00:00Z',
  eventTime: '2026-09-30T07:59:00Z',
  ingestionMetadata: { adapter: 'android-notification', provider: 'ru.sberbankmobile', deviceType: 'android', schemaVersion: '1' },
};

const currentIncoming = (overrides = {}) => ({
  title: 'Перевод по СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ.',
  description: '+ 123 ₽ — Баланс: 6 789,01 ₽ Плат. счёт •• 0000',
  text: '+ 123 ₽ — Баланс: 6 789,01 ₽ Плат. счёт •• 0000',
  ...overrides,
});

const oldIncoming = (overrides = {}) => ({
  title: '⭐ Баланс увеличился благодаря переводу от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ',
  description: '+ 123 ₽ — Теперь у вас: 6 789,01 ₽ Плат. счёт •• 0000',
  text: '+ 123 ₽ — Теперь у вас: 6 789,01 ₽ Плат. счёт •• 0000',
  ...overrides,
});

test('Sber v3 accepts the two controlled current samples structure', () => {
  for (const payload of [
    currentIncoming({ description: '+ 123 ₽ — Баланс: 6 789,01 ₽ Плат. счёт •• 0000' }),
    currentIncoming({ description: '+ 456 ₽ — Баланс: 7 890,12 ₽ Плат. счёт •• 0000' }),
  ]) {
    const result = normalizeBankEvent({ ...base, payload });
    assert.equal(result.normalizationStatus, 'READY');
    assert.equal(result.eventType, 'INCOMING_TRANSFER');
    assert.equal(result.direction, 'CREDIT');
    assert.equal(result.amount, payload.description.includes('456') ? '456.00' : '123.00');
    assert.equal(result.currency, 'RUB');
    assert.equal(result.accountReference, '0000');
    assert.equal(result.accountReferenceKind, 'MASKED_ACCOUNT');
    assert.equal(result.evidenceQuality, 'EXACT');
    assert.equal(result.normalizationVersion, 'sber-bank-normalizer-v3');
  }
});

test('Sber v3 accepts whitespace normalization without widening the envelope', () => {
  const result = normalizeBankEvent({ ...base, payload: currentIncoming({
    title: '  Перевод\nпо СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ.  ',
    description: '+ 12 ₽ — Баланс: 56,78 ₽ Плат. счёт •• 0000',
  }) });
  assert.equal(result.normalizationStatus, 'READY');
  assert.equal(result.amount, '12.00');
});

test('Sber v3 prefers description and falls back to text', () => {
  const descriptionPreferred = normalizeBankEvent({ ...base, payload: currentIncoming({
    description: 'not a current Sber envelope',
    text: '+ 12 ₽ — Баланс: 56,78 ₽ Плат. счёт •• 0000',
  }) });
  assert.notEqual(descriptionPreferred.normalizationStatus, 'READY');

  const fallback = normalizeBankEvent({ ...base, payload: currentIncoming({
    description: ' \n\t ',
    text: '+ 12 ₽ — Баланс: 56,78 ₽ Плат. счёт •• 0000',
  }) });
  assert.equal(fallback.normalizationStatus, 'READY');
  assert.equal(fallback.amount, '12.00');
});

test('Sber v3 rejects old v1 and v2 runtime envelopes', () => {
  for (const payload of [
    oldIncoming(),
    oldIncoming({ title: '💳 Он пришёл! Перевод от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ' }),
    oldIncoming({ title: '✅ Поступление от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ' }),
  ]) {
    const result = normalizeBankEvent({ ...base, payload });
    assert.notEqual(result.normalizationStatus, 'READY');
    assert.equal(result.eventType, 'UNKNOWN');
  }
});

test('Sber v3 rejects title and body near misses fail closed', () => {
  const cases = [
    { title: 'ТЕСТ Перевод по СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ.', description: currentIncoming().description },
    { title: 'Перевод по СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ. ТЕСТ', description: currentIncoming().description },
    { title: 'Перевод по СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ', description: currentIncoming().description },
    { title: 'Перевод по СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ!', description: currentIncoming().description },
    { title: 'Перевод по СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ. ЛИШНИЙ ТЕКСТ.', description: currentIncoming().description },
    { title: currentIncoming().title, description: '+ 12,34 ₽ — Баланс: 56,78 ₽ Плат. счёт •• 0000' },
    { title: currentIncoming().title, description: '+ 12 ₽ — Баланс: 56.78 ₽ Плат. счёт •• 0000' },
    { title: currentIncoming().title, description: '+ 12 ₽ — Баланс: 56,78 RUB Плат. счёт •• 0000' },
    { title: currentIncoming().title, description: '+ 12 ₽ — Теперь у вас: 56,78 ₽ Плат. счёт •• 0000' },
    { title: currentIncoming().title, description: '+ 12 ₽ — Баланс: 56,78 ₽' },
    { title: currentIncoming().title, description: '+ 12 ₽ — Баланс: 56,78 ₽ Плат. счёт •• 000' },
    { title: currentIncoming().title, description: '+ 12 ₽ — Баланс: 56,78 ₽ Плат. счёт •• 0000 ЛИШНИЙ ТЕКСТ' },
    { title: currentIncoming().title, description: 'Перевод: 12 ₽' },
    { title: currentIncoming().title, description: '+ 12 USD — Баланс: 56,78 USD Плат. счёт •• 0000' },
    { reference: 'ТЕСТОВАЯ ССЫЛКА' },
  ];
  for (const payload of cases) {
    const result = normalizeBankEvent({ ...base, payload });
    assert.notEqual(result.normalizationStatus, 'READY');
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
  }
  const missingEventTime = normalizeBankEvent({ ...base, eventTime: null, payload: currentIncoming() });
  assert.notEqual(missingEventTime.normalizationStatus, 'READY');
});

test('Sber v3 keeps the second monetary field out of the transaction amount', () => {
  const result = normalizeBankEvent({ ...base, payload: currentIncoming() });
  assert.equal(result.amount, '123.00');
  assert.equal(result.currency, 'RUB');
});

test('Sber v3 is provider, adapter, and schema scoped', () => {
  const otherProvider = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, provider: 'other.bank' }, payload: currentIncoming() });
  assert.notEqual(otherProvider.normalizationStatus, 'READY');

  const nonAndroid = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, adapter: 'BANK_API' }, payload: {
    amount: '12.34', currency: 'RUB', direction: 'CREDIT', description: 'synthetic structured event',
  } });
  assert.equal(nonAndroid.normalizationStatus, 'READY');
  assert.equal(nonAndroid.amount, '12.34');

  for (const schemaVersion of ['2', undefined]) {
    const ingestionMetadata = { ...base.ingestionMetadata };
    if (schemaVersion === undefined) delete ingestionMetadata.schemaVersion;
    else ingestionMetadata.schemaVersion = schemaVersion;
    const result = normalizeBankEvent({ ...base, ingestionMetadata, payload: { amount: '12.34', currency: 'RUB', direction: 'CREDIT', ...currentIncoming() } });
    assert.equal(result.normalizationStatus, 'READY');
    assert.equal(result.normalizationVersion, 'bank-normalizer-v1');
    assert.equal(result.amount, '12.34');
  }
});

test('Sber v3 uses envelope eventTime and does not mutate raw payload', () => {
  const payload = currentIncoming();
  const before = JSON.stringify(payload);
  const result = normalizeBankEvent({ ...base, payload });
  assert.equal(result.occurredAt, '2026-09-30T07:59:00.000Z');
  assert.equal(JSON.stringify(payload), before);
});

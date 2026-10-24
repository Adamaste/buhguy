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

const currentOutgoing = (overrides = {}) => ({
  title: 'ТЕСТОВЫЙ СЕРВИС‑ПЕРЕВОД',
  description: '2 468 ₽ — Баланс: 9 876,54 ₽ Плат. счёт •• 0271',
  text: '2 468 ₽ — Баланс: 9 876,54 ₽ Плат. счёт •• 0271',
  ...overrides,
});

const purchasePayload = ({ amount = '2468', balance = '123,45', suffix = '1357', merchant = 'СИНТЕТИЧЕСКИЙ МЕРЧАНТ', ...overrides } = {}) => {
  const body = `${amount} ₽ — Баланс: ${balance} ₽ Счёт карты МИР •• ${suffix}`;
  return {
    title: `Покупка ${merchant}`,
    description: body,
    text: body,
    ...overrides,
  };
};

test('Sber v6 preserves the exact controlled incoming structure', () => {
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
    assert.equal(result.normalizationVersion, 'sber-bank-normalizer-v7');
  }
});

test('Sber v6 accepts whitespace normalization without widening the envelope', () => {
  const result = normalizeBankEvent({ ...base, payload: currentIncoming({
    title: '  Перевод\nпо СБП от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ.  ',
    description: '+ 12 ₽ — Баланс: 56,78 ₽ Плат. счёт •• 0000',
  }) });
  assert.equal(result.normalizationStatus, 'READY');
  assert.equal(result.amount, '12.00');
});

test('Sber v6 preserves description precedence and text fallback for incoming', () => {
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

test('Sber v6 rejects old v1 and v2 runtime envelopes', () => {
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

test('Sber v6 rejects incoming title and body near misses fail closed', () => {
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

test('Sber v6 keeps the incoming second monetary field out of the transaction amount', () => {
  const result = normalizeBankEvent({ ...base, payload: currentIncoming() });
  assert.equal(result.amount, '123.00');
  assert.equal(result.currency, 'RUB');
});

test('Sber v6 preserves provider, adapter, and schema scope', () => {
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

test('Sber v6 uses envelope eventTime and does not mutate raw payload', () => {
  const payload = currentIncoming();
  const before = JSON.stringify(payload);
  const result = normalizeBankEvent({ ...base, payload });
  assert.equal(result.occurredAt, '2026-09-30T07:59:00.000Z');
  assert.equal(JSON.stringify(payload), before);
});

test('Sber v6 outgoing extraction does not cross provider, adapter, or schema scope', () => {
  const cases = [
    { provider: 'other.bank' },
    { adapter: 'BANK_API' },
    { schemaVersion: '2' },
    { schemaVersion: undefined },
  ];
  for (const overrides of cases) {
    const ingestionMetadata = { ...base.ingestionMetadata, ...overrides };
    if (overrides.schemaVersion === undefined) delete ingestionMetadata.schemaVersion;
    const result = normalizeBankEvent({ ...base, ingestionMetadata, payload: currentOutgoing() });
    assert.equal(result.amount, null);
    assert.equal(result.accountReference, null);
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
  }
});

test('Sber v6 promotes only the exact proven outgoing evidence', () => {
  const result = normalizeBankEvent({ ...base, payload: currentOutgoing() });
  assert.equal(result.normalizationStatus, 'READY');
  assert.equal(result.evidenceQuality, 'EXACT');
  assert.equal(result.eventType, 'OUTGOING_TRANSFER');
  assert.equal(result.direction, 'DEBIT');
  assert.equal(result.amount, '2468.00');
  assert.equal(result.currency, 'RUB');
  assert.equal(result.accountReference, '0271');
  assert.equal(result.accountReferenceKind, 'MASKED_ACCOUNT');
  assert.equal(result.normalizationVersion, 'sber-bank-normalizer-v7');
  assert.equal(result.merchant, null);
  assert.equal(result.counterparty, null);
});

test('Sber v6 outgoing preserves description precedence and whitespace-only text fallback', () => {
  const descriptionPreferred = normalizeBankEvent({ ...base, payload: currentOutgoing({
    description: 'not an outgoing Sber envelope',
  }) });
  assert.equal(descriptionPreferred.amount, null);
  assert.equal(descriptionPreferred.accountReference, null);
  assert.equal(descriptionPreferred.normalizationStatus, 'PARTIAL');

  const fallback = normalizeBankEvent({ ...base, payload: currentOutgoing({
    description: ' \n\t ',
  }) });
  assert.equal(fallback.amount, '2468.00');
  assert.equal(fallback.accountReference, '0271');
  assert.equal(fallback.normalizationStatus, 'READY');
});

test('Sber v6 rejects outgoing near misses without partial extraction', () => {
  const cases = [
    { title: 'Другая форма', description: currentOutgoing().description },
    { title: 'ТЕСТОВЫЙ СЕРВИС-ПЕРЕВОД', description: currentOutgoing().description },
    { title: currentOutgoing().title, description: '2 468 ₽ Баланс: 9 876,54 ₽ Плат. счёт •• 0271' },
    { title: currentOutgoing().title, description: '2468,00 ₽ — Баланс: 9 876,54 ₽ Плат. счёт •• 0271' },
    { title: currentOutgoing().title, description: '2 468 ₽ — Баланс: 9 876.54 ₽ Плат. счёт •• 0271' },
    { title: currentOutgoing().title, description: '2 468 ₽ — Баланс: 9 876,54 RUB Плат. счёт •• 0271' },
    { title: currentOutgoing().title, description: '2 468 ₽ — Баланс: 9 876,54 ₽ Счёт •• 0271' },
    { title: currentOutgoing().title, description: '2 468 ₽ — Баланс: 9 876,54 ₽ Плат. счёт •• 027' },
    { title: currentOutgoing().title, description: `${currentOutgoing().description} ЛИШНИЙ ТЕКСТ` },
    { title: currentOutgoing().title, description: currentOutgoing().description, eventTime: null },
    { title: currentOutgoing().title, description: 'reference-only' },
  ];
  for (const testCase of cases) {
    const { eventTime = base.eventTime, ...payload } = testCase;
    const result = normalizeBankEvent({ ...base, eventTime, payload });
    assert.notEqual(result.normalizationStatus, 'READY');
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
    assert.equal(result.amount, null);
    assert.equal(result.accountReference, null);
  }
});

test('Sber v6 accepts only the proven purchase family across independent synthetic samples', () => {
  for (const payload of [
    purchasePayload({ amount: '2468', balance: '123,45', suffix: '1357' }),
    purchasePayload({ amount: '3579', balance: '234,56', suffix: '2468' }),
    purchasePayload({ amount: '4680', balance: '345,67', suffix: '9753' }),
  ]) {
    const result = normalizeBankEvent({ ...base, payload });
    assert.equal(result.normalizationStatus, 'READY');
    assert.equal(result.evidenceQuality, 'EXACT');
    assert.equal(result.eventType, 'PURCHASE');
    assert.equal(result.direction, 'DEBIT');
    assert.equal(result.amount, `${payload.description.match(/^(\d+)/u)[1]}.00`);
    assert.equal(result.currency, 'RUB');
    assert.equal(result.accountReference, payload.description.match(/(\d{4})$/u)[1]);
    assert.equal(result.accountReferenceKind, null);
    assert.equal(result.merchant, 'СИНТЕТИЧЕСКИЙ МЕРЧАНТ');
    assert.equal(result.normalizationVersion, 'sber-bank-normalizer-v7');
  }
});

test('Sber v6 rejects purchase near misses and never falls through to v5 extraction', () => {
  const valid = purchasePayload();
  const cases = [
    { ...valid, title: 'Недостаточно средств. Покупка СИНТЕТИЧЕСКИЙ МЕРЧАНТ' },
    { ...valid, title: 'Перевод по СБП от СИНТЕТИЧЕСКИЙ ОТПРАВИТЕЛЬ.' },
    { ...valid, description: '2468 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 1357', text: '3579 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 1357' },
    { ...valid, description: '2468 ₽ Баланс: 123,45 ₽ Счёт карты МИР •• 1357' },
    { ...valid, description: '2468 ₽ — Баланс: 123.45 ₽ Счёт карты МИР •• 1357', text: '2468 ₽ — Баланс: 123.45 ₽ Счёт карты МИР •• 1357' },
    { ...valid, description: '2 468 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 1357', text: '2 468 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 1357' },
    { ...valid, description: '2468 ₽ — Баланс: 123,45 RUB Счёт карты МИР •• 1357', text: '2468 ₽ — Баланс: 123,45 RUB Счёт карты МИР •• 1357' },
    { ...valid, description: '2468 ₽ — Счёт карты МИР •• 1357 Баланс: 123,45 ₽', text: '2468 ₽ — Счёт карты МИР •• 1357 Баланс: 123,45 ₽' },
    { ...valid, description: '2468 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 135', text: '2468 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 135' },
    { ...valid, description: '2468 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 1357 ЛИШНИЙ ТЕКСТ', text: '2468 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 1357 ЛИШНИЙ ТЕКСТ' },
    { ...valid, description: ' ', text: valid.text },
  ];
  for (const payload of cases) {
    const result = normalizeBankEvent({ ...base, payload });
    assert.notEqual(result.normalizationStatus, 'READY');
    assert.equal(result.amount, null);
    assert.equal(result.accountReference, null);
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
  }
  const missingEventTime = normalizeBankEvent({ ...base, eventTime: null, payload: valid });
  assert.notEqual(missingEventTime.normalizationStatus, 'READY');
});

test('Sber v6 is provider, adapter, and schema scoped for purchase extraction', () => {
  for (const overrides of [
    { provider: 'other.bank' },
    { adapter: 'BANK_API' },
    { schemaVersion: '2' },
    { schemaVersion: undefined },
  ]) {
    const ingestionMetadata = { ...base.ingestionMetadata, ...overrides };
    if (overrides.schemaVersion === undefined) delete ingestionMetadata.schemaVersion;
    const result = normalizeBankEvent({ ...base, ingestionMetadata, payload: purchasePayload() });
    assert.notEqual(result.normalizationVersion, 'sber-bank-normalizer-v7');
    assert.equal(result.amount, null);
    assert.equal(result.accountReference, null);
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
  }
});

test('Sber v6 preserves Android eventTime and raw payload immutability', () => {
  const payload = purchasePayload();
  const before = JSON.stringify(payload);
  const result = normalizeBankEvent({ ...base, payload });
  assert.equal(result.occurredAt, '2026-09-30T07:59:00.000Z');
  assert.equal(JSON.stringify(payload), before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBankEvent } from '../src/bank-ingestion.js';

const base = {
  sourceKey: 'android-adam-samsung-s938b',
  sourceEventId: 'synthetic-yandex-normalization-1',
  observedAt: '2026-09-27T17:00:00Z',
  eventTime: '2026-09-27T16:59:00Z',
  ingestionMetadata: { adapter: 'android-notification', provider: 'com.yandex.bank', deviceType: 'android', schemaVersion: '1' },
};

test('Yandex purchase is normalized from exact title and description markers', () => {
  const result = normalizeBankEvent({ ...base, payload: {
    title: 'Покупка',
    text: 'Покупка на 999.90 RUB',
    description: '  Покупка на 1234.50 RUB   ТЕСТОВЫЙ МАГАЗИН  ',
  }});
  assert.deepEqual(result, {
    eventType: 'PURCHASE',
    occurredAt: '2026-09-27T16:59:00.000Z',
    amount: '1234.50',
    currency: 'RUB',
    direction: 'DEBIT',
    merchant: null,
    counterparty: null,
    accountReference: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: 'yandex-bank-normalizer-v1',
  });
});

test('Yandex purchase accepts plain four-digit amounts without grouping', () => {
  const result = normalizeBankEvent({ ...base, payload: { description: 'Покупка на 1234.50 RUB ТЕСТОВЫЙ МАГАЗИН' } });
  assert.equal(result.eventType, 'PURCHASE');
  assert.equal(result.amount, '1234.50');
  assert.equal(result.normalizationStatus, 'READY');
});

test('Yandex purchase normalizes whitespace and falls back from blank description to text', () => {
  const result = normalizeBankEvent({ ...base, payload: {
    description: ' \n\t ',
    text: 'Покупка\nна\t12.34   RUB ТЕСТОВЫЙ МАГАЗИН',
  }});
  assert.equal(result.eventType, 'PURCHASE');
  assert.equal(result.amount, '12.34');
  assert.equal(result.normalizationStatus, 'READY');
});

test('Yandex incoming transfer is normalized from exact title and body markers', () => {
  const result = normalizeBankEvent({ ...base, payload: {
    title: 'Входящий перевод',
    description: 'Пополнение на 100.00 RUB от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ',
  }});
  assert.equal(result.eventType, 'INCOMING_TRANSFER');
  assert.equal(result.direction, 'CREDIT');
  assert.equal(result.amount, '100.00');
  assert.equal(result.currency, 'RUB');
  assert.equal(result.normalizationStatus, 'READY');
});

test('Yandex incoming transfer accepts text fallback when description is absent', () => {
  const result = normalizeBankEvent({ ...base, payload: {
    title: 'Входящий перевод',
    text: 'Пополнение\nна 100.00 RUB от ТЕСТОВЫЙ ОТПРАВИТЕЛЬ',
  }});
  assert.equal(result.eventType, 'INCOMING_TRANSFER');
  assert.equal(result.direction, 'CREDIT');
  assert.equal(result.amount, '100.00');
});

test('Yandex incoming transfer requires both title and body markers', () => {
  const missingTitle = normalizeBankEvent({ ...base, payload: { description: 'Пополнение на 100.00 RUB' } });
  const missingBody = normalizeBankEvent({ ...base, payload: { title: 'Входящий перевод' } });
  assert.notEqual(missingTitle.normalizationStatus, 'READY');
  assert.notEqual(missingBody.normalizationStatus, 'READY');
  assert.equal(missingTitle.eventType, 'UNKNOWN');
  assert.equal(missingBody.eventType, 'UNKNOWN');
});

test('Yandex parser fails closed for missing, malformed, or unsupported evidence', () => {
  const cases = [
    { title: 'Покупка', description: 'Покупка на 12 RUB ТЕСТОВЫЙ МАГАЗИН' },
    { title: 'Покупка', description: 'Покупка на 12.345 RUB ТЕСТОВЫЙ МАГАЗИН' },
    { title: 'Покупка', description: 'Покупка на 12.00 USD ТЕСТОВЫЙ МАГАЗИН' },
    { title: 'Входящий перевод', description: 'Пополнение на RUB' },
    { title: 'Покупка', description: 'Оплата на 12.00 RUB' },
    { title: 'Перевод', description: 'Перевод на 12.00 RUB' },
    { title: 'Покупка', description: 'Покупка на 12,00 RUB' },
    { title: 'Покупка', description: 'Покупка на 12.00 ₽' },
    { title: 'Покупка', description: 'Покупка на 1 234.50 RUB' },
    { title: 'Покупка', description: 'Покупка на 1\u00a0234.50 RUB' },
  ];
  for (const payload of cases) {
    const result = normalizeBankEvent({ ...base, payload });
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
    assert.notEqual(result.normalizationStatus, 'READY');
  }
});

test('Yandex parser does not accept alternate money grammars', () => {
  for (const description of [
    'Покупка на 1,234.50 RUB',
    'Покупка на 12,50 RUB',
    'Покупка на 12.50 USD',
  ]) {
    const result = normalizeBankEvent({ ...base, payload: { description } });
    assert.notEqual(result.normalizationStatus, 'READY');
    assert.equal(result.eventType, 'UNKNOWN');
  }
});

test('Yandex dispatch is provider-scoped and generic normalization remains unchanged', () => {
  const yandex = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, provider: 'com.yandex.bank' }, payload: {
    title: 'Покупка', description: 'Покупка на 12.00 RUB ТЕСТОВЫЙ МАГАЗИН', direction: 'CREDIT',
  }});
  assert.equal(yandex.eventType, 'PURCHASE');
  assert.equal(yandex.direction, 'DEBIT');

  const generic = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, provider: 'other.bank' }, payload: {
    amount: '12.00', currency: 'RUB', direction: 'CREDIT', merchant: 'Synthetic shop',
  }});
  assert.equal(generic.eventType, 'UNKNOWN');
  assert.equal(generic.direction, 'CREDIT');
  assert.equal(generic.amount, '12.00');
});

test('unrelated Yandex text and another provider never become a ready financial event', () => {
  const unrelated = normalizeBankEvent({ ...base, payload: { title: 'Новости', description: 'Пополнение на 12.00 RUB' } });
  const otherProvider = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, provider: 'other.bank' }, payload: {
    title: 'Покупка', description: 'Покупка на 12.00 RUB ТЕСТОВЫЙ МАГАЗИН',
  }});
  assert.notEqual(unrelated.normalizationStatus, 'READY');
  assert.notEqual(otherProvider.normalizationStatus, 'READY');
  assert.equal(otherProvider.eventType, 'UNKNOWN');
});

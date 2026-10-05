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

const payBase = {
  ...base,
  ingestionMetadata: {
    ...base.ingestionMetadata,
    sourcePackage: 'com.yandex.bank',
    notificationChannel: 'notification_channel_1',
  },
};

function payPayload(amount, available = '9753.21') {
  const body = `Перевод ТЕСТОВЫЙ ПОЛУЧАТЕЛЬ. ${amount} RUB. СИНТЕТИЧЕСКАЯ ОПЕРАЦИЯ. 2026.09.27 16:59. Доступно ${available} RUB`;
  return { title: 'Карта ТЕСТОВАЯ', description: body, text: body };
}

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
    accountReferenceKind: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: 'yandex-bank-normalizer-v2',
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

test('Yandex Pay outgoing v2 accepts the exact reviewed family and first monetary position', () => {
  const result = normalizeBankEvent({ ...payBase, payload: payPayload('2468.10') });
  assert.deepEqual(result, {
    eventType: 'OUTGOING_TRANSFER',
    occurredAt: '2026-09-27T16:59:00.000Z',
    amount: '2468.10',
    currency: 'RUB',
    direction: 'DEBIT',
    merchant: null,
    counterparty: null,
    accountReference: null,
    accountReferenceKind: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: 'yandex-bank-normalizer-v2',
  });
});

test('Yandex Pay outgoing v2 remains stable across amount and availability variation', () => {
  const result = normalizeBankEvent({ ...payBase, payload: payPayload('1357.20', '8642.13') });
  assert.equal(result.eventType, 'OUTGOING_TRANSFER');
  assert.equal(result.direction, 'DEBIT');
  assert.equal(result.amount, '1357.20');
  assert.equal(result.currency, 'RUB');
  assert.equal(result.normalizationStatus, 'READY');
});

test('Yandex Pay v2 requires equal non-empty description and text', () => {
  const payload = payPayload('2468.10');
  const mismatch = normalizeBankEvent({ ...payBase, payload: { ...payload, text: `${payload.text} ЛИШНИЙ ТЕКСТ` } });
  const blankDescription = normalizeBankEvent({ ...payBase, payload: { ...payload, description: '   ' } });
  for (const result of [mismatch, blankDescription]) {
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
    assert.notEqual(result.normalizationStatus, 'READY');
    assert.equal(result.amount, null);
  }
});

test('Yandex Pay v2 rejects unsupported envelope, currency, amount, and metadata near misses', () => {
  const cases = [
    { payload: { ...payPayload('2468.10'), title: 'Платёж ТЕСТОВЫЙ' } },
    { payload: { ...payPayload('2468.10'), description: payPayload('2468.10').description.replace('RUB', 'USD'), text: payPayload('2468.10').text.replace('RUB', 'USD') } },
    { payload: { ...payPayload('2468,10'), description: payPayload('2468,10').description, text: payPayload('2468,10').text } },
    { payload: { ...payPayload('2468.10'), description: payPayload('2468.10').description.replace('2026.09.27 16:59.', '2026/09/27 16:59.'), text: payPayload('2468.10').text.replace('2026.09.27 16:59.', '2026/09/27 16:59.') } },
    { ingestionMetadata: { ...payBase.ingestionMetadata, sourcePackage: 'ru.yandex.taximeter' } },
    { ingestionMetadata: { ...payBase.ingestionMetadata, notificationChannel: 'other_channel' } },
  ];
  for (const current of cases) {
    const result = normalizeBankEvent({ ...payBase, ...current, payload: current.payload ?? payPayload('2468.10') });
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.direction, 'UNKNOWN');
    assert.equal(result.amount, null);
    assert.notEqual(result.normalizationStatus, 'READY');
  }
});

test('Yandex Pro alias remains isolated from Yandex Pay v2', () => {
  const result = normalizeBankEvent({
    ...payBase,
    ingestionMetadata: { ...payBase.ingestionMetadata, sourcePackage: 'ru.yandex.taximeter' },
    payload: payPayload('2468.10'),
  });
  assert.equal(result.eventType, 'UNKNOWN');
  assert.equal(result.direction, 'UNKNOWN');
  assert.equal(result.amount, null);
  assert.notEqual(result.normalizationStatus, 'READY');
});

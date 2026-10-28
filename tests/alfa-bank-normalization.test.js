import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBankEvent } from '../src/bank-ingestion.js';

const base = {
  sourceKey: 'android-adam-samsung-s938b',
  sourceEventId: 'synthetic-alfa-normalization',
  observedAt: '2026-10-01T10:00:00Z',
  eventTime: '2026-10-01T09:59:00Z',
  ingestionMetadata: { adapter: 'android-notification', provider: 'ru.alfabank.mobile.android', deviceType: 'android', schemaVersion: '1' },
};

const title = '- 2468 ₽';
const body = 'СИНТЕТИЧЕСКИЙ перевод счета 0000*1111; Перевод на СИНТЕТИЧЕСКИЙ 2468,00 RUB; Получатель: 2222*3333; 12 карта 34:56';
const secondTitle = '- 9753 ₽';
const secondBody = body.replace('2468,00 RUB', '9753,00 RUB');
const oldV2SyntheticBody = body.replace('Перевод на', 'перевод на').replace('Получатель:', 'получатель:');

function result(payload = { title, description: body }, overrides = {}) {
  return normalizeBankEvent({ ...base, ...overrides, payload });
}

test('Alfa F5 promotes the exact proven outgoing semantics', () => {
  assert.deepEqual(result(), {
    eventType: 'OUTGOING_TRANSFER',
    occurredAt: '2026-10-01T09:59:00.000Z',
    amount: '2468.00',
    currency: 'RUB',
    direction: 'DEBIT',
    merchant: null,
    counterparty: null,
    accountReference: '1111',
    accountReferenceKind: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: 'alfa-bank-normalizer-v4',
  });
});

const alfaLifecycle = '9d0dc1ec-431a-4eb1-8d72-3b58ebddb346';

function alfaCardPurchase({ merchant = 'Тройка', titleAmount = '17', bodyAmount = '17,00', mask = '5580', lifecycleId = alfaLifecycle } = {}) {
  return normalizeBankEvent({
    ...base,
    ingestionMetadata: {
      ...base.ingestionMetadata,
      sourcePackage: 'ru.alfabank.mobile.android',
      notificationLifecycleId: lifecycleId,
    },
    payload: {
      title: `-${titleAmount} ₽. ${merchant}`,
      description: `${merchant}: ${bodyAmount} ₽; •• ${mask}`,
      text: `${merchant}: ${bodyAmount} ₽; •• ${mask}`,
    },
  });
}

test('Alfa recognizes the exact user-confirmed card-purchase envelope and extracts merchant', () => {
  for (const [merchant, titleAmount, bodyAmount, expectedAmount] of [
    ['Тройка', '2254', '2254,00', '2254.00'],
    ['Тройка', '17', '17,00', '17.00'],
    ['Пятёрочка', '350', '350,00', '350.00'],
    ['Coffee Shop', '350', '350,00', '350.00'],
  ]) {
    const normalized = alfaCardPurchase({ merchant, titleAmount, bodyAmount });
    assert.equal(normalized.eventType, 'PURCHASE');
    assert.equal(normalized.direction, 'DEBIT');
    assert.equal(normalized.amount, expectedAmount);
    assert.equal(normalized.currency, 'RUB');
    assert.equal(normalized.merchant, merchant);
    assert.equal(normalized.accountReference, '****5580');
    assert.equal(normalized.accountReferenceKind, 'MASKED_CARD');
    assert.equal(normalized.normalizationStatus, 'READY');
    assert.equal(normalized.evidenceQuality, 'EXACT');
    assert.equal(normalized.normalizationVersion, 'alfa-card-purchase-v1');
  }
});

test('Alfa card purchase preserves two decimal places only when both amounts agree', () => {
  const normalized = alfaCardPurchase({ merchant: 'Пятёрочка', titleAmount: '350,25', bodyAmount: '350,25' });
  assert.equal(normalized.eventType, 'PURCHASE');
  assert.equal(normalized.amount, '350.25');
  assert.equal(normalized.merchant, 'Пятёрочка');

  for (const [titleAmount, bodyAmount] of [['350', '350,25'], ['350,25', '350,24'], ['350,2', '350,20'], ['350,250', '350,25']]) {
    const result = alfaCardPurchase({ merchant: 'Пятёрочка', titleAmount, bodyAmount });
    assert.notEqual(result.eventType, 'PURCHASE');
    assert.notEqual(result.normalizationStatus, 'READY');
  }
});

test('Alfa same-amount purchases at different merchants remain independent and replay deterministically', () => {
  const first = alfaCardPurchase({ merchant: 'Пятёрочка', titleAmount: '350', bodyAmount: '350,00', lifecycleId: alfaLifecycle });
  const replay = alfaCardPurchase({ merchant: 'Пятёрочка', titleAmount: '350', bodyAmount: '350,00', lifecycleId: alfaLifecycle });
  const second = alfaCardPurchase({ merchant: 'Кофейня 24', titleAmount: '350', bodyAmount: '350,00', lifecycleId: 'ca16c787-23b7-4ef1-ae04-d975a4656a21' });
  assert.deepEqual(replay, first);
  assert.equal(first.eventType, 'PURCHASE');
  assert.equal(second.eventType, 'PURCHASE');
  assert.equal(first.amount, second.amount);
  assert.notEqual(first.merchant, second.merchant);
});

test('Alfa rejects transfers, refunds, cancellations, incomplete messages, and weak lifecycle evidence', () => {
  const metadata = { ...base.ingestionMetadata, sourcePackage: 'ru.alfabank.mobile.android', notificationLifecycleId: alfaLifecycle };
  const goodTitle = '- 17 ₽. Тройка';
  const goodBody = 'Тройка: 17,00 ₽; •• 5580';
  const unsupported = [
    { title: goodTitle, description: goodBody.replace('5580', '5581'), text: goodBody.replace('5580', '5581') },
    { title: goodTitle, description: goodBody.replace('17,00', '18,00'), text: goodBody.replace('17,00', '18,00') },
    { title: '-17 ₽', description: goodBody, text: goodBody },
    { title: '- 17 ₽. Перевод Иванову', description: 'Перевод Иванову: 17,00 ₽; •• 5580', text: 'Перевод Иванову: 17,00 ₽; •• 5580' },
    { title: '- 17 ₽. Возврат', description: 'Возврат: 17,00 ₽; •• 5580', text: 'Возврат: 17,00 ₽; •• 5580' },
    { title: '- 17 ₽. Отмена покупки', description: 'Отмена покупки: 17,00 ₽; •• 5580', text: 'Отмена покупки: 17,00 ₽; •• 5580' },
    { title: '- 17 ₽. Пополнение', description: 'Пополнение: 17,00 ₽; •• 5580', text: 'Пополнение: 17,00 ₽; •• 5580' },
    { title: '- 17 ₽. Пятёрочка', description: 'Магнит: 17,00 ₽; •• 5580', text: 'Магнит: 17,00 ₽; •• 5580' },
    { title: goodTitle, description: 'Перевод на получателя 17,00 RUB', text: 'Перевод на получателя 17,00 RUB' },
    { title: goodTitle, description: goodBody, text: 'неполный текст' },
    { title: '- 17 ₽.', description: goodBody, text: goodBody },
    { title: goodTitle, description: 'Тройка: 17,00 ₽', text: 'Тройка: 17,00 ₽' },
  ];
  for (const payload of unsupported) {
    const normalized = normalizeBankEvent({ ...base, ingestionMetadata: metadata, payload });
    assert.notEqual(normalized.eventType, 'PURCHASE');
  }

  for (const ingestionMetadata of [
    { ...metadata, notificationLifecycleId: undefined },
    { ...metadata, notificationLifecycleId: 'not-a-uuid' },
    { ...metadata, sourcePackage: 'com.example.other' },
    { ...metadata, adapter: 'other-adapter' },
    { ...metadata, schemaVersion: '2' },
  ]) {
    const normalized = normalizeBankEvent({
      ...base, ingestionMetadata,
      payload: { title: goodTitle, description: goodBody, text: goodBody },
    });
    assert.notEqual(normalized.eventType, 'PURCHASE');
  }

  const noEventTime = normalizeBankEvent({
    ...base, eventTime: null, ingestionMetadata: metadata,
    payload: { title: goodTitle, description: goodBody, text: goodBody },
  });
  assert.notEqual(noEventTime.eventType, 'PURCHASE');
});

test('Alfa F5 accepts a second sanitized sample only when title and body agree', () => {
  const normalized = result({ title: secondTitle, description: secondBody });
  assert.equal(normalized.amount, '9753.00');
  assert.equal(normalized.currency, 'RUB');
  assert.equal(normalized.accountReference, '1111');
  assert.equal(normalized.normalizationStatus, 'READY');
  assert.equal(normalized.evidenceQuality, 'EXACT');
  assert.equal(normalized.eventType, 'OUTGOING_TRANSFER');
  assert.equal(normalized.direction, 'DEBIT');
  assert.equal(normalized.normalizationVersion, 'alfa-bank-normalizer-v4');
});

test('Alfa F5 accepts comma-decimal title and body with exact normalized equality', () => {
  const normalized = result({
    title: '- 9753,25 ₽',
    description: body.replace('2468,00 RUB', '9753,25 RUB'),
  });
  assert.equal(normalized.normalizationVersion, 'alfa-bank-normalizer-v4');
  assert.equal(normalized.amount, '9753.25');
  assert.equal(normalized.currency, 'RUB');
  assert.equal(normalized.accountReference, '1111');
  assert.equal(normalized.normalizationStatus, 'READY');
  assert.equal(normalized.evidenceQuality, 'EXACT');
  assert.equal(normalized.eventType, 'OUTGOING_TRANSFER');
  assert.equal(normalized.direction, 'DEBIT');
});

test('Alfa v4 rejects the legacy synthetic lowercase-anchor body assumption', () => {
  const normalized = result({ title, description: oldV2SyntheticBody });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.amount, null);
  assert.equal(normalized.accountReference, null);
});

test('Alfa F5 requires the title integer and body comma-decimal to agree', () => {
  const normalized = result({ title, description: secondBody });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.amount, null);
  assert.equal(normalized.accountReference, null);
});

test('Alfa F5 rejects comma-decimal title and body mismatch', () => {
  const normalized = result({
    title: '- 9753,25 ₽',
    description: body.replace('2468,00 RUB', '9753,24 RUB'),
  });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.amount, null);
  assert.equal(normalized.accountReference, null);
});

test('Alfa F5 prefers description over text and normalizes whitespace', () => {
  const normalized = result({ title: ' -\n 2468 ₽ ', description: `  ${body.replaceAll(' ', '  ')} `, text: 'not the proven family' });
  assert.equal(normalized.amount, '2468.00');
  assert.equal(normalized.accountReference, '1111');
});

test('Alfa F5 semantic promotion does not mutate the raw payload', () => {
  const payload = { title, description: body, text: body };
  const before = structuredClone(payload);
  const normalized = result(payload);
  assert.equal(normalized.normalizationStatus, 'READY');
  assert.deepEqual(payload, before);
});

test('Alfa F5 falls back to text only when description is absent or blank', () => {
  assert.equal(result({ title, description: '', text: body }).normalizationStatus, 'READY');
  assert.equal(result({ title, description: '   ', text: body }).accountReference, '1111');
});

test('Alfa F5 rejects a missing title or body', () => {
  assert.equal(result({ description: body }).normalizationVersion, 'bank-normalizer-v1');
  assert.equal(result({ title }).normalizationVersion, 'bank-normalizer-v1');
});

test('Alfa F5 accepts only the two observed title amount grammars', () => {
  assert.equal(result({ title: '- 0 ₽', description: body.replace('2468,00 RUB', '0,00 RUB') }).amount, '0.00');
  assert.equal(result({ title: '- 9753,25 ₽', description: body.replace('2468,00 RUB', '9753,25 RUB') }).amount, '9753.25');
  assert.equal(result({ title: '- 2468.00 ₽', description: body }).amount, null);
  assert.equal(result({ title: '- 2 468 ₽', description: body }).amount, null);
  assert.equal(result({ title: '+ 2468 ₽', description: body }).amount, null);
  assert.equal(result({ title: '- 2468 ₽ ТЕСТ', description: body }).amount, null);
});

test('Alfa F5 rejects unsupported title decimal precision and currency forms', () => {
  for (const title of ['- 2468,0 ₽', '- 2468,000 ₽', '- 2468.00 ₽', '- 2468 RUB']) {
    const normalized = result({ title, description: body });
    assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
    assert.equal(normalized.amount, null);
    assert.equal(normalized.accountReference, null);
  }
});

test('Alfa F5 rejects unsupported body amount and currency forms', () => {
  for (const description of [
    body.replace('2468,00 RUB', '2468 RUB'),
    body.replace('2468,00 RUB', '2468.00 RUB'),
    body.replace('2468,00 RUB', '2468,0 RUB'),
    body.replace('2468,00 RUB', '2468,000 RUB'),
    body.replace('2468,00 RUB', '2468,00 руб'),
  ]) {
    const normalized = result({ title, description });
    assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
    assert.equal(normalized.amount, null);
    assert.equal(normalized.accountReference, null);
  }
});

test('Alfa F5 requires the proven RUB symbol and rejects other currencies', () => {
  assert.equal(result({ title: '- 2468 RUB', description: body }).amount, null);
  assert.equal(result({ title: '- 2468 $', description: body }).amount, null);
  assert.equal(result({ title, description: body.replace('2468,00 RUB', '2468,00 руб') }).amount, null);
  assert.equal(result({ title, description: body.replace('2468,00 RUB', '2468.00 RUB') }).amount, null);
  assert.equal(result({ title, description: body.replace('2468,00 RUB', '2468 RUB') }).amount, null);
});

test('Alfa F5 rejects historical and informational body families', () => {
  for (const description of ['Покупка в СИНТЕТИЧЕСКОМ МАГАЗИНЕ', 'Баланс обновлён', 'Пополнение карты']) {
    assert.equal(result({ title, description }).normalizationVersion, 'bank-normalizer-v1');
  }
});

test('Alfa F5 rejects extra prefix or suffix content', () => {
  assert.equal(result({ title: 'ПРЕФИКС - 2468 ₽', description: body }).amount, null);
  assert.equal(result({ title: '- 2468 ₽ СУФФИКС', description: body }).amount, null);
  assert.equal(result({ title, description: `ПРЕФИКС ${body}` }).amount, null);
});

test('Alfa v4 rejects reordered proven body sections', () => {
  const sections = body.split(';');
  const reorderedBody = [sections[1], sections[0], sections[2], sections[3]].join(';');
  const normalized = result({ title, description: reorderedBody });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.amount, null);
  assert.equal(normalized.accountReference, null);
});

test('non-empty invalid description cannot be bypassed by valid text', () => {
  const normalized = result({ title, description: 'invalid Alfa body', text: body });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.amount, null);
});

test('missing event time prevents exact F5 promotion', () => {
  const normalized = result(undefined, { eventTime: null });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.amount, null);
});

test('Alfa F5 keeps reference kind and identity semantics fail-closed', () => {
  const normalized = result();
  assert.equal(normalized.eventType, 'OUTGOING_TRANSFER');
  assert.equal(normalized.direction, 'DEBIT');
  assert.equal(normalized.accountReferenceKind, null);
  assert.equal(normalized.merchant, null);
  assert.equal(normalized.counterparty, null);
  assert.equal(normalized.normalizationStatus, 'READY');
  assert.equal(normalized.evidenceQuality, 'EXACT');
});

test('Alfa F5 rejects malformed, ambiguous, and unsupported variants', () => {
  for (const payload of [
    { title: '- 2468,01 ₽', description: body },
    { title: '- 2468 ₽', description: body.replace('Перевод на', 'Платёж на') },
    { title: '- 2468 ₽', description: `${body} лишний текст` },
    { title: '- 2468 ₽', description: body.replace('0000*1111', '00001111') },
    { title: '- 2468 ₽', description: body.replace('2468,00 RUB', '2468.00 USD') },
    { title: 'ПЕРЕВОД - 2468 ₽', description: body },
  ]) {
    const normalized = result(payload);
    assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
    assert.equal(normalized.amount, null);
    assert.equal(normalized.accountReference, null);
  }
});

test('Alfa v4 requires every proven body section and reference position', () => {
  for (const description of [
    body.replace('0000*1111', '00001111'),
    body.replace('2222*3333', '22223333'),
    body.replace('Перевод на', 'Платёж на'),
    body.replace('; Получатель:', ''),
    `${body}; лишняя секция`,
  ]) {
    const normalized = result({ title, description });
    assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
    assert.equal(normalized.amount, null);
    assert.equal(normalized.accountReference, null);
  }
});

test('Alfa F5 is scoped to provider, adapter, and schema version', () => {
  for (const overrides of [
    { ingestionMetadata: { ...base.ingestionMetadata, provider: 'other.bank' } },
    { ingestionMetadata: { ...base.ingestionMetadata, adapter: 'other-adapter' } },
    { ingestionMetadata: { ...base.ingestionMetadata, schemaVersion: '2' } },
    { ingestionMetadata: { adapter: 'android-notification', provider: 'ru.alfabank.mobile.android', deviceType: 'android' } },
  ]) {
    const normalized = result(undefined, overrides);
    assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
    assert.equal(normalized.amount, null);
    assert.equal(normalized.accountReference, null);
  }
});

test('unmatched structured Alfa notifications preserve generic normalization', () => {
  const normalized = result({ amount: '2468.00', currency: 'RUB', direction: 'DEBIT', title: 'Синтетическая операция', description: '2468.00 RUB' });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.normalizationStatus, 'READY');
  assert.equal(normalized.direction, 'DEBIT');
});

test('Alfa parser does not infer identity from an extracted reference', () => {
  const normalized = result();
  assert.equal(normalized.accountReference, '1111');
  assert.equal(normalized.accountReferenceKind, null);
});

test('Yandex, Sber, and T-Bank dispatch remains unchanged', () => {
  const yandex = normalizeBankEvent({ ...base, ingestionMetadata: { ...base.ingestionMetadata, provider: 'com.yandex.bank' }, payload: { title: 'Покупка', description: 'Покупка на 12.00 RUB ТЕСТОВЫЙ МАГАЗИН' } });
  assert.equal(yandex.normalizationVersion, 'yandex-bank-normalizer-v3');
  assert.equal(yandex.eventType, 'PURCHASE');
});

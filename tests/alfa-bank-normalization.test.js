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
const body = 'СИНТЕТИЧЕСКИЙ перевод счета 0000*1111; перевод на СИНТЕТИЧЕСКИЙ 12,34 руб; получатель: 2222*3333; 12 карта 34:56';

function result(payload = { title, description: body }, overrides = {}) {
  return normalizeBankEvent({ ...base, ...overrides, payload });
}

test('Alfa F5 extracts only the proven partial facts', () => {
  assert.deepEqual(result(), {
    eventType: 'UNKNOWN',
    occurredAt: '2026-10-01T09:59:00.000Z',
    amount: '2468.00',
    currency: 'RUB',
    direction: 'UNKNOWN',
    merchant: null,
    counterparty: null,
    accountReference: '1111',
    accountReferenceKind: null,
    normalizationStatus: 'PARTIAL',
    evidenceQuality: 'PARTIAL',
    normalizationVersion: 'alfa-bank-normalizer-v1',
  });
});

test('Alfa F5 prefers description over text and normalizes whitespace', () => {
  const normalized = result({ title: ' -\n 2468 ₽ ', description: `  ${body.replaceAll(' ', '  ')} `, text: 'not the proven family' });
  assert.equal(normalized.amount, '2468.00');
  assert.equal(normalized.accountReference, '1111');
});

test('Alfa F5 falls back to text only when description is absent or blank', () => {
  assert.equal(result({ title, description: '', text: body }).normalizationStatus, 'PARTIAL');
  assert.equal(result({ title, description: '   ', text: body }).accountReference, '1111');
});

test('Alfa F5 rejects a missing title or body', () => {
  assert.equal(result({ description: body }).normalizationVersion, 'bank-normalizer-v1');
  assert.equal(result({ title }).normalizationVersion, 'bank-normalizer-v1');
});

test('Alfa F5 accepts only the integer title amount grammar', () => {
  assert.equal(result({ title: '- 0 ₽', description: body }).amount, '0.00');
  assert.equal(result({ title: '- 2468.00 ₽', description: body }).amount, null);
  assert.equal(result({ title: '- 2 468 ₽', description: body }).amount, null);
});

test('Alfa F5 requires the proven RUB symbol and rejects other currencies', () => {
  assert.equal(result({ title: '- 2468 RUB', description: body }).amount, null);
  assert.equal(result({ title: '- 2468 $', description: body }).amount, null);
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

test('non-empty invalid description cannot be bypassed by valid text', () => {
  const normalized = result({ title, description: 'invalid Alfa body', text: body });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.amount, null);
});

test('missing event time prevents Alfa partial extraction', () => {
  const normalized = result(undefined, { eventTime: null });
  assert.equal(normalized.normalizationVersion, 'bank-normalizer-v1');
  assert.equal(normalized.amount, null);
});

test('Alfa F5 keeps event type, direction, and reference kind fail-closed', () => {
  const normalized = result();
  assert.equal(normalized.eventType, 'UNKNOWN');
  assert.equal(normalized.direction, 'UNKNOWN');
  assert.equal(normalized.accountReferenceKind, null);
  assert.equal(normalized.merchant, null);
  assert.equal(normalized.counterparty, null);
});

test('Alfa F5 rejects malformed, ambiguous, and unsupported variants', () => {
  for (const payload of [
    { title: '- 2468,00 ₽', description: body },
    { title: '- 2468 ₽', description: body.replace('перевод на', 'платёж на') },
    { title: '- 2468 ₽', description: `${body} лишний текст` },
    { title: '- 2468 ₽', description: body.replace('0000*1111', '00001111') },
    { title: '- 2468 ₽', description: body.replace('12,34 руб', '12.34 USD') },
    { title: 'ПЕРЕВОД - 2468 ₽', description: body },
  ]) {
    const normalized = result(payload);
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
  assert.equal(yandex.normalizationVersion, 'yandex-bank-normalizer-v1');
  assert.equal(yandex.eventType, 'PURCHASE');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestBankEvent, normalizeBankEvent, TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV } from '../src/bank-ingestion.js';

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
const debitPurchaseBody = ({ amount = '24', card = '****7268', balance = '8 765,43 ₽', marker = 'Покупка' } = {}) =>
  `${marker} в ТЕСТОВОЙ ТОЧКЕ ${amount} ₽ карта ${card} Баланс ${balance}`;

function normalize(payload, overrides = {}) {
  return normalizeBankEvent({ ...base, ...overrides, payload });
}

function normalizeDebitPurchase(payload, enabled = true, overrides = {}) {
  return normalizeBankEvent({ ...base, ...overrides, payload }, { enableTbankDebitPurchaseParser: enabled });
}

function assertUnknownPurchase(payload) {
  const result = normalizeDebitPurchase(payload);
  assert.equal(result.eventType, 'UNKNOWN');
  assert.equal(result.direction, 'UNKNOWN');
  assert.equal(result.amount, null);
  assert.equal(result.currency, null);
  assert.notEqual(result.normalizationStatus, 'READY');
  assert.notEqual(result.evidenceQuality, 'EXACT');
}

function syntheticIngestionPool() {
  const counts = { transactionInserts: 0 };
  let transactionValues;
  const client = {
    async query(sql) {
      const query = String(sql).trim();
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK' || query.startsWith('SELECT pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      if (query.startsWith('SELECT id,payload_sha256 FROM bank_event_observations')) return { rows: [], rowCount: 0 };
      if (query.startsWith('INSERT INTO bank_event_observations')) return { rows: [{ id: 101 }], rowCount: 1 };
      if (query.startsWith('INSERT INTO bank_transactions')) {
        counts.transactionInserts += 1;
        return { rows: [{ id: 202 }], rowCount: 1 };
      }
      if (query.includes('FROM bank_transactions bt') && query.includes('bank_source_person')) {
        return {
          rows: [{
            accountReference: transactionValues?.[7] ?? null,
            accountReferenceKind: transactionValues?.[8] ?? null,
            bankSourceId: 1,
            provider: 'com.idamob.tinkoff.android',
            scope_ids: [],
          }],
          rowCount: 1,
        };
      }
      if (query.startsWith('INSERT INTO bank_transaction_account_resolution')
        || query.startsWith('INSERT INTO bank_transaction_payment_instrument_resolution')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected synthetic query: ${query.slice(0, 60)}`);
    },
    release() {},
  };
  return {
    counts,
    async query() { return { rows: [{ id: 1, enabled: true }], rowCount: 1 }; },
    async connect() {
      const originalQuery = client.query;
      client.query = async (sql, params) => {
        if (String(sql).trim().startsWith('INSERT INTO bank_transactions')) transactionValues = params;
        return originalQuery(sql, params);
      };
      return client;
    },
  };
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

test('T-Bank debit purchase parser is disabled unless explicitly opted in', () => {
  const result = normalize({ description: debitPurchaseBody() });
  assert.equal(result.eventType, 'UNKNOWN');
  assert.equal(result.direction, 'UNKNOWN');
  assert.equal(result.amount, null);
  assert.equal(result.normalizationStatus, 'PARTIAL');
});

test('T-Bank opt-in recognizes only the confirmed debit purchase and excludes the later balance', () => {
  const result = normalizeDebitPurchase({ description: debitPurchaseBody() });
  assert.deepEqual(result, {
    eventType: 'PURCHASE',
    occurredAt: '2026-10-01T11:59:00.000Z',
    amount: '24.00',
    currency: 'RUB',
    direction: 'DEBIT',
    merchant: null,
    counterparty: null,
    accountReference: '****7268',
    accountReferenceKind: 'MASKED_CARD',
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: 'tbank-debit-purchase-normalizer-v1',
  });
});

test('T-Bank parser accepts identical text and description once, but rejects conflicting copies', () => {
  const body = debitPurchaseBody();
  const sameFields = normalizeDebitPurchase({ description: body, text: body });
  assert.equal(sameFields.amount, '24.00');
  assert.equal(sameFields.eventType, 'PURCHASE');

  assertUnknownPurchase({ description: body, text: debitPurchaseBody({ amount: '25' }) });
  const fallback = normalizeDebitPurchase({ description: ' ', text: body });
  assert.equal(fallback.amount, '24.00');
});

test('T-Bank debit purchase requires the exact confirmed masked card', () => {
  assertUnknownPurchase({ description: debitPurchaseBody({ card: '' }) });
  assertUnknownPurchase({ description: debitPurchaseBody({ card: '****1234' }) });
});

test('T-Bank debit purchase parser is isolated by provider, adapter, and schema', () => {
  for (const ingestionMetadata of [
    { ...base.ingestionMetadata, provider: 'other.bank' },
    { ...base.ingestionMetadata, adapter: 'BANK_API' },
    { ...base.ingestionMetadata, schemaVersion: '2' },
  ]) {
    const result = normalizeDebitPurchase({ description: debitPurchaseBody() }, true, { ingestionMetadata });
    assert.equal(result.eventType, 'UNKNOWN');
    assert.equal(result.amount, null);
    assert.notEqual(result.normalizationStatus, 'READY');
  }
});

test('T-Bank debit purchase rejects credit, transfer, top-up, refund, and cash withdrawal wording', () => {
  for (const marker of ['Кредитная операция', 'Перевод', 'Пополнение', 'Возврат', 'Снятие наличных']) {
    assertUnknownPurchase({ description: debitPurchaseBody({ marker }) });
  }
});

test('T-Bank debit purchase rejects declined, insufficient-funds, failed, and cancelled operations', () => {
  for (const marker of [
    'Покупка отклонена',
    'Недостаточно средств. Покупка',
    'Оплата неуспешна',
    'Покупка отменена',
  ]) {
    assertUnknownPurchase({ description: debitPurchaseBody({ marker }) });
  }
});

test('T-Bank debit purchase rejects balance-only notices and missing RUB markers', () => {
  assertUnknownPurchase({ description: 'Баланс 8 765,43 ₽ карта ****7268' });
  assertUnknownPurchase({ description: debitPurchaseBody().replace('24 ₽', '24') });
});

test('T-Bank debit purchase rejects multiple monetary amounts and malformed ordering', () => {
  const cases = [
    debitPurchaseBody().replace('24 ₽', '24 ₽ и комиссия 1 ₽'),
    debitPurchaseBody().replace('24 ₽', '24,50 ₽'),
    debitPurchaseBody().replace('карта ****7268', 'комиссия 1 USD карта ****7268'),
    debitPurchaseBody().replace('карта ****7268 Баланс', 'Баланс 8 765,43 ₽ карта ****7268'),
    debitPurchaseBody().replace('Покупка в ТЕСТОВОЙ ТОЧКЕ 24 ₽', '24 ₽ Покупка в ТЕСТОВОЙ ТОЧКЕ'),
    debitPurchaseBody().replace('****7268', 'Баланс ****7268'),
  ];
  for (const description of cases) assertUnknownPurchase({ description });
});

test('T-Bank debit purchase still rejects missing time and preserves existing top-up behavior', () => {
  const noTime = normalizeDebitPurchase({ description: debitPurchaseBody() }, true, { eventTime: null });
  assert.equal(noTime.eventType, 'UNKNOWN');
  assert.equal(noTime.amount, null);

  const topUp = normalizeDebitPurchase({ description: topUpBody() });
  assert.equal(topUp.eventType, 'UNKNOWN');
  assert.equal(topUp.direction, 'CREDIT');
  assert.equal(topUp.amount, '2468.00');
});

test('T-Bank parser opt-in does not change Yandex or Sber normalization', () => {
  const cases = [
    {
      ...base,
      ingestionMetadata: { ...base.ingestionMetadata, provider: 'com.yandex.bank' },
      payload: { description: 'Покупка на 24.00 RUB' },
    },
    {
      ...base,
      ingestionMetadata: { ...base.ingestionMetadata, provider: 'ru.sberbankmobile' },
      payload: {
        title: 'Покупка ТЕСТОВЫЙ МЕРЧАНТ',
        description: '24 ₽ — Баланс: 56,78 ₽ Счёт карты МИР •• 1234',
        text: '24 ₽ — Баланс: 56,78 ₽ Счёт карты МИР •• 1234',
      },
    },
  ];
  for (const input of cases) {
    const unchanged = normalizeBankEvent(input);
    assert.deepEqual(normalizeBankEvent(input, { enableTbankDebitPurchaseParser: true }), unchanged);
    assert.equal(unchanged.normalizationStatus, 'READY');
  }
});

test('T-Bank ingestion requires exact runtime opt-in and stores one transaction for repeated fields', async () => {
  const original = process.env[TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV];
  const input = {
    ...base,
    sourceKey: 'synthetic-tbank-source',
    sourceEventId: 'synthetic-tbank-purchase-event',
    payload: { text: debitPurchaseBody(), description: debitPurchaseBody() },
  };
  try {
    for (const value of [undefined, 'TRUE', '1']) {
      if (value === undefined) delete process.env[TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV];
      else process.env[TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV] = value;
      const pool = syntheticIngestionPool();
      const result = await ingestBankEvent(pool, input);
      assert.equal(result.normalization.eventType, 'UNKNOWN');
      assert.equal(result.normalization.amount, null);
      assert.equal(pool.counts.transactionInserts, 1);
    }

    process.env[TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV] = 'true';
    const pool = syntheticIngestionPool();
    const result = await ingestBankEvent(pool, input);
    assert.equal(result.normalization.eventType, 'PURCHASE');
    assert.equal(result.normalization.amount, '24.00');
    assert.equal(pool.counts.transactionInserts, 1);
  } finally {
    if (original === undefined) delete process.env[TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV];
    else process.env[TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV] = original;
  }
});

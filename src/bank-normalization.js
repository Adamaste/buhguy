export const YANDEX_BANK_NORMALIZATION_VERSION = 'yandex-bank-normalizer-v1';

const YANDEX_PROVIDER = 'com.yandex.bank';
const RUB_AMOUNT = /^(\d+)\.(\d{2})\s+RUB\b/i;

function normalizeWhitespace(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizedAmount(value) {
  const match = normalizeWhitespace(value).match(RUB_AMOUNT);
  if (!match) return null;
  return `${match[1]}.${match[2]}`;
}

function occurredAt(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function incomplete({ occurred, amount, hasCurrency, hasFinancialMarker }) {
  const partial = occurred !== null || amount !== null || hasCurrency || hasFinancialMarker;
  return {
    eventType: 'UNKNOWN',
    occurredAt: occurred,
    amount: null,
    currency: null,
    direction: 'UNKNOWN',
    merchant: null,
    counterparty: null,
    accountReference: null,
    normalizationStatus: partial ? 'PARTIAL' : 'UNKNOWN',
    evidenceQuality: partial ? 'PARTIAL' : 'INSUFFICIENT',
    normalizationVersion: YANDEX_BANK_NORMALIZATION_VERSION,
  };
}

export function normalizeYandexBankEvent(input) {
  const payload = input.payload ?? {};
  const title = normalizeWhitespace(payload.title);
  const body = normalizeWhitespace(payload.description) || normalizeWhitespace(payload.text);
  const occurred = occurredAt(input.eventTime ?? payload.occurredAt);
  const isPurchase = body.startsWith('Покупка на ');
  const isIncoming = title === 'Входящий перевод' && body.startsWith('Пополнение на ');
  const hasFinancialMarker = title === 'Покупка' || title === 'Входящий перевод'
    || body.startsWith('Покупка на ') || body.startsWith('Пополнение на ');
  const amount = normalizedAmount(body.slice(isPurchase ? 'Покупка на '.length : isIncoming ? 'Пополнение на '.length : 0));
  const hasCurrency = /\bRUB\b/i.test(body);

  if (!isPurchase && !isIncoming) return incomplete({ occurred, amount, hasCurrency, hasFinancialMarker });
  if (!amount || !occurred || !hasCurrency) return incomplete({ occurred, amount, hasCurrency, hasFinancialMarker: true });

  return {
    eventType: isPurchase ? 'PURCHASE' : 'INCOMING_TRANSFER',
    occurredAt: occurred,
    amount,
    currency: 'RUB',
    direction: isPurchase ? 'DEBIT' : 'CREDIT',
    merchant: null,
    counterparty: null,
    accountReference: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: YANDEX_BANK_NORMALIZATION_VERSION,
  };
}

export function isYandexBankProvider(input) {
  return input.ingestionMetadata?.provider === YANDEX_PROVIDER;
}

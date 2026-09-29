export const YANDEX_BANK_NORMALIZATION_VERSION = 'yandex-bank-normalizer-v1';
export const SBER_BANK_NORMALIZATION_VERSION = 'sber-bank-normalizer-v1';

const YANDEX_PROVIDER = 'com.yandex.bank';
const SBER_PROVIDER = 'ru.sberbankmobile';
const ANDROID_NOTIFICATION_ADAPTER = 'android-notification';
const SBER_ANDROID_SCHEMA_VERSION = '1';
const SBER_INCOMING_TITLE_PATTERNS = [
  /^💳 Он пришёл! Перевод от [\p{L}\p{M} .'-]+$/u,
  /^⭐ Баланс увеличился благодаря переводу от [\p{L}\p{M} .'-]+$/u,
];
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
    accountReferenceKind: null,
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
    accountReferenceKind: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: YANDEX_BANK_NORMALIZATION_VERSION,
  };
}

export function isYandexBankProvider(input) {
  return input.ingestionMetadata?.provider === YANDEX_PROVIDER;
}

function incompleteSber({ occurred, hasIncomingMarker, hasCurrency, amount }) {
  const partial = occurred !== null || hasIncomingMarker || hasCurrency || amount !== null;
  return {
    eventType: 'UNKNOWN',
    occurredAt: occurred,
    amount: null,
    currency: null,
    direction: 'UNKNOWN',
    merchant: null,
    counterparty: null,
    accountReference: null,
    accountReferenceKind: null,
    normalizationStatus: partial ? 'PARTIAL' : 'UNKNOWN',
    evidenceQuality: partial ? 'PARTIAL' : 'INSUFFICIENT',
    normalizationVersion: SBER_BANK_NORMALIZATION_VERSION,
  };
}

export function normalizeSberBankEvent(input) {
  const payload = input.payload ?? {};
  const title = normalizeWhitespace(payload.title);
  const body = normalizeWhitespace(payload.description) || normalizeWhitespace(payload.text);
  const occurred = occurredAt(input.eventTime);
  const hasIncomingTitle = SBER_INCOMING_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const amountMatch = body.match(/^\+\s*(\d+)\s*₽\s*/u);
  const afterAmount = amountMatch ? body.slice(amountMatch[0].length).trimStart() : '';
  const accountReferenceMatch = afterAmount.match(/^—\s*Теперь у вас:\s*\d+(?:[\s\u00a0]\d{3})*,\d{2}\s*₽\s+Плат\.\s*счёт\s*••\s*(\d{4})\b/u);
  const hasIncomingStructure = Boolean(accountReferenceMatch);
  const hasIncomingMarker = hasIncomingTitle && body.startsWith('+');
  const amount = amountMatch ? `${amountMatch[1]}.00` : null;
  const hasCurrency = body.includes('\u20bd');

  if (!hasIncomingTitle || !hasIncomingMarker || !amountMatch || !hasIncomingStructure || !occurred || !hasCurrency) {
    return incompleteSber({ occurred, hasIncomingMarker, hasCurrency, amount });
  }

  return {
    eventType: 'INCOMING_TRANSFER',
    occurredAt: occurred,
    amount,
    currency: 'RUB',
    direction: 'CREDIT',
    merchant: null,
    counterparty: null,
    accountReference: accountReferenceMatch[1],
    accountReferenceKind: 'MASKED_ACCOUNT',
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: SBER_BANK_NORMALIZATION_VERSION,
  };
}

export function isSberBankAndroidNotification(input) {
  return input.ingestionMetadata?.provider === SBER_PROVIDER
    && input.ingestionMetadata?.adapter === ANDROID_NOTIFICATION_ADAPTER
    && input.ingestionMetadata?.schemaVersion === SBER_ANDROID_SCHEMA_VERSION;
}

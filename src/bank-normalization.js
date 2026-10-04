export const YANDEX_BANK_NORMALIZATION_VERSION = 'yandex-bank-normalizer-v1';
export const SBER_BANK_NORMALIZATION_VERSION = 'sber-bank-normalizer-v5';
export const TBANK_BANK_NORMALIZATION_VERSION = 'tbank-bank-normalizer-v2';
export const ALFA_BANK_NORMALIZATION_VERSION = 'alfa-bank-normalizer-v4';

const YANDEX_PROVIDER = 'com.yandex.bank';
const SBER_PROVIDER = 'ru.sberbankmobile';
const TBANK_PROVIDER = 'com.idamob.tinkoff.android';
const ALFA_PROVIDER = 'ru.alfabank.mobile.android';
const ANDROID_NOTIFICATION_ADAPTER = 'android-notification';
const SBER_ANDROID_SCHEMA_VERSION = '1';
const TBANK_ANDROID_SCHEMA_VERSION = '1';
const ALFA_ANDROID_SCHEMA_VERSION = '1';
const SBER_INCOMING_TITLE_PATTERN = /^Перевод по СБП от [\p{L}\p{M} '-]+\.$/u;
const SBER_OUTGOING_TITLE_PATTERN = /^[\p{L}\p{M}]+ [\p{L}\p{M}]+‑[\p{L}\p{M}]+$/u;
const RUB_AMOUNT = /^(\d+)\.(\d{2})\s+RUB\b/i;
const TBANK_TOP_UP_BODY_PATTERN = /^Пополнение\s+на\s+(\d+)\s+₽,\s+счет\s+RUB\.\s+[\p{L}\p{M} .'-]+\s+Доступно\s+\d+(?:[\s\u00a0\u202f]\d{3})*,\d{2}\s+₽$/u;
const ALFA_TITLE_PATTERN = /^-\s*(\d+)(?:,(\d{2}))?\s*₽$/u;
const ALFA_F5_ACCOUNT_SECTION = /^[\p{L}\p{M}\d.'-]+\s+[\p{L}\p{M}\d.'-]+\s+счета\s+\d+\s*\*\s*(\d{4})$/u;
const ALFA_F5_AMOUNT_SECTION = /^Перевод\s+на\s+[\p{L}\p{M}\d.'-]+\s+(\d+,\d{2})\s+RUB$/u;
const ALFA_F5_RECIPIENT_SECTION = /^Получатель:\s+\d+\s*\*\s*\d{4}$/u;
const ALFA_F5_TRAILING_SECTION = /^\d+\s+[\p{L}\p{M}\d.'-]+\s+\d+:\d+$/u;

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

function incompleteTbank({ occurred, hasFinancialMarker }) {
  const partial = occurred !== null || hasFinancialMarker;
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
    normalizationVersion: TBANK_BANK_NORMALIZATION_VERSION,
  };
}

export function normalizeTbankBankEvent(input) {
  const payload = input.payload ?? {};
  const body = normalizeWhitespace(payload.description) || normalizeWhitespace(payload.text);
  const occurred = occurredAt(input.eventTime);
  const match = body.match(TBANK_TOP_UP_BODY_PATTERN);
  const hasFinancialMarker = body.startsWith('Пополнение на ');

  if (!match || !occurred) return incompleteTbank({ occurred, hasFinancialMarker });

  return {
    eventType: 'UNKNOWN',
    occurredAt: occurred,
    amount: `${match[1]}.00`,
    currency: 'RUB',
    direction: 'CREDIT',
    merchant: null,
    counterparty: null,
    accountReference: null,
    accountReferenceKind: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: TBANK_BANK_NORMALIZATION_VERSION,
  };
}

export function isTbankBankAndroidNotification(input) {
  return input.ingestionMetadata?.provider === TBANK_PROVIDER
    && input.ingestionMetadata?.adapter === ANDROID_NOTIFICATION_ADAPTER
    && input.ingestionMetadata?.schemaVersion === TBANK_ANDROID_SCHEMA_VERSION;
}

function exactAlfa({ occurred, amount, accountReference }) {
  return {
    eventType: 'OUTGOING_TRANSFER',
    occurredAt: occurred,
    amount,
    currency: 'RUB',
    direction: 'DEBIT',
    merchant: null,
    counterparty: null,
    accountReference,
    accountReferenceKind: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: ALFA_BANK_NORMALIZATION_VERSION,
  };
}

export function normalizeAlfaBankEvent(input) {
  const payload = input.payload ?? {};
  const title = normalizeWhitespace(payload.title);
  const body = normalizeWhitespace(payload.description) || normalizeWhitespace(payload.text);
  const occurred = occurredAt(input.eventTime);
  const titleMatch = title.match(ALFA_TITLE_PATTERN);
  const sections = body.split(';').map((section) => section.trim());
  const accountMatch = sections.length === 4 ? sections[0].match(ALFA_F5_ACCOUNT_SECTION) : null;
  const amountMatch = sections.length === 4 ? sections[1].match(ALFA_F5_AMOUNT_SECTION) : null;
  const recipientMatch = sections.length === 4 ? ALFA_F5_RECIPIENT_SECTION.test(sections[2]) : false;
  const trailingMatch = sections.length === 4 ? ALFA_F5_TRAILING_SECTION.test(sections[3]) : false;
  if (!titleMatch || !accountMatch || !amountMatch || !recipientMatch || !trailingMatch || !occurred) return null;
  const titleInteger = titleMatch[1].replace(/^0+(?=\d)/u, '');
  const titleAmount = `${titleInteger}.${titleMatch[2] ?? '00'}`;
  const bodyAmount = amountMatch[1].replace(',', '.');
  if (titleAmount !== bodyAmount) return null;
  return exactAlfa({ occurred, amount: titleAmount, accountReference: accountMatch[1] });
}

export function isAlfaBankAndroidNotification(input) {
  return input.ingestionMetadata?.provider === ALFA_PROVIDER
    && input.ingestionMetadata?.adapter === ANDROID_NOTIFICATION_ADAPTER
    && input.ingestionMetadata?.schemaVersion === ALFA_ANDROID_SCHEMA_VERSION;
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

function normalizeSberOutgoing({ occurred, amount, accountReference }) {
  return {
    eventType: 'OUTGOING_TRANSFER',
    occurredAt: occurred,
    amount,
    currency: amount === null ? null : 'RUB',
    direction: 'DEBIT',
    merchant: null,
    counterparty: null,
    accountReference,
    accountReferenceKind: accountReference === null ? null : 'MASKED_ACCOUNT',
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: SBER_BANK_NORMALIZATION_VERSION,
  };
}

export function normalizeSberBankEvent(input) {
  const payload = input.payload ?? {};
  const title = normalizeWhitespace(payload.title);
  const body = normalizeWhitespace(payload.description) || normalizeWhitespace(payload.text);
  const occurred = occurredAt(input.eventTime);
  const hasIncomingTitle = SBER_INCOMING_TITLE_PATTERN.test(title);
  const amountMatch = body.match(/^\+\s*(\d+)\s*₽\s*/u);
  const afterAmount = amountMatch ? body.slice(amountMatch[0].length).trimStart() : '';
  const accountReferenceMatch = afterAmount.match(/^—\s*Баланс:\s*\d+(?:[\s\u00a0\u202f]\d{3})*,\d{2}\s*₽\s+Плат\.\s*счёт\s*••\s*(\d{4})$/u);
  const hasIncomingStructure = Boolean(accountReferenceMatch);
  const hasIncomingMarker = hasIncomingTitle && body.startsWith('+');
  const amount = amountMatch ? `${amountMatch[1]}.00` : null;
  const hasCurrency = body.includes('\u20bd');

  if (!hasIncomingTitle || !hasIncomingMarker || !amountMatch || !hasIncomingStructure || !occurred || !hasCurrency) {
    const outgoingTitle = SBER_OUTGOING_TITLE_PATTERN.test(title);
    const outgoingMatch = body.match(/^([0-9]+(?:[ ]+[0-9]{3})*)[ ]*₽[ ]+—[ ]+Баланс:[ ]*([0-9]+(?:[ ]+[0-9]{3})*,[0-9]{2})[ ]*₽[ ]+Плат\.[ ]*счёт[ ]*••[ ]*([0-9]{4})$/u);
    if (outgoingTitle && outgoingMatch && occurred) {
      return normalizeSberOutgoing({
        occurred,
        amount: `${outgoingMatch[1].replaceAll(' ', '')}.00`,
        accountReference: outgoingMatch[3],
      });
    }
    return incompleteSber({ occurred, hasIncomingMarker, hasCurrency, amount: null });
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

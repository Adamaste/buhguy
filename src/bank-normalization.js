export const YANDEX_BANK_NORMALIZATION_VERSION = 'yandex-bank-normalizer-v3';
export const SBER_BANK_NORMALIZATION_VERSION = 'sber-bank-normalizer-v7';
export const TBANK_BANK_NORMALIZATION_VERSION = 'tbank-bank-normalizer-v2';
export const TBANK_DEBIT_PURCHASE_NORMALIZATION_VERSION = 'tbank-debit-purchase-normalizer-v1';
export const ALFA_BANK_NORMALIZATION_VERSION = 'alfa-bank-normalizer-v4';

const YANDEX_PROVIDER = 'com.yandex.bank';
const SBER_PROVIDER = 'ru.sberbankmobile';
const TBANK_PROVIDER = 'com.idamob.tinkoff.android';
const ALFA_PROVIDER = 'ru.alfabank.mobile.android';
const ANDROID_NOTIFICATION_ADAPTER = 'android-notification';
const SBER_ANDROID_SCHEMA_VERSION = '1';
const TBANK_ANDROID_SCHEMA_VERSION = '1';
const ALFA_ANDROID_SCHEMA_VERSION = '1';
const YANDEX_PAY_SOURCE_PACKAGE = 'com.yandex.bank';
const YANDEX_PAY_NOTIFICATION_CHANNEL = 'notification_channel_1';
const SBER_INCOMING_TITLE_PATTERN = /^Перевод по СБП от [\p{L}\p{M} '-]+\.$/u;
const SBER_OUTGOING_TITLE_PATTERN = /^[\p{L}\p{M}]+ [\p{L}\p{M}]+‑[\p{L}\p{M}]+$/u;
const SBER_PURCHASE_TITLE_PATTERN = /^Покупка [\p{L}\p{M} .'-]+$/u;
const RUB_AMOUNT = /^(\d+)\.(\d{2})\s+RUB\b/i;
const TBANK_TOP_UP_BODY_PATTERN = /^Пополнение\s+на\s+(\d+)\s+₽,\s+счет\s+RUB\.\s+[\p{L}\p{M} .'-]+\s+Доступно\s+\d+(?:[\s\u00a0\u202f]\d{3})*,\d{2}\s+₽$/u;
const TBANK_DEBIT_PURCHASE_MARKER_PATTERN = /(?:покупк[а-яё]*|оплат[а-яё]*)/giu;
const TBANK_DEBIT_PURCHASE_REJECT_PATTERN = /(?:кредит|перевод|пополн|возврат|отмен|сняти|наличн|отказ|отклон|недостаточ|неуспеш|ошибк|не\s+(?:прош\p{L}*|выполн\p{L}*|проведен\p{L}*)|refund|transfer|cash withdrawal|top[ -]?up|declin\w*|reject\w*|fail\w*|cancel(?:led|ed|lation|ling|ing)|insufficient|not\s+(?:completed|successful|processed|approved|authorized))/iu;
const TBANK_MASKED_7268_PATTERN = /(?<![\p{L}\p{N}])\*{1,4}\s*7268(?!\d)/giu;
const TBANK_BALANCE_MARKER_PATTERN = /(?:баланс|остаток|доступно)/giu;
const TBANK_MONEY_PATTERN = /(?<![\p{L}\p{N}])(\d+(?:[ \u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?)[ \u00a0\u202f]*(RUB(?![\p{L}])|₽|руб(?:ль|ля|лей)?\.?(?![\p{L}]))/giu;
const ALFA_TITLE_PATTERN = /^-\s*(\d+)(?:,(\d{2}))?\s*₽$/u;
const ALFA_CARD_PURCHASE_TITLE_PATTERN = /^-\s*(\d+)(?:,(\d{2}))?\s+₽\.\s+(.+)$/u;
const ALFA_CARD_PURCHASE_BODY_PATTERN = /^([^:]+):\s*(\d+),(\d{2})\s+₽;\s+••\s*(\d{4})$/u;
const ALFA_CARD_PURCHASE_MERCHANT_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}\s.,'’"«»&()+/–—-]{0,79}$/u;
const ALFA_CARD_PURCHASE_REJECT_PATTERN = /(?:покупк|оплат|перевод|пополн|возврат|возмещ|отмен|аннулир|отклон|отказ|неуспеш|неудач|комисси|сняти|наличн|(?<![\p{L}\p{N}])(?:refund|transfer|top[ -]?up|cancel(?:led|ed|lation)?|declin(?:ed|e)|reject(?:ed)?|cash withdrawal|fee)(?![\p{L}\p{N}]))/iu;
const ALFA_CARD_PURCHASE_NORMALIZATION_VERSION = 'alfa-card-purchase-v1';
const OPAQUE_NOTIFICATION_LIFECYCLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALFA_F5_ACCOUNT_SECTION = /^[\p{L}\p{M}\d.'-]+\s+[\p{L}\p{M}\d.'-]+\s+счета\s+\d+\s*\*\s*(\d{4})$/u;
const ALFA_F5_AMOUNT_SECTION = /^Перевод\s+на\s+[\p{L}\p{M}\d.'-]+\s+(\d+,\d{2})\s+RUB$/u;
const ALFA_F5_RECIPIENT_SECTION = /^Получатель:\s+\d+\s*\*\s*\d{4}$/u;
const ALFA_F5_TRAILING_SECTION = /^\d+\s+[\p{L}\p{M}\d.'-]+\s+\d+:\d+$/u;
const SBER_PURCHASE_BODY_PATTERN = /^(\d+) ₽ — Баланс: (\d+,\d{2}) ₽ Счёт карты МИР •• (\d{4})$/u;
const YANDEX_PAY_TITLE_PATTERN = /^Карта [\p{L}\p{M} .'-]+$/u;
const YANDEX_PAY_BODY_PATTERN = /^Перевод [\p{L}\p{M} .'-]+\.\s+(\d+\.\d{2})\s+RUB\.\s+[\p{L}\p{M} .'-]+\.\s+\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}\.\s+Доступно\s+\d+\.\d{2}\s+RUB$/u;
const NON_MERCHANT_TITLE_PATTERN = /(?:^|[^\p{L}\p{N}])(?:покупка|оплата|перевод|пополнение|возврат|отмена|отклонено|отказ|недостаточно средств|сч[её]т|карта|баланс|доступно|руб(?:ль|ля|лей)?|RUB)(?=$|[^\p{L}\p{N}])|₽|••/iu;
const NON_MERCHANT_TITLE_VALUES = new Set([
  'покупка', 'оплата', 'перевод', 'входящий перевод', 'исходящий перевод',
  'пополнение', 'возврат', 'сбербанк', 'сбер', 'яндекс банк', 'альфа банк',
  'альфа-банк', 'т-банк', 'тинькофф', 'банк',
]);

function normalizeWhitespace(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizedAmount(value) {
  const match = normalizeWhitespace(value).match(RUB_AMOUNT);
  if (!match) return null;
  return `${match[1]}.${match[2]}`;
}

function merchantTitle(value) {
  if (typeof value !== 'string') return null;
  const merchant = value.trim();
  const normalized = normalizeWhitespace(merchant);
  if (normalized.length < 2 || normalized.length > 120) return null;
  if (!/[\p{L}\p{N}]/u.test(normalized)) return null;
  if (NON_MERCHANT_TITLE_VALUES.has(normalized.toLocaleLowerCase('ru-RU'))
      || NON_MERCHANT_TITLE_PATTERN.test(normalized)) return null;
  return merchant;
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
  const metadata = input.ingestionMetadata ?? {};
  const isConfirmedYandexBankNotification = metadata.adapter === ANDROID_NOTIFICATION_ADAPTER
    && metadata.schemaVersion === '1'
    && metadata.sourcePackage === YANDEX_PAY_SOURCE_PACKAGE
    && metadata.notificationChannel === YANDEX_PAY_NOTIFICATION_CHANNEL;

  if (!isPurchase && !isIncoming) return incomplete({ occurred, amount, hasCurrency, hasFinancialMarker });
  if (!amount || !occurred || !hasCurrency) return incomplete({ occurred, amount, hasCurrency, hasFinancialMarker: true });

  return {
    eventType: isPurchase ? 'PURCHASE' : 'INCOMING_TRANSFER',
    occurredAt: occurred,
    amount,
    currency: 'RUB',
    direction: isPurchase ? 'DEBIT' : 'CREDIT',
    merchant: isPurchase && isConfirmedYandexBankNotification ? merchantTitle(payload.title) : null,
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

export function normalizeYandexPayBankEvent(input) {
  const payload = input.payload ?? {};
  const title = normalizeWhitespace(payload.title);
  const description = normalizeWhitespace(payload.description);
  const text = normalizeWhitespace(payload.text);
  const occurred = occurredAt(input.eventTime);
  const match = title.match(YANDEX_PAY_TITLE_PATTERN)
    && description
    && text
    && description === text
    ? description.match(YANDEX_PAY_BODY_PATTERN)
    : null;

  if (!match || !occurred) return null;

  return {
    eventType: 'OUTGOING_TRANSFER',
    occurredAt: occurred,
    amount: match[1],
    currency: 'RUB',
    direction: 'DEBIT',
    merchant: null,
    counterparty: null,
    accountReference: null,
    accountReferenceKind: null,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: YANDEX_BANK_NORMALIZATION_VERSION,
  };
}

export function isYandexPayOutgoingTransport(input) {
  const metadata = input.ingestionMetadata ?? {};
  return metadata.provider === YANDEX_PROVIDER
    && metadata.adapter === ANDROID_NOTIFICATION_ADAPTER
    && metadata.schemaVersion === '1'
    && metadata.sourcePackage === YANDEX_PAY_SOURCE_PACKAGE
    && metadata.notificationChannel === YANDEX_PAY_NOTIFICATION_CHANNEL;
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

function tbankPurchaseAmount(value) {
  if (!/^\d{1,12}$/.test(value)) return null;
  const whole = BigInt(value);
  return whole > 0n ? `${whole}.00` : null;
}

function normalizeTbankDebitPurchase({ title, description, text, occurred }) {
  if (description && text && description !== text) return null;
  const body = description || text;
  const notificationEvidence = [title, text, description].filter(Boolean).join(' ');
  if (!body || TBANK_DEBIT_PURCHASE_REJECT_PATTERN.test(notificationEvidence)) return null;

  const purchaseMarkers = [...body.matchAll(TBANK_DEBIT_PURCHASE_MARKER_PATTERN)];
  const cardMasks = [...body.matchAll(TBANK_MASKED_7268_PATTERN)];
  const balanceMarkers = [...body.matchAll(TBANK_BALANCE_MARKER_PATTERN)];
  const money = [...body.matchAll(TBANK_MONEY_PATTERN)];
  if (purchaseMarkers.length !== 1 || cardMasks.length !== 1 || balanceMarkers.length !== 1 || money.length !== 2 || !occurred) return null;

  const [purchaseMarker] = purchaseMarkers;
  const [cardMask] = cardMasks;
  const [balanceMarker] = balanceMarkers;
  const [purchaseAmount, balanceAmount] = money;
  const permittedDigitSpans = [
    [purchaseAmount.index, purchaseAmount.index + purchaseAmount[0].length],
    [cardMask.index, cardMask.index + cardMask[0].length],
    [balanceAmount.index, balanceAmount.index + balanceAmount[0].length],
  ];
  const unaccountedDigits = [...body.matchAll(/\d+/g)].some((digits) =>
    !permittedDigitSpans.some(([start, end]) => digits.index >= start && digits.index + digits[0].length <= end));
  if (unaccountedDigits) return null;
  const purchaseAmountEnd = purchaseAmount.index + purchaseAmount[0].length;
  const cardMaskEnd = cardMask.index + cardMask[0].length;
  const balanceMarkerEnd = balanceMarker.index + balanceMarker[0].length;
  if (!(purchaseMarker.index < purchaseAmount.index
    && purchaseAmountEnd <= cardMask.index
    && cardMaskEnd <= balanceMarker.index
    && balanceMarkerEnd <= balanceAmount.index)) return null;

  const amount = tbankPurchaseAmount(purchaseAmount[1]);
  if (!amount) return null;
  return {
    eventType: 'PURCHASE',
    occurredAt: occurred,
    amount,
    currency: 'RUB',
    direction: 'DEBIT',
    merchant: null,
    counterparty: null,
    accountReference: '****7268',
    accountReferenceKind: 'MASKED_CARD',
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: TBANK_DEBIT_PURCHASE_NORMALIZATION_VERSION,
  };
}

export function normalizeTbankBankEvent(input, { enableDebitPurchaseParser = false } = {}) {
  const payload = input.payload ?? {};
  const body = normalizeWhitespace(payload.description) || normalizeWhitespace(payload.text);
  const description = normalizeWhitespace(payload.description);
  const text = normalizeWhitespace(payload.text);
  const title = normalizeWhitespace(payload.title);
  const occurred = occurredAt(input.eventTime);
  const match = body.match(TBANK_TOP_UP_BODY_PATTERN);
  const hasFinancialMarker = body.startsWith('Пополнение на ')
    || /(?:покупк|оплат|перевод|пополн|возврат|сняти)/iu.test(body);

  if (match && occurred) {
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

  if (enableDebitPurchaseParser) {
    const purchase = normalizeTbankDebitPurchase({ title, description, text, occurred });
    if (purchase) return purchase;
  }
  return incompleteTbank({ occurred, hasFinancialMarker });
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

function exactAlfaCardPurchase({ occurred, amount, merchant }) {
  return {
    eventType: 'PURCHASE',
    occurredAt: occurred,
    amount,
    currency: 'RUB',
    direction: 'DEBIT',
    merchant,
    counterparty: null,
    accountReference: '****5580',
    accountReferenceKind: 'MASKED_CARD',
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    normalizationVersion: ALFA_CARD_PURCHASE_NORMALIZATION_VERSION,
  };
}

function alfaCardPurchaseMerchant(value) {
  const merchant = normalizeWhitespace(value).normalize('NFC');
  if (!merchant || !ALFA_CARD_PURCHASE_MERCHANT_PATTERN.test(merchant)) return null;
  if (!merchantTitle(merchant) || ALFA_CARD_PURCHASE_REJECT_PATTERN.test(merchant)) return null;
  return merchant;
}

function normalizeAlfaCardPurchase(input, occurred) {
  const metadata = input.ingestionMetadata ?? {};
  if (metadata.sourcePackage !== ALFA_PROVIDER
    || !OPAQUE_NOTIFICATION_LIFECYCLE_ID.test(metadata.notificationLifecycleId ?? '')) return null;
  const payload = input.payload ?? {};
  const title = normalizeWhitespace(payload.title);
  const description = normalizeWhitespace(payload.description);
  const text = normalizeWhitespace(payload.text);
  if (!occurred || !description || description !== text) return null;
  const titleMatch = title.match(ALFA_CARD_PURCHASE_TITLE_PATTERN);
  const bodyMatch = description.match(ALFA_CARD_PURCHASE_BODY_PATTERN);
  if (!titleMatch || !bodyMatch || bodyMatch[4] !== '5580') return null;
  const titleMerchant = alfaCardPurchaseMerchant(titleMatch[3]);
  const bodyMerchant = alfaCardPurchaseMerchant(bodyMatch[1]);
  if (!titleMerchant || !bodyMerchant) return null;
  const merchantKey = (value) => value.normalize('NFC').toLocaleLowerCase('ru-RU');
  if (merchantKey(titleMerchant) !== merchantKey(bodyMerchant)) return null;
  const titleAmount = `${titleMatch[1].replace(/^0+(?=\d)/u, '')}.${titleMatch[2] ?? '00'}`;
  const bodyAmount = `${bodyMatch[2].replace(/^0+(?=\d)/u, '')}.${bodyMatch[3]}`;
  if (titleAmount !== bodyAmount || titleAmount === '0.00') return null;
  return exactAlfaCardPurchase({ occurred, amount: titleAmount, merchant: titleMerchant });
}

export function normalizeAlfaBankEvent(input) {
  const payload = input.payload ?? {};
  const title = normalizeWhitespace(payload.title);
  const body = normalizeWhitespace(payload.description) || normalizeWhitespace(payload.text);
  const occurred = occurredAt(input.eventTime);
  const cardPurchase = normalizeAlfaCardPurchase(input, occurred);
  if (cardPurchase) return cardPurchase;
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

function normalizeSberPurchase({ occurred, amount, accountReference }) {
  return {
    eventType: 'PURCHASE',
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
    normalizationVersion: SBER_BANK_NORMALIZATION_VERSION,
  };
}

export function normalizeSberBankEvent(input) {
  const payload = input.payload ?? {};
  const title = normalizeWhitespace(payload.title);
  const description = normalizeWhitespace(payload.description);
  const text = normalizeWhitespace(payload.text);
  const body = description || text;
  const occurred = occurredAt(input.eventTime);

  if (SBER_PURCHASE_TITLE_PATTERN.test(title)) {
    const purchaseMatch = description && text && description === text
      ? description.match(SBER_PURCHASE_BODY_PATTERN)
      : null;
    if (!purchaseMatch || !occurred) {
      return incompleteSber({ occurred, hasIncomingMarker: true, hasCurrency: body.includes('₽'), amount: null });
    }
    const normalized = normalizeSberPurchase({
      occurred,
      amount: `${purchaseMatch[1]}.00`,
      accountReference: purchaseMatch[3],
    });
    return { ...normalized, merchant: merchantTitle(title.slice('Покупка '.length)) };
  }

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

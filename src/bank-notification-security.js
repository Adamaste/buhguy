const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/gu;

const OTP_LANGUAGE = [
  /одноразов\p{L}*\s+(?:код|парол)\p{L}*/iu,
  /(?:код|парол)\p{L}*\s+(?:для\s+)?(?:подтвержден|авторизац|верификац|безопасност)\p{L}*/iu,
  /(?:код|парол)\p{L}*\s+(?:из\s+)?(?:смс|sms)\b/iu,
  /\b(?:otp|sms\s+(?:verification\s+)?code|confirmation\s+code|verification\s+code|authentication\s+code|authorization\s+code|security\s+code|one[-\s]?time\s+(?:code|password|passcode))\b/iu,
  /(?:никому\s+не\s+(?:сообщайте|передавайте|называйте)|не\s+(?:сообщайте|передавайте|называйте)\s+(?:этот\s+)?(?:код|парол)\w*)/iu,
  /\b(?:do\s+not|never)\s+(?:share|tell|disclose)\s+(?:this\s+)?(?:code|password)\b/iu,
];

const CODE_WITH_SHORT_NUMBER = /(?:^|[^\p{L}\p{N}])(?:(?:код|парол)\p{L}*|code|password)\s*(?::|№|#|-)?\s*(?:\s+)?\d{4,8}(?=$|[^\p{L}\p{N}])/iu;
const NON_AUTH_REFERENCE_PREFIX = /(?:operation|transaction|reference|mcc|merchant|shop|store|order|purchase|операц\p{L}*|транзакц\p{L}*|ссылк\p{L}*|магазин\p{L}*|заказ\p{L}*)\s*$/iu;
const BARE_SHORT_CODE = /^\s*\d{4,8}\s*$/u;

function normalizeText(value) {
  return value
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function hasUnqualifiedShortCode(text) {
  const match = CODE_WITH_SHORT_NUMBER.exec(text);
  if (!match) return false;
  const prefix = text.slice(0, match.index);
  return !NON_AUTH_REFERENCE_PREFIX.test(prefix);
}

/** Returns only a boolean; raw notification text is never exposed by this module. */
export function containsSensitiveAuthorizationContent(values, { rejectBareShortCode = false } = {}) {
  const texts = [...values]
    .filter((value) => typeof value === 'string')
    .map(normalizeText);

  for (const text of texts) {
    if (OTP_LANGUAGE.some((pattern) => pattern.test(text))) return true;
    if (rejectBareShortCode && BARE_SHORT_CODE.test(text)) return true;
    if (hasUnqualifiedShortCode(text)) return true;
  }
  return false;
}

export const SENSITIVE_AUTH_NOTIFICATION_CODE = 'SENSITIVE_AUTH_NOTIFICATION';

export function sensitiveAuthorizationNotificationError() {
  const error = new Error('Sensitive authorization notification rejected');
  error.code = SENSITIVE_AUTH_NOTIFICATION_CODE;
  return error;
}

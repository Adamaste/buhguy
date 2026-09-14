import crypto from 'node:crypto';

// Prefix of the reviewed FNS machine code, kept as a safe signature.
export const KNOWN_DETAIL_UNAVAILABLE_CODE_SHA256_PREFIX = '2310e8ad3121522f';
export const DETAIL_UNAVAILABLE_MESSAGE = 'сервис получения чеков временно недоступен';

function normalizedMessage(error) {
  return String(error?.message ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function detailErrorSignature(error) {
  return crypto.createHash('sha256')
    .update(`${Number(error?.status ?? 0)}|${String(error?.code ?? '')}|${normalizedMessage(error)}`)
    .digest('hex');
}

export function isKnownFnsDetailUnavailable(error, { codeSha256Prefix = KNOWN_DETAIL_UNAVAILABLE_CODE_SHA256_PREFIX } = {}) {
  const message = normalizedMessage(error);
  const code = String(error?.code ?? '');
  if (Number(error?.status) !== 422 || !code || !message.includes(DETAIL_UNAVAILABLE_MESSAGE)) return false;
  return crypto.createHash('sha256').update(code).digest('hex').startsWith(codeSha256Prefix);
}

export function safeDetailErrorFields(error) {
  return {
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
    errorCode: String(error?.code ?? '').slice(0, 128) || null,
    errorSignature: detailErrorSignature(error),
  };
}

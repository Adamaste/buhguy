export const FNS_RECEIPT_CURRENCY_MODEL_VERSION = 'fns-receipt-currency-v1';

export const FNS_RECEIPT_CURRENCY_STATUSES = Object.freeze({
  RESOLVED: 'RESOLVED',
  CONFLICT: 'CONFLICT',
  UNRESOLVED: 'UNRESOLVED',
});

const VALID_CURRENCY = /^[A-Z]{3}$/;

function normalizeExplicitCurrency(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return { value: null, reasonCode: 'INVALID_EXPLICIT_CURRENCY' };
  const normalized = value.trim().toUpperCase();
  if (!VALID_CURRENCY.test(normalized)) return { value: null, reasonCode: 'INVALID_EXPLICIT_CURRENCY' };
  return { value: normalized, reasonCode: null };
}

export function resolveFnsReceiptCurrency({ explicitCurrency = null, fnsSourceProven = false } = {}) {
  const explicit = normalizeExplicitCurrency(explicitCurrency);
  const base = { modelVersion: FNS_RECEIPT_CURRENCY_MODEL_VERSION, sourceFamily: fnsSourceProven === true ? 'FNS_FISCAL_RECEIPT' : 'UNPROVEN_SOURCE' };
  if (explicit?.reasonCode) return { ...base, status: FNS_RECEIPT_CURRENCY_STATUSES.CONFLICT, currency: null, basis: 'EXPLICIT_INVALID', reasonCode: explicit.reasonCode };
  if (explicit?.value && explicit.value !== 'RUB') return { ...base, status: FNS_RECEIPT_CURRENCY_STATUSES.CONFLICT, currency: null, basis: 'EXPLICIT_CONTRADICTORY', reasonCode: 'EXPLICIT_NON_RUB_CURRENCY' };
  if (explicit?.value === 'RUB') return { ...base, status: FNS_RECEIPT_CURRENCY_STATUSES.RESOLVED, currency: 'RUB', basis: 'EXPLICIT_PAYLOAD', reasonCode: 'EXPLICIT_RUB' };
  if (fnsSourceProven === true) return { ...base, status: FNS_RECEIPT_CURRENCY_STATUSES.RESOLVED, currency: 'RUB', basis: 'FNS_SOURCE_CONTRACT', reasonCode: 'FNS_FISCAL_AMOUNTS_ARE_RUBLES' };
  return { ...base, status: FNS_RECEIPT_CURRENCY_STATUSES.UNRESOLVED, currency: null, basis: 'SOURCE_UNPROVEN', reasonCode: 'FNS_SOURCE_NOT_PROVEN' };
}

import { createHash } from 'node:crypto';

export const FISCAL_IDENTITY_FIELDS = [
  'fiscalDriveNumber',
  'fiscalDocumentNumber',
  'fiscalSign',
];

// These are transport/observation fields, not fiscal evidence. The list is
// intentionally small and explicit so a new field is never ignored silently.
export const TRANSIENT_CONTENT_KEYS = new Set([
  'receivedAt',
  'received_at',
  'rawUpdatedAt',
  'raw_updated_at',
  'requestId',
  'request_id',
  'requestNumber',
  'request_number',
  'session',
  'headers',
  'auth',
]);

function canonicalize(value, key = null) {
  if (key && TRANSIENT_CONTENT_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((childKey) => [childKey, canonicalize(value[childKey], childKey)])
      .filter(([, childValue]) => childValue !== undefined),
  );
}

export function canonicalizeFiscalContent(payload) {
  return canonicalize(payload);
}

export function fiscalContentFingerprint(payload) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeFiscalContent(payload)))
    .digest('hex');
}

export function fiscalIdentityFromRaw(raw) {
  const values = Object.fromEntries(FISCAL_IDENTITY_FIELDS.map((field) => {
    const value = raw?.[field];
    return [field, value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim()];
  }));
  return values;
}

export function hasCompleteFiscalIdentity(identity) {
  return FISCAL_IDENTITY_FIELDS.every((field) => identity[field] !== null);
}

export function fiscalIdentityKey(identity) {
  if (!hasCompleteFiscalIdentity(identity)) return null;
  return FISCAL_IDENTITY_FIELDS.map((field) => identity[field]).join('|');
}

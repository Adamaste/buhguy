import crypto from 'node:crypto';
import {
  containsSensitiveAuthorizationContent,
  SENSITIVE_AUTH_NOTIFICATION_CODE,
  sensitiveAuthorizationNotificationError,
} from './bank-notification-security.js';
import { isAlfaBankAndroidNotification, isSberBankAndroidNotification, isTbankBankAndroidNotification, isYandexBankProvider, isYandexPayOutgoingTransport, normalizeAlfaBankEvent, normalizeSberBankEvent, normalizeTbankBankEvent, normalizeYandexBankEvent, normalizeYandexPayBankEvent } from './bank-normalization.js';
import { resolveNewBankTransactionIdentity } from './bank-account-resolution.js';

export const BANK_NORMALIZATION_VERSION = 'bank-normalizer-v1';
export const TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV = 'TBANK_DEBIT_PURCHASE_PARSER_ENABLED';
const SOURCE_TYPES = new Set(['ANDROID_NOTIFICATION', 'BANK_API', 'MANUAL_IMPORT']);
const DIRECTIONS = new Set(['DEBIT', 'CREDIT', 'UNKNOWN']);
const PAYLOAD_KEYS = new Set(['amount', 'currency', 'direction', 'merchant', 'counterparty', 'accountReference', 'accountReferenceKind', 'occurredAt', 'description', 'title', 'text', 'eventType', 'reference']);
const METADATA_KEYS = new Set(['adapter', 'provider', 'deviceType', 'schemaVersion', 'sourcePackage', 'notificationChannel', 'notificationLifecycleId']);
const SECRET_KEY = /(token|cookie|password|secret|authorization|credential|session|private.?key)/i;
const MAX_SCALAR_LENGTH = 4096;
const MAX_PAYLOAD_BYTES = 16 * 1024;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalBankJson(value) {
  return JSON.stringify(stableValue(value));
}

export function bankPayloadSha256(payload) {
  return sha256(canonicalBankJson(payload));
}

function asIsoDate(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function validateObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  for (const key of Object.keys(value)) if (SECRET_KEY.test(key)) throw new Error(`${field} contains prohibited secret field`);
}

function validatePayload(payload) {
  validateObject(payload, 'payload');
  for (const key of Object.keys(payload)) {
    if (!PAYLOAD_KEYS.has(key)) throw new Error(`payload field is not allowed: ${key}`);
    if (payload[key] !== null && typeof payload[key] !== 'string' && typeof payload[key] !== 'number') throw new Error(`payload field must be scalar: ${key}`);
    if (typeof payload[key] === 'string' && payload[key].length > MAX_SCALAR_LENGTH) throw new Error(`payload field is too long: ${key}`);
  }
  if (Buffer.byteLength(canonicalBankJson(payload), 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('payload is too large');
  return payload;
}

function validateMetadata(metadata = {}) {
  validateObject(metadata, 'ingestionMetadata');
  for (const key of Object.keys(metadata)) {
    if (!METADATA_KEYS.has(key)) throw new Error(`ingestionMetadata field is not allowed: ${key}`);
    if (metadata[key] !== null && typeof metadata[key] !== 'string') throw new Error(`ingestionMetadata field must be text: ${key}`);
    if (typeof metadata[key] === 'string' && metadata[key].length > MAX_SCALAR_LENGTH) throw new Error(`ingestionMetadata field is too long: ${key}`);
  }
  if (metadata.notificationLifecycleId != null
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metadata.notificationLifecycleId)) {
    throw new Error('ingestionMetadata.notificationLifecycleId must be an opaque UUID');
  }
  return metadata;
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value.toFixed(2);
  if (typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value)) return Number(value).toFixed(2);
  return null;
}

export function normalizeBankEvent(input, { enableTbankDebitPurchaseParser = false } = {}) {
  if (isYandexPayOutgoingTransport(input)) {
    const outgoing = normalizeYandexPayBankEvent(input);
    if (outgoing) return outgoing;
  }
  if (isYandexBankProvider(input)) return normalizeYandexBankEvent(input);
  if (isSberBankAndroidNotification(input)) return normalizeSberBankEvent(input);
  if (isTbankBankAndroidNotification(input)) {
    return normalizeTbankBankEvent(input, { enableDebitPurchaseParser: enableTbankDebitPurchaseParser === true });
  }
  if (isAlfaBankAndroidNotification(input)) return normalizeAlfaBankEvent(input) ?? normalizeGenericBankEvent(input);
  return normalizeGenericBankEvent(input);
}

function normalizeGenericBankEvent(input) {
  const payload = input.payload;
  const amount = normalizeAmount(payload.amount);
  const currency = typeof payload.currency === 'string' && /^[A-Z]{3}$/.test(payload.currency) ? payload.currency : null;
  const direction = DIRECTIONS.has(payload.direction) ? payload.direction : 'UNKNOWN';
  const occurredAt = asIsoDate(input.eventTime ?? payload.occurredAt, 'eventTime');
  const complete = amount !== null && currency !== null && occurredAt !== null && direction !== 'UNKNOWN';
  const partial = amount !== null || currency !== null || occurredAt !== null || payload.merchant || payload.counterparty;
  return {
    occurredAt,
    amount,
    currency,
    direction,
    merchant: payload.merchant ?? null,
    counterparty: payload.counterparty ?? null,
    accountReference: payload.accountReference ?? null,
    accountReferenceKind: payload.accountReferenceKind ?? null,
    eventType: 'UNKNOWN',
    normalizationStatus: complete ? 'READY' : partial ? 'PARTIAL' : 'UNKNOWN',
    evidenceQuality: complete ? 'EXACT' : partial ? 'PARTIAL' : 'INSUFFICIENT',
    normalizationVersion: BANK_NORMALIZATION_VERSION,
  };
}

export function validateBankEventInput(input) {
  validateObject(input, 'bank event');
  if (typeof input.sourceKey !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(input.sourceKey)) throw new Error('sourceKey is required and must be a safe identifier');
  if (input.sourceEventId != null && (typeof input.sourceEventId !== 'string' || input.sourceEventId.length > 512)) throw new Error('sourceEventId must be text up to 512 characters');
  const observedAt = asIsoDate(input.observedAt, 'observedAt', { required: true });
  const eventTime = asIsoDate(input.eventTime, 'eventTime');
  const payload = validatePayload(input.payload);
  const ingestionMetadata = validateMetadata(input.ingestionMetadata ?? {});
  const stringValues = [input.sourceKey, input.sourceEventId, input.observedAt, input.eventTime,
    ...Object.values(payload), ...Object.values(ingestionMetadata)];
  const mappedTextValues = ['title', 'text', 'description', 'reference'].map((key) => payload[key]);
  if (containsSensitiveAuthorizationContent(stringValues)
      || containsSensitiveAuthorizationContent(mappedTextValues, { rejectBareShortCode: true })) {
    throw sensitiveAuthorizationNotificationError();
  }
  return { sourceKey: input.sourceKey, sourceEventId: input.sourceEventId ?? null, observedAt, eventTime, payload, ingestionMetadata };
}

export async function createBankSource(pool, { sourceKey, sourceType, displayName, enabled = true }) {
  if (!SOURCE_TYPES.has(sourceType)) throw new Error('Unsupported bank source type');
  if (typeof sourceKey !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(sourceKey)) throw new Error('sourceKey is required and must be a safe identifier');
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 200) throw new Error('displayName is required');
  const result = await pool.query(`INSERT INTO bank_sources(source_key,source_type,display_name,enabled) VALUES($1,$2,$3,$4)
    ON CONFLICT(source_key) DO UPDATE SET display_name=EXCLUDED.display_name,source_type=EXCLUDED.source_type,enabled=EXCLUDED.enabled,updated_at=NOW()
    RETURNING id,source_key,source_type,display_name,enabled`, [sourceKey, sourceType, displayName.trim(), Boolean(enabled)]);
  return result.rows[0];
}

export async function linkBankSourcePerson(pool, { sourceKey, personId, relationType = 'OWNER' }) {
  if (!Number.isInteger(Number(personId)) || Number(personId) < 1) throw new Error('personId is required');
  const source = (await pool.query('SELECT id FROM bank_sources WHERE source_key=$1', [sourceKey])).rows[0];
  if (!source) throw new Error('Bank source was not found');
  await pool.query(`INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [source.id, personId, relationType]);
}

export async function ingestBankEvent(pool, input) {
  const event = validateBankEventInput(input);
  const source = (await pool.query('SELECT id,enabled FROM bank_sources WHERE source_key=$1', [event.sourceKey])).rows[0];
  if (!source) return { status: 'rejected', code: 'UNKNOWN_SOURCE' };
  if (!source.enabled) return { status: 'rejected', code: 'SOURCE_DISABLED' };
  const payloadJson = canonicalBankJson(event.payload);
  const payloadSha256 = sha256(payloadJson);
  const dedupMaterial = event.sourceEventId
    ? `${event.sourceKey}\0event:${event.sourceEventId}`
    : `${event.sourceKey}\0payload:${payloadSha256}\0event:${event.eventTime ?? ''}`;
  const dedupKey = sha256(dedupMaterial);
  const normalized = normalizeBankEvent(event, {
    enableTbankDebitPurchaseParser: process.env[TBANK_DEBIT_PURCHASE_PARSER_ENABLED_ENV] === 'true',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id,payload_sha256 FROM bank_event_observations WHERE bank_source_id=$1 AND dedup_key=$2', [source.id, dedupKey]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      if (existing.rows[0].payload_sha256 !== payloadSha256) return { status: 'rejected', code: 'SOURCE_EVENT_CONFLICT' };
      return { status: 'duplicate', observationId: Number(existing.rows[0].id) };
    }
    const observation = (await client.query(`INSERT INTO bank_event_observations(bank_source_id,source_event_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) RETURNING id`, [source.id, event.sourceEventId, dedupKey, event.observedAt, event.eventTime, payloadJson, payloadSha256, canonicalBankJson(event.ingestionMetadata)])).rows[0];
    const transaction = (await client.query(`INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,merchant,counterparty,account_reference,account_reference_kind,event_type,normalization_status,normalization_version,evidence_quality)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [observation.id, normalized.occurredAt, normalized.amount, normalized.currency, normalized.direction, normalized.merchant, normalized.counterparty, normalized.accountReference, normalized.accountReferenceKind, normalized.eventType, normalized.normalizationStatus, normalized.normalizationVersion, normalized.evidenceQuality])).rows[0];
    const identityResolution = await resolveNewBankTransactionIdentity(client, { bankTransactionId: transaction.id });
    await client.query('COMMIT');
    return { status: 'created', observationId: Number(observation.id), transactionId: Number(transaction.id), normalization: normalized, identityResolution };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      const persisted = await client.query('SELECT id,payload_sha256 FROM bank_event_observations WHERE bank_source_id=$1 AND dedup_key=$2', [source.id, dedupKey]);
      if (!persisted.rowCount) throw error;
      if (persisted.rows[0].payload_sha256 !== payloadSha256) return { status: 'rejected', code: 'SOURCE_EVENT_CONFLICT' };
      return { status: 'duplicate', observationId: Number(persisted.rows[0].id) };
    }
    throw error;
  } finally { client.release(); }
}

export async function resolveBankObservationAccountingScope(pool, { bankSourceId, observationId } = {}) {
  const sourceId = Number(bankSourceId);
  const eventId = Number(observationId);
  if (!Number.isSafeInteger(sourceId) || sourceId < 1 || !Number.isSafeInteger(eventId) || eventId < 1) {
    return { status: 'BLOCKED', reasonCode: 'BANK_EVENT_SCOPE_IDENTITY_INVALID' };
  }
  const result = await pool.query(`SELECT DISTINCT s.scope_key
    FROM bank_event_observations o
    JOIN bank_sources b ON b.id=o.bank_source_id
    JOIN bank_source_person sp ON sp.bank_source_id=b.id AND sp.relation_type='OWNER'
    JOIN persons p ON p.id=sp.person_id
    JOIN accounting_scopes s ON s.id=p.scope_id
    WHERE o.id=$1 AND o.bank_source_id=$2`, [eventId, sourceId]);
  if (result.rows.length === 0) return { status: 'BLOCKED', reasonCode: 'BANK_EVENT_SCOPE_UNRESOLVED' };
  if (result.rows.length !== 1 || typeof result.rows[0].scope_key !== 'string' || !result.rows[0].scope_key.trim()) {
    return { status: 'BLOCKED', reasonCode: 'BANK_EVENT_SCOPE_AMBIGUOUS' };
  }
  return { status: 'RESOLVED', scopeKey: result.rows[0].scope_key };
}

export function createBankIngestionHandler({ pool }) {
  return async (request) => {
    const input = request?.body ?? request;
    try {
      validateBankEventInput(input);
    } catch (error) {
      if (error?.code === SENSITIVE_AUTH_NOTIFICATION_CODE) {
        return { status: 'rejected', code: SENSITIVE_AUTH_NOTIFICATION_CODE };
      }
      return { status: 'rejected', code: 'INVALID_EVENT' };
    }
    return ingestBankEvent(pool, input);
  };
}

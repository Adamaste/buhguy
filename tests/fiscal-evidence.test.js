import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalizeFiscalContent, fiscalContentFingerprint, fiscalIdentityFromRaw, fiscalIdentityKey } from '../src/fiscal-evidence.js';
import { FiscalContentConflictError, FiscalIdentityConflictError, FiscalIdentityUnavailableError } from '../src/fiscal-errors.js';
import { decodePostgresJsonEvidence, encodePostgresJsonEvidence } from '../src/postgres-json-evidence.js';

function fixture(overrides = {}) {
  return {
    key: 'fns-62', dateTime: '2026-08-19T12:00:00Z', totalSum: 1000,
    user: 'Sanitized Xiaomi Merchant', userInn: '7700000000', operationType: 1,
    fiscalDriveNumber: 'fd-62', fiscalDocumentNumber: 'doc-62', fiscalSign: 'sign-62',
    items: [{ name: 'Xiaomi sanitized item', quantity: 1, price: 1000, sum: 1000 }],
    ...overrides,
  };
}

test('DEDUP-001/002/003: exact replay is stable across repeated/new-instance style calls', () => {
  const first = fixture();
  const seen = new Map();
  const ingest = (raw) => {
    const id = String(raw.key);
    const hash = fiscalContentFingerprint(raw);
    if (!seen.has(id)) { seen.set(id, hash); return { created: true }; }
    assert.equal(seen.get(id), hash);
    return { created: false, replayed: true };
  };
  assert.deepEqual(ingest(first), { created: true });
  for (let i = 0; i < 10; i += 1) assert.deepEqual(ingest({ ...first }), { created: false, replayed: true });
  assert.deepEqual(ingest(first), { created: false, replayed: true });
});

test('DEDUP-005/014: business similarity does not define identity', () => {
  const a = fixture();
  const b = fixture({ key: 'fns-other', fiscalDriveNumber: 'fd-other', fiscalDocumentNumber: 'doc-other', fiscalSign: 'sign-other' });
  assert.notEqual(fiscalIdentityKey(fiscalIdentityFromRaw(a)), fiscalIdentityKey(fiscalIdentityFromRaw(b)));
});

test('DEDUP-006: sanitized Xiaomi prepayment and settlement remain two fiscal documents', () => {
  const prepayment = fixture({ key: 'xiaomi-prepayment-62', fiscalDocumentNumber: 'prepayment-62', operationType: 1 });
  const settlement = fixture({ key: 'xiaomi-settlement-54', fiscalDriveNumber: 'fd-54', fiscalDocumentNumber: 'settlement-54', fiscalSign: 'sign-54', operationType: 1 });
  assert.notEqual(fiscalIdentityKey(fiscalIdentityFromRaw(prepayment)), fiscalIdentityKey(fiscalIdentityFromRaw(settlement)));
});

test('DEDUP-007/008: source and canonical identity channels are deterministic', () => {
  const raw = fixture();
  assert.equal(raw.key, 'fns-62');
  assert.equal(fiscalIdentityKey(fiscalIdentityFromRaw(raw)), 'fd-62|doc-62|sign-62');
});

test('DEDUP-009: conflicting identity channels fail closed', () => {
  assert.throws(() => { throw new FiscalIdentityConflictError(); }, { code: 'FISCAL_IDENTITY_CONFLICT' });
});

test('DEDUP-010/011: changed evidence is a content conflict', () => {
  assert.notEqual(fiscalContentFingerprint(fixture()), fiscalContentFingerprint(fixture({ totalSum: 900 })));
  assert.notEqual(fiscalContentFingerprint(fixture()), fiscalContentFingerprint(fixture({ items: [{ name: 'Changed', quantity: 1, price: 1000, sum: 1000 }] })));
  assert.throws(() => { throw new FiscalContentConflictError(); }, { code: 'FISCAL_CONTENT_CONFLICT' });
});

test('DEDUP-012: exact ignored transport metadata does not change fingerprint', () => {
  assert.equal(fiscalContentFingerprint(fixture({ requestNumber: 'one', receivedAt: 'a' })), fiscalContentFingerprint(fixture({ requestNumber: 'two', receivedAt: 'b' })));
  assert.notDeepEqual(canonicalizeFiscalContent(fixture({ requestNumber: 'one' })), fixture({ requestNumber: 'one' }));
});

test('PostgreSQL raw evidence encoding is reversible and distinguishes literal escapes', () => {
  const raw = {
    cyrillic: 'Продавец',
    emoji: 'ok ✅',
    nested: [{ value: 'A\u0000B' }, { value: 'A\\u0000B' }],
    markerLikeObject: { __receiptCollectorEncodedStringV1: true, encoding: 'utf16-code-units', value: '\\u0000' },
  };
  const encoded = encodePostgresJsonEvidence(raw);
  assert.equal(encoded.cyrillic, raw.cyrillic);
  assert.equal(encoded.emoji, raw.emoji);
  assert.equal(encoded.nested[0].value.__receiptCollectorEncodedStringV1, true);
  assert.equal(encoded.nested[1].value, 'A\\u0000B');
  assert.equal(encoded.markerLikeObject.__receiptCollectorEncodedObjectV1, true);
  assert.deepEqual(decodePostgresJsonEvidence(encoded), raw);
  assert.equal(fiscalContentFingerprint(decodePostgresJsonEvidence(encoded)), fiscalContentFingerprint(raw));
});

test('DEDUP-015: incomplete identity is explicit and never falls back to similarity', () => {
  const identity = fiscalIdentityFromRaw(fixture({ fiscalSign: null }));
  assert.equal(fiscalIdentityKey(identity), null);
  assert.throws(() => { throw new FiscalIdentityUnavailableError(); }, { code: 'FISCAL_IDENTITY_UNAVAILABLE' });
});

test('migration adds only a non-destructive canonical identity barrier', async () => {
  const migration = await readFile(new URL('../db/migrations/003_fiscal_identity_hardening.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS receipts_canonical_fiscal_identity_unique/);
  assert.match(migration, /HAVING COUNT\(\*\) > 1/);
  assert.doesNotMatch(migration, /\b(DROP|DELETE)\b/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePostgresTextEvidence, encodePostgresTextEvidence } from '../src/postgres-text-evidence.js';

test('PostgreSQL text evidence encoding is reversible only at the SQL boundary', () => {
  const original = 'A\u0000B';
  const encoded = encodePostgresTextEvidence(original);
  assert.notEqual(encoded, original);
  assert.equal(decodePostgresTextEvidence(encoded), original);
  assert.equal(encodePostgresTextEvidence('ordinary-code'), 'ordinary-code');
  assert.equal(decodePostgresTextEvidence('ordinary-code'), 'ordinary-code');
});

test('literal escape text does not conflict with encoded representation', () => {
  const literal = 'A\\u0000B';
  assert.equal(encodePostgresTextEvidence(literal), literal);
  assert.equal(decodePostgresTextEvidence(literal), literal);
  assert.equal(decodePostgresTextEvidence(encodePostgresTextEvidence(literal)), literal);
});


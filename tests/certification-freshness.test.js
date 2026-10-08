import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CERTIFICATION_FRESHNESS_MODEL,
  CERTIFICATION_FRESHNESS_STATUS,
  classifyCertificationFreshness,
} from '../src/certification-freshness.js';

test('freshness classification exposes READY, STALE, MISSING, CONFLICT and CORRUPT without false READY', () => {
  const base = { id: 7, status: 'READY', source_state_key: 'old', finished_at: '2026-01-01T00:00:00Z' };
  assert.deepEqual(classifyCertificationFreshness({
    reader: { ok: true, status: 'READY', snapshot: { runId: 8 } }, exactRuns: [{ ...base, source_state_key: 'current' }], previousReadyRun: base,
  }).status, CERTIFICATION_FRESHNESS_STATUS.READY);
  assert.equal(classifyCertificationFreshness({ reader: { ok: false, reasonCode: 'NO_CURRENT_CERTIFICATION' }, exactRuns: [], previousReadyRun: base }).status, CERTIFICATION_FRESHNESS_STATUS.STALE);
  assert.equal(classifyCertificationFreshness({ reader: { ok: false, reasonCode: 'NO_CURRENT_CERTIFICATION' }, exactRuns: [], previousReadyRun: null }).status, CERTIFICATION_FRESHNESS_STATUS.MISSING);
  assert.equal(classifyCertificationFreshness({ reader: { ok: false, reasonCode: 'CERTIFICATION_CONFLICT' }, exactRuns: [base, { ...base, id: 8 }], previousReadyRun: base }).status, CERTIFICATION_FRESHNESS_STATUS.CONFLICT);
  assert.equal(classifyCertificationFreshness({ reader: { ok: false, reasonCode: 'NO_CURRENT_CERTIFICATION' }, exactRuns: [{ ...base, status: 'RUNNING', source_state_key: 'current' }], previousReadyRun: null }).status, CERTIFICATION_FRESHNESS_STATUS.CORRUPT);
  assert.equal(classifyCertificationFreshness({ reader: { ok: false, reasonCode: 'CORRUPT_SNAPSHOT' }, exactRuns: [base], previousReadyRun: null }).status, CERTIFICATION_FRESHNESS_STATUS.CORRUPT);
});

test('freshness module has a safe machine-readable contract and no data mutation SQL', () => {
  const source = readFileSync(new URL('../src/certification-freshness.js', import.meta.url), 'utf8');
  assert.match(source, new RegExp(CERTIFICATION_FRESHNESS_MODEL));
  for (const status of Object.values(CERTIFICATION_FRESHNESS_STATUS)) assert.match(source, new RegExp(status));
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
  assert.match(source, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(source, /SET LOCAL statement_timeout/);
  assert.match(source, /SET LOCAL lock_timeout/);
  assert.match(source, /ROLLBACK/);
});

test('technical and timeout failures never become READY', () => {
  assert.equal(classifyCertificationFreshness({ reader: { ok: false, reasonCode: 'READ_ONLY_PROBE_ERROR' }, exactRuns: [], previousReadyRun: null }).status, CERTIFICATION_FRESHNESS_STATUS.MISSING);
  assert.equal(CERTIFICATION_FRESHNESS_STATUS.TECHNICAL_ERROR, 'TECHNICAL_ERROR');
});

test('connection and lock timeout failures have safe technical outcomes', async () => {
  const unavailablePool = { connect: async () => { throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' }); } };
  const { inspectCertificationFreshness } = await import('../src/certification-freshness.js');
  const unavailable = await inspectCertificationFreshness(unavailablePool);
  assert.deepEqual(
    { status: unavailable.status, reasonCode: unavailable.reasonCode },
    { status: CERTIFICATION_FRESHNESS_STATUS.TECHNICAL_ERROR, reasonCode: 'READ_ONLY_PROBE_ERROR' },
  );
});

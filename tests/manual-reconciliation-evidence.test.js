import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertManualReviewCohortCutoff,
  manualReviewKey,
  normalizeManualReviewEvidence,
  MANUAL_RECONCILIATION_REVIEW_KINDS,
} from '../src/manual-reconciliation-evidence.js';

const good = {
  evidenceType: 'BANK_STATEMENT',
  evidenceSha256: 'A'.repeat(64),
  evidenceReferenceSha256: 'b'.repeat(64),
  reviewerCode: 'op-0123456789abcdef',
};

test('manual evidence accepts only opaque evidence metadata and canonicalizes hashes', () => {
  const normalized = normalizeManualReviewEvidence(good, { reviewKind: MANUAL_RECONCILIATION_REVIEW_KINDS.ACCOUNT_RESOLUTION });
  assert.equal(normalized.evidenceSha256, 'a'.repeat(64));
  assert.equal(normalized.evidenceReferenceSha256, 'b'.repeat(64));
  assert.equal(normalized.reviewKind, 'ACCOUNT_RESOLUTION');
  assert.equal('rawText' in normalized, false);
});

test('manual evidence rejects notification, OTP, statement text, and other extra payload fields', () => {
  for (const extra of [
    { notificationText: 'private notification' },
    { otp: '123456' },
    { statementRow: 'private bank data' },
    { merchant: 'private merchant' },
  ]) {
    assert.throws(() => normalizeManualReviewEvidence({ ...good, ...extra }, {
      reviewKind: MANUAL_RECONCILIATION_REVIEW_KINDS.ACCOUNT_RESOLUTION,
    }), /MANUAL_REVIEW_EVIDENCE_FIELDS_INVALID/);
  }
});

test('manual evidence rejects weak hashes and personal data in reviewer code', () => {
  assert.throws(() => normalizeManualReviewEvidence({ ...good, evidenceSha256: 'not-a-hash' }, { reviewKind: 'ACCOUNT_RESOLUTION' }), /MANUAL_REVIEW_EVIDENCE_HASH_INVALID/);
  assert.throws(() => normalizeManualReviewEvidence({ ...good, reviewerCode: 'person@example.com' }, { reviewKind: 'ACCOUNT_RESOLUTION' }), /MANUAL_REVIEWER_CODE_INVALID/);
  assert.throws(() => normalizeManualReviewEvidence({ ...good, reviewerCode: 'op-constantine' }, { reviewKind: 'ACCOUNT_RESOLUTION' }), /MANUAL_REVIEWER_CODE_INVALID/);
});

test('pair evidence requires one exact receipt, match key, and canonical cohort cutoff', () => {
  assert.throws(() => normalizeManualReviewEvidence(good, { reviewKind: 'RECEIPT_BANK_MATCH', receiptId: 12, matchKey: 'c'.repeat(64) }), /MANUAL_PAIR_REVIEW_SHAPE_INVALID/);
  const normalized = normalizeManualReviewEvidence(good, {
    reviewKind: 'RECEIPT_BANK_MATCH', receiptId: 12,
    cohortCutoff: '2026-10-17T08:08:21.000Z', matchKey: 'c'.repeat(64),
  });
  assert.equal(normalized.receiptId, 12);
  assert.equal(normalized.matchKey, 'c'.repeat(64));
});

test('historical review cutoff must exactly match the configured reconciliation cohort', () => {
  const cutoff = '2026-10-17T08:08:21.000Z';
  assert.throws(() => assertManualReviewCohortCutoff(cutoff, {}), /MANUAL_REVIEW_CONFIGURED_COHORT_CUTOFF_UNSET/);
  assert.throws(() => assertManualReviewCohortCutoff(cutoff, { MATCHED_PURCHASE_RECONCILIATION_START_AT: '2026-10-18T08:08:21.000Z' }), /MANUAL_REVIEW_COHORT_CUTOFF_MISMATCH/);
  assert.equal(assertManualReviewCohortCutoff(cutoff, { MATCHED_PURCHASE_RECONCILIATION_START_AT: cutoff }), Date.parse(cutoff));
});

test('review key is stable and binds a proof digest to exactly one transaction/account/pair', () => {
  const accountEvidence = normalizeManualReviewEvidence(good, { reviewKind: 'ACCOUNT_RESOLUTION' });
  const first = manualReviewKey({ scopeId: 1, bankTransactionId: 7, financialAccountId: 2, evidence: accountEvidence });
  assert.equal(first, manualReviewKey({ scopeId: 1, bankTransactionId: 7, financialAccountId: 2, evidence: accountEvidence }));
  assert.notEqual(first, manualReviewKey({ scopeId: 1, bankTransactionId: 8, financialAccountId: 2, evidence: accountEvidence }));
  assert.notEqual(first, manualReviewKey({ scopeId: 1, bankTransactionId: 7, financialAccountId: 3, evidence: accountEvidence }));
});

test('review migration is append-only and does not grant proof-writing to the application role', () => {
  const sql = fs.readFileSync(new URL('../db/migrations/026_manual_bank_reconciliation_review_evidence.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TRIGGER manual_bank_reconciliation_review_append_only/);
  assert.match(sql, /REVOKE ALL ON public\.manual_bank_reconciliation_review_evidence FROM receipt_collector/);
  assert.match(sql, /evidence_sha256 CHAR\(64\)/);
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]*receipt_collector/i);
  assert.match(sql, /reviewer_code TEXT NOT NULL CHECK \(reviewer_code ~ '\^\(op\|test\)-\[0-9a-f\]\{16\}\$'\)/);
  assert.doesNotMatch(sql, /notification_text|statement_text|otp\b|merchant\b/i);
});

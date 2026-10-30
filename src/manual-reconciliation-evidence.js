import crypto from 'node:crypto';

export const MANUAL_RECONCILIATION_EVIDENCE_VERSION = 'manual-bank-reconciliation-review-v1';
export const MANUAL_RECONCILIATION_EVIDENCE_TYPES = Object.freeze({
  BANK_STATEMENT: 'BANK_STATEMENT',
  BANK_API_TRANSACTION_DETAIL: 'BANK_API_TRANSACTION_DETAIL',
});
export const MANUAL_RECONCILIATION_REVIEW_KINDS = Object.freeze({
  ACCOUNT_RESOLUTION: 'ACCOUNT_RESOLUTION',
  RECEIPT_BANK_MATCH: 'RECEIPT_BANK_MATCH',
});

const SHA256 = /^[0-9a-f]{64}$/i;
const REVIEWER_CODE = /^(?:op|test)-[a-f0-9]{16}$/i;
const COHORT_CUTOFF_ENV = 'MATCHED_PURCHASE_RECONCILIATION_START_AT';

function failManualReviewCutoff(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function assertManualReviewCohortCutoff(cohortCutoff, env = process.env) {
  if (typeof cohortCutoff !== 'string') failManualReviewCutoff('MANUAL_REVIEW_CUTOFF_INVALID');
  const supplied = new Date(cohortCutoff);
  if (Number.isNaN(supplied.getTime()) || supplied.toISOString() !== cohortCutoff) {
    failManualReviewCutoff('MANUAL_REVIEW_CUTOFF_INVALID');
  }
  const configuredCutoff = typeof env[COHORT_CUTOFF_ENV] === 'string' ? env[COHORT_CUTOFF_ENV].trim() : '';
  if (!configuredCutoff) failManualReviewCutoff('MANUAL_REVIEW_CONFIGURED_COHORT_CUTOFF_UNSET');
  const configured = new Date(configuredCutoff);
  if (Number.isNaN(configured.getTime()) || configured.toISOString() !== configuredCutoff) {
    failManualReviewCutoff('MANUAL_REVIEW_CONFIGURED_COHORT_CUTOFF_INVALID');
  }
  if (cohortCutoff !== configuredCutoff) failManualReviewCutoff('MANUAL_REVIEW_COHORT_CUTOFF_MISMATCH');
  return supplied.getTime();
}

export function normalizeManualReviewEvidence(value, { reviewKind, receiptId = null, cohortCutoff = null, matchKey = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MANUAL_REVIEW_EVIDENCE_REQUIRED');
  const allowedKeys = new Set(['evidenceType', 'evidenceSha256', 'evidenceReferenceSha256', 'reviewerCode']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error('MANUAL_REVIEW_EVIDENCE_FIELDS_INVALID');
  if (!Object.values(MANUAL_RECONCILIATION_REVIEW_KINDS).includes(reviewKind)) throw new Error('MANUAL_REVIEW_KIND_INVALID');
  if (!Object.values(MANUAL_RECONCILIATION_EVIDENCE_TYPES).includes(value.evidenceType)) throw new Error('MANUAL_REVIEW_EVIDENCE_TYPE_INVALID');
  if (typeof value.evidenceSha256 !== 'string' || !SHA256.test(value.evidenceSha256)) throw new Error('MANUAL_REVIEW_EVIDENCE_HASH_INVALID');
  if (typeof value.evidenceReferenceSha256 !== 'string' || !SHA256.test(value.evidenceReferenceSha256)) throw new Error('MANUAL_REVIEW_REFERENCE_HASH_INVALID');
  if (typeof value.reviewerCode !== 'string' || !REVIEWER_CODE.test(value.reviewerCode)) throw new Error('MANUAL_REVIEWER_CODE_INVALID');

  const normalizedCutoff = cohortCutoff == null ? null : new Date(cohortCutoff);
  if (normalizedCutoff && (Number.isNaN(normalizedCutoff.getTime()) || normalizedCutoff.toISOString() !== cohortCutoff)) throw new Error('MANUAL_REVIEW_CUTOFF_INVALID');
  const normalizedMatchKey = matchKey == null ? null : String(matchKey).toLowerCase();
  if (normalizedMatchKey != null && !SHA256.test(normalizedMatchKey)) throw new Error('MANUAL_REVIEW_MATCH_KEY_INVALID');
  const normalizedReceiptId = receiptId == null ? null : Number(receiptId);
  if (normalizedReceiptId != null && (!Number.isSafeInteger(normalizedReceiptId) || normalizedReceiptId <= 0)) throw new Error('MANUAL_REVIEW_RECEIPT_ID_INVALID');

  if (reviewKind === MANUAL_RECONCILIATION_REVIEW_KINDS.ACCOUNT_RESOLUTION
    && (normalizedReceiptId !== null || normalizedCutoff !== null || normalizedMatchKey !== null)) throw new Error('MANUAL_ACCOUNT_REVIEW_SHAPE_INVALID');
  if (reviewKind === MANUAL_RECONCILIATION_REVIEW_KINDS.RECEIPT_BANK_MATCH
    && (normalizedReceiptId === null || normalizedCutoff === null || normalizedMatchKey === null)) throw new Error('MANUAL_PAIR_REVIEW_SHAPE_INVALID');

  return Object.freeze({
    modelVersion: MANUAL_RECONCILIATION_EVIDENCE_VERSION,
    reviewKind,
    evidenceType: value.evidenceType,
    evidenceSha256: value.evidenceSha256.toLowerCase(),
    evidenceReferenceSha256: value.evidenceReferenceSha256.toLowerCase(),
    reviewerCode: value.reviewerCode.toLowerCase(),
    receiptId: normalizedReceiptId,
    cohortCutoff: normalizedCutoff?.toISOString() ?? null,
    matchKey: normalizedMatchKey,
  });
}

export function manualReviewKey({ scopeId, bankTransactionId, financialAccountId, evidence }) {
  const positive = (item) => Number.isSafeInteger(Number(item)) && Number(item) > 0;
  if (!positive(scopeId) || !positive(bankTransactionId) || !positive(financialAccountId) || !evidence) throw new Error('MANUAL_REVIEW_KEY_INPUT_INVALID');
  const stable = JSON.stringify({
    modelVersion: evidence.modelVersion,
    reviewKind: evidence.reviewKind,
    scopeId: Number(scopeId),
    bankTransactionId: Number(bankTransactionId),
    receiptId: evidence.receiptId,
    financialAccountId: Number(financialAccountId),
    evidenceType: evidence.evidenceType,
    evidenceSha256: evidence.evidenceSha256,
    evidenceReferenceSha256: evidence.evidenceReferenceSha256,
    reviewerCode: evidence.reviewerCode,
    cohortCutoff: evidence.cohortCutoff,
    matchKey: evidence.matchKey,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

export async function insertManualReviewEvidence(client, { scopeId, bankTransactionId, financialAccountId, evidence }) {
  const reviewKey = manualReviewKey({ scopeId, bankTransactionId, financialAccountId, evidence });
  const result = await client.query(`INSERT INTO manual_bank_reconciliation_review_evidence
      (scope_id,bank_transaction_id,receipt_id,financial_account_id,review_kind,evidence_type,
       evidence_sha256,evidence_reference_sha256,reviewer_code,cohort_cutoff,match_key,review_key,model_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT DO NOTHING
    RETURNING id,review_key`, [
    Number(scopeId), Number(bankTransactionId), evidence.receiptId, Number(financialAccountId), evidence.reviewKind,
    evidence.evidenceType, evidence.evidenceSha256, evidence.evidenceReferenceSha256, evidence.reviewerCode,
    evidence.cohortCutoff, evidence.matchKey, reviewKey, evidence.modelVersion,
  ]);
  if (result.rowCount) return { id: Number(result.rows[0].id), reviewKey, reused: false };

  const existing = (await client.query(`SELECT id,review_key FROM manual_bank_reconciliation_review_evidence
    WHERE review_key=$1`, [reviewKey])).rows[0];
  if (!existing) {
    const error = new Error('MANUAL_REVIEW_ALREADY_RECORDED_WITH_DIFFERENT_EVIDENCE');
    error.code = 'MANUAL_REVIEW_CONFLICT';
    throw error;
  }
  return { id: Number(existing.id), reviewKey, reused: true };
}

import crypto from 'node:crypto';

export const PREPAYMENT_BANK_FUNDING_VERSION = 'prepayment-bank-funding-v1';
export const PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE = 'PREPAYMENT_BANK_FUNDING';
export const PREPAYMENT_BANK_FUNDING_LINK_ROLE = 'PREPAYMENT_BANK_FUNDING';
export const PREPAYMENT_BANK_FUNDING_SUPERSESSION_REASON = 'BANK_ONLY_PREPAYMENT_REFINEMENT';

const SHA256 = /^[0-9a-f]{64}$/i;
const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const ALFA_ANDROID_PROVIDER = 'ru.alfabank.mobile.android';
const OPAQUE_NOTIFICATION_LIFECYCLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function prepaymentBankFundingSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function prepaymentBankFundingSemanticKey({ scopeId, eventId, bankTransactionId, evidenceSha256 }) {
  return prepaymentBankFundingSha256({
    modelVersion: PREPAYMENT_BANK_FUNDING_VERSION,
    scopeId: Number(scopeId),
    eventId: Number(eventId),
    bankTransactionId: Number(bankTransactionId),
    evidenceSha256: String(evidenceSha256).toLowerCase(),
  });
}

export function isValidPrepaymentBankFundingEvidence(event, evidence) {
  const snapshot = evidence?.evidence_snapshot;
  if (!event || !evidence || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const expectedHash = prepaymentBankFundingSha256(snapshot);
  const provider = snapshot.provider;
  const sourceProof = provider === 'com.idamob.tinkoff.android'
    ? snapshot.tbankCardSpecificAccountProofVerified === true
      && snapshot.accountProofMethod === 'TBANK_CARD_SPECIFIC'
      && snapshot.accountResolutionState === 'EXACT'
      && snapshot.accountResolutionProvenance === 'OBSERVED_PROVIDER_REFERENCE'
    : snapshot.sourceProviderBindingVerified === true
      && ['EXACT', 'MANUAL', 'RECONCILED'].includes(snapshot.accountResolutionState);
  const lifecycleIdProof = provider !== ALFA_ANDROID_PROVIDER
    || snapshot.notificationLifecycleIdVerified === true;
  const cohortProof = ISO(snapshot.cohortStartAt)
    && ISO(snapshot.prepaymentEventCreatedAt) && ISO(snapshot.prepaymentSourceObservedAt)
    && ISO(snapshot.settlementSourceObservedAt) && ISO(snapshot.observedAt)
    && Date.parse(snapshot.observedAt) >= Date.parse(snapshot.cohortStartAt)
    && Date.parse(snapshot.prepaymentEventCreatedAt) >= Date.parse(snapshot.cohortStartAt)
    && Date.parse(snapshot.prepaymentSourceObservedAt) >= Date.parse(snapshot.cohortStartAt)
    && Date.parse(snapshot.settlementSourceObservedAt) >= Date.parse(snapshot.cohortStartAt)
    && Number.isInteger(snapshot.timeDeltaMs) && Math.abs(snapshot.timeDeltaMs) <= 300000
    && Math.abs(Date.parse(snapshot.occurredAt) - Date.parse(snapshot.prepaymentReceiptAt)) <= 300000;
  return evidence.evidence_role === PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE
    && evidence.rule_version === PREPAYMENT_BANK_FUNDING_VERSION
    && evidence.bank_receipt_match_id == null
    && Number(evidence.business_event_id) === Number(event.id)
    && Number(evidence.scope_id) === Number(event.scope_id)
    && Number(snapshot.prepaymentEventId) === Number(event.id)
    && Number(snapshot.bankTransactionId) === Number(evidence.bank_transaction_id)
    && Number(snapshot.financialAccountId) === Number(evidence.financial_account_id)
    && snapshot.modelVersion === PREPAYMENT_BANK_FUNDING_VERSION
    && snapshot.scopeKey === event.scope_key
    && event.event_type === 'PREPAYMENT'
    && event.resolution_status === 'CONFIRMED'
    && event.origin === 'SYSTEM_DERIVED'
    && event.graph_model_version === 'business-graph-v1'
    && event.rule_code === 'PREPAYMENT_SETTLEMENT_V1'
    && event.rule_version === 'prepayment-settlement-matcher-v2'
    && MONEY.test(snapshot.amount ?? '') && snapshot.amount !== '0.00'
    && String(event.amount) === snapshot.amount
    && snapshot.currency === 'RUB'
    && (event.currency == null || event.currency === snapshot.currency)
    && snapshot.normalizationStatus === 'READY'
    && snapshot.paymentComponentsStatus === 'RECONCILED'
    && ['PREPAYMENT_ONLY', 'ADVANCE_ONLY'].includes(snapshot.paymentStage)
    && snapshot.settlementPaymentStage === 'SETTLEMENT_ONLY'
    && snapshot.fnsSourceProven === true
    && ['FNS_SOURCE_CONTRACT', 'EXPLICIT_PAYLOAD'].includes(snapshot.fnsCurrencyBasis)
    && snapshot.fiscalOperationType === 1
    && snapshot.eventType === 'PURCHASE' && snapshot.direction === 'DEBIT'
    && snapshot.evidenceQuality === 'EXACT'
    && /^[A-Z]{3}$/.test(snapshot.currency ?? '')
    && ISO(snapshot.occurredAt) && ISO(snapshot.observedAt)
    && Number(snapshot.receiptId) > 0
    && lifecycleIdProof && cohortProof
    && Number(snapshot.accountOwnerScopeProof?.ownerRelationCount) > 0
    && snapshot.accountOwnerScopeProof?.status === 'PROVEN'
    && SHA256.test(snapshot.candidateKey ?? '')
    && SHA256.test(snapshot.journalKey ?? '')
    && sourceProof
    && SHA256.test(evidence.evidence_sha256 ?? '')
    && expectedHash === String(evidence.evidence_sha256).trim().toLowerCase()
    && evidence.semantic_key === prepaymentBankFundingSemanticKey({
      scopeId: Number(evidence.scope_id), eventId: Number(evidence.business_event_id),
      bankTransactionId: Number(evidence.bank_transaction_id), evidenceSha256: expectedHash,
    });
}

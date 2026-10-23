import crypto from 'node:crypto';

export const BANK_ONLY_PURCHASE_VERSION = 'bank-only-purchase-v1';
export const BANK_ONLY_PURCHASE_EVENT_RULE = 'BANK_ONLY_PURCHASE_V1';
export const BANK_ONLY_PURCHASE_EVIDENCE_ROLE = 'BANK_ONLY_PURCHASE';
export const BANK_ONLY_PURCHASE_LEDGER_RULE = 'LEDGER_BANK_ONLY_PURCHASE_V1';
export const TBANK_ANDROID_PROVIDER = 'com.idamob.tinkoff.android';

const SHA256 = /^[0-9a-f]{64}$/i;
const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const ISO = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const RECEIPT_MATCH_DIAGNOSTIC_STATUSES = new Set(['MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'INELIGIBLE', 'NOT_EVALUATED']);

export function canonicalizeBankOnlyEvidence(value) {
  if (Array.isArray(value)) return value.map(canonicalizeBankOnlyEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeBankOnlyEvidence(value[key])]));
  }
  return value;
}

export function bankOnlyEvidenceSha256(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalizeBankOnlyEvidence(value)))
    .digest('hex');
}

function positive(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }

export function isValidBankOnlyPurchaseEvidence(event, evidence) {
  const snapshot = evidence?.evidence_snapshot;
  if (!event || !evidence || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const expectedHash = bankOnlyEvidenceSha256(snapshot);
  const provider = snapshot.provider;
  const ownerRelations = snapshot.ownerRelations;
  const baseValid = evidence.evidence_role === BANK_ONLY_PURCHASE_EVIDENCE_ROLE
    && evidence.rule_version === BANK_ONLY_PURCHASE_VERSION
    && evidence.bank_receipt_match_id == null
    && positive(evidence.bank_transaction_id)
    && positive(evidence.financial_account_id)
    && positive(evidence.business_event_id)
    && Number(evidence.business_event_id) === Number(event.id)
    && Number(evidence.scope_id) === Number(event.scope_id)
    && Number(snapshot.bankTransactionId) === Number(evidence.bank_transaction_id)
    && Number(snapshot.financialAccountId) === Number(evidence.financial_account_id)
    && snapshot.modelVersion === BANK_ONLY_PURCHASE_VERSION
    && snapshot.scopeKey === event.scope_key
    && event.event_type === 'PURCHASE'
    && event.resolution_status === 'CONFIRMED'
    && event.origin === 'SYSTEM_DERIVED'
    && event.graph_model_version === 'business-graph-v1'
    && event.rule_code === BANK_ONLY_PURCHASE_EVENT_RULE
    && event.rule_version === BANK_ONLY_PURCHASE_VERSION
    && MONEY.test(snapshot.amount ?? '')
    && snapshot.amount !== '0.00'
    && String(event.amount) === snapshot.amount
    && event.currency === snapshot.currency
    && snapshot.eventType === 'PURCHASE'
    && snapshot.direction === 'DEBIT'
    && snapshot.normalizationStatus === 'READY'
    && snapshot.evidenceQuality === 'EXACT'
    && /^[A-Z]{3}$/.test(snapshot.currency ?? '')
    && ISO(snapshot.occurredAt)
    && RECEIPT_MATCH_DIAGNOSTIC_STATUSES.has(snapshot.receiptMatchStatusAtWrite)
    && positive(snapshot.observationId)
    && SHA256.test(snapshot.candidateKey ?? '')
    && SHA256.test(snapshot.journalKey ?? '')
    && SHA256.test(evidence.evidence_sha256 ?? '')
    && expectedHash === String(evidence.evidence_sha256).trim().toLowerCase()
    && Array.isArray(ownerRelations) && ownerRelations.length > 0
    && new Set(ownerRelations.map((owner) => Number(owner.personId))).size === ownerRelations.length
    && ownerRelations.every((owner) => positive(owner.personId)
      && owner.relationType === 'OWNER' && typeof owner.provenance === 'string' && owner.provenance.trim()
      && owner.personScopeKey === snapshot.scopeKey)
    && evidence.semantic_key === bankOnlyEvidenceSemanticKey({
      scopeId: Number(evidence.scope_id),
      eventId: Number(evidence.business_event_id),
      bankTransactionId: Number(evidence.bank_transaction_id),
      evidenceSha256: expectedHash,
    });
  if (!baseValid) return false;

  if (provider === TBANK_ANDROID_PROVIDER) {
    return snapshot.accountProofMethod === 'TBANK_CARD_SPECIFIC'
      && snapshot.tbankCardSpecificAccountProofVerified === true
      && snapshot.accountResolutionState === 'EXACT'
      && snapshot.accountResolutionProvenance === 'OBSERVED_PROVIDER_REFERENCE'
      && snapshot.accountReferenceKind === 'MASKED_CARD'
      && snapshot.referenceTargetsResolvedInstrument === true
      && snapshot.uniqueCardReferenceInstrumentCount === 1
      && positive(snapshot.paymentInstrumentId)
      && snapshot.paymentInstrumentResolutionState === 'EXACT'
      && snapshot.paymentInstrumentResolutionProvenance === 'OBSERVED_PROVIDER_REFERENCE'
      && snapshot.paymentInstrumentAccountMatchesResolvedAccount === true;
  }
  return snapshot.accountProofMethod === 'SOURCE_PROVIDER_BINDING'
    && snapshot.sourceProviderBindingVerified === true
    && ['EXACT', 'MANUAL', 'RECONCILED'].includes(snapshot.accountResolutionState);
}

export function bankOnlyEvidenceSemanticKey({ scopeId, eventId, bankTransactionId, evidenceSha256 }) {
  return bankOnlyEvidenceSha256({
    modelVersion: BANK_ONLY_PURCHASE_VERSION,
    scopeId: Number(scopeId),
    eventId: Number(eventId),
    bankTransactionId: Number(bankTransactionId),
    evidenceSha256: String(evidenceSha256).toLowerCase(),
  });
}

import crypto from 'node:crypto';
import { BANK_RECEIPT_MATCHING_STATUSES, loadBankReceiptMatching } from './bank-receipt-matching.js';
import { createLogger } from './logger.js';
import {
  LEDGER_DISPOSITIONS,
  MATCHED_PURCHASE_ENRICHMENT_STATUSES,
  loadMatchedPurchaseEnrichment,
} from './matched-purchase-enrichment-projection.js';
import { BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES } from './bank-receipt-matching.js';

export const MATCHED_PURCHASE_ORCHESTRATION_VERSION = 'matched-purchase-writer-orchestration-v1';
export const MATCHED_PURCHASE_AUTO_POLICY = 'AUTO_EXACT_PURCHASE_UNAMBIGUOUS_5M_V2';
export const ORCHESTRATION_DECISIONS = Object.freeze({
  PERSIST_REQUIRED: 'PERSIST_REQUIRED',
  NOOP_ALREADY_PERSISTED: 'NOOP_ALREADY_PERSISTED',
  BLOCKED: 'BLOCKED',
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function stableJson(value) { return JSON.stringify(canonicalize(value)); }
function fingerprint(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }
function positiveInteger(value) { return Number.isInteger(value) && value > 0; }
const SHA256 = /^[0-9a-f]{64}$/i;

function validateWindow(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a finite positive safe integer`);
}

export function validateMatchedPurchaseMatchKey(value) {
  if (value !== null && value !== undefined && (typeof value !== 'string' || !SHA256.test(value))) {
    throw new Error('matchKey must be a SHA-256 identifier');
  }
  return value ?? null;
}

function safePurchaseIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return {
    disposition: identity.disposition ?? null,
    eventId: positiveInteger(Number(identity.eventId)) ? Number(identity.eventId) : null,
    identityKey: typeof identity.identityKey === 'string' ? identity.identityKey : null,
  };
}

function safeDecisionFields(match, enrichment, action, reasonCode) {
  const bank = match?.bank ?? {};
  const receipt = match?.receipt ?? {};
  return {
    scopeKey: match?.scopeKey ?? null,
    matchKey: match?.matchKey ?? null,
    enrichmentKey: enrichment?.enrichmentKey ?? null,
    bankTransactionId: positiveInteger(Number(bank.bankTransactionId)) ? Number(bank.bankTransactionId) : null,
    receiptId: positiveInteger(Number(receipt.receiptId)) ? Number(receipt.receiptId) : null,
    financialAccountId: positiveInteger(Number(bank.financialAccountId)) ? Number(bank.financialAccountId) : null,
    amount: match?.amount ?? null,
    currency: match?.currency ?? null,
    bankOccurredAt: enrichment?.bankOccurredAt ?? bank.occurredAt ?? null,
    receiptDateTime: enrichment?.receiptDateTime ?? receipt.dateTime ?? null,
    purchaseIdentity: safePurchaseIdentity(enrichment?.purchaseIdentity),
    ledgerDisposition: enrichment?.ledgerDisposition ?? null,
    orchestrationAction: action,
    reasonCode: reasonCode ?? enrichment?.reasonCode ?? null,
    ...(match?.assignmentPolicy ? { assignmentPolicy: match.assignmentPolicy } : {}),
    ...(match?.bank?.sourceProviderBindingVerified === true ? { sourceProviderBindingVerified: true } : {}),
  };
}

function writePlan(enrichment, action) {
  if (action === ORCHESTRATION_DECISIONS.BLOCKED) {
    return {
      execution: 'BLOCKED',
      expectedSemanticChange: false,
      bankReceiptMatch: 'NOT_APPLICABLE',
      purchase: 'NOT_APPLICABLE',
      bankEvidence: 'NOT_APPLICABLE',
      financialAccountLedgerMapping: 'NOT_APPLICABLE',
      bankFundedLedgerEntry: 'NOT_APPLICABLE',
      supersession: 'NOT_APPLICABLE',
      certification: 'NOT_APPLICABLE',
    };
  }
  if (action === ORCHESTRATION_DECISIONS.NOOP_ALREADY_PERSISTED) {
    return {
      execution: 'NOOP',
      expectedSemanticChange: false,
      bankReceiptMatch: 'REUSE',
      purchase: 'REUSE',
      bankEvidence: 'REUSE',
      financialAccountLedgerMapping: 'REUSE',
      bankFundedLedgerEntry: 'REUSE',
      supersession: 'REUSE',
      certification: 'REFRESH_ACTIVE_STATE',
    };
  }
  return {
    execution: 'PERSIST_REQUIRED',
    expectedSemanticChange: true,
    bankReceiptMatch: 'CREATE_OR_REUSE',
    purchase: enrichment?.purchaseIdentity?.disposition === 'REUSE_EXISTING_PURCHASE' ? 'REUSE' : 'CREATE_OR_REUSE',
    bankEvidence: 'CREATE_OR_REUSE',
    financialAccountLedgerMapping: 'CREATE_OR_REUSE',
    bankFundedLedgerEntry: 'CREATE_OR_REUSE',
    supersession: enrichment?.ledgerDisposition === LEDGER_DISPOSITIONS.REFINE_EXISTING_FISCAL_FUNDING ? 'APPEND_OR_REUSE' : 'NOT_APPLICABLE',
    certification: 'REFRESH_ACTIVE_STATE',
  };
}

function orchestrationKey(fields) {
  return fingerprint({
    modelVersion: MATCHED_PURCHASE_ORCHESTRATION_VERSION,
    scopeKey: fields.scopeKey,
    matchKey: fields.matchKey,
    enrichmentKey: fields.enrichmentKey,
  });
}

function matchedDecision(match, enrichment, approvedMatchKey, automaticPolicy) {
  const projected = enrichment?.projectionStatus === MATCHED_PURCHASE_ENRICHMENT_STATUSES.PROJECTED;
  const reusable = projected && enrichment.ledgerDisposition === LEDGER_DISPOSITIONS.REUSE_EXISTING_BANK_FUNDING;
  const actionable = projected && [
    LEDGER_DISPOSITIONS.REFINE_EXISTING_FISCAL_FUNDING,
    LEDGER_DISPOSITIONS.FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED,
  ].includes(enrichment.ledgerDisposition);
  const explicitlyApproved = match.matchKey === approvedMatchKey;
  const policyApproved = automaticPolicy === MATCHED_PURCHASE_AUTO_POLICY
    && match.assignmentPolicy === BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.UNAMBIGUOUS_COMPONENTS
    && match.bank?.sourceProviderBindingVerified === true;
  const action = reusable
    ? ORCHESTRATION_DECISIONS.NOOP_ALREADY_PERSISTED
    : actionable && (explicitlyApproved || policyApproved)
      ? ORCHESTRATION_DECISIONS.PERSIST_REQUIRED
      : ORCHESTRATION_DECISIONS.BLOCKED;
  const reasonCode = actionable && !explicitlyApproved && !policyApproved
    ? 'INDEPENDENT_MATCH_EVIDENCE_REQUIRED'
    : enrichment?.reasonCode ?? 'MATCHED_ENRICHMENT_BLOCKED';
  const fields = safeDecisionFields(match, enrichment, action, reasonCode);
  return {
    ...fields,
    approvalBasis: explicitlyApproved ? 'EXPLICIT_MATCH_KEY' : policyApproved ? automaticPolicy : 'NONE',
    ...(policyApproved ? { automaticPolicy } : {}),
    orchestrationKey: orchestrationKey(fields),
    writePlan: writePlan(enrichment, action),
  };
}

export function buildMatchedPurchaseOrchestrationPreview({ matching, enrichments = [], selectionFailure = null, approvedMatchKey = null, automaticPolicy = null } = {}) {
  if (!matching || typeof matching !== 'object') throw new Error('matching result is required');
  validateMatchedPurchaseMatchKey(approvedMatchKey);
  if (automaticPolicy !== null && automaticPolicy !== MATCHED_PURCHASE_AUTO_POLICY) throw new Error('automaticPolicy is unsupported');
  if (automaticPolicy && approvedMatchKey) throw new Error('automatic policy and approved match key are mutually exclusive');
  const enrichmentByMatchKey = new Map(enrichments.map((item) => [item.matchKey, item]));
  const decisions = (matching.matches ?? [])
    .slice()
    .sort((left, right) => String(left.matchKey).localeCompare(String(right.matchKey)))
    .map((match) => matchedDecision(match, enrichmentByMatchKey.get(match.matchKey), approvedMatchKey, automaticPolicy));
  const bankStatuses = (matching.bankStatuses ?? []).map((row) => ({
    ledgerKey: row.ledgerKey ?? null,
    status: row.status ?? null,
    reasonCode: row.reasonCode ?? null,
    candidateKey: row.candidateKey ?? null,
    journalKey: row.journalKey ?? null,
    bankTransactionId: positiveInteger(Number(row.bankTransactionId)) ? Number(row.bankTransactionId) : null,
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const receiptStatuses = (matching.receiptStatuses ?? []).map((row) => ({
    receiptId: positiveInteger(Number(row.receiptId)) ? Number(row.receiptId) : null,
    receiptCandidateKey: row.receiptCandidateKey ?? null,
    status: row.status ?? null,
    reasonCode: row.reasonCode ?? null,
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const summary = {
    matchedPairs: decisions.length,
    persistRequired: decisions.filter((row) => row.orchestrationAction === ORCHESTRATION_DECISIONS.PERSIST_REQUIRED).length,
    alreadyPersisted: decisions.filter((row) => row.orchestrationAction === ORCHESTRATION_DECISIONS.NOOP_ALREADY_PERSISTED).length,
    blockedMatchedPairs: decisions.filter((row) => row.orchestrationAction === ORCHESTRATION_DECISIONS.BLOCKED).length,
    ambiguousBankPurchases: Number(matching.summary?.ambiguousBankPurchases ?? bankStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS).length),
    ambiguousReceipts: Number(matching.summary?.ambiguousReceipts ?? receiptStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS).length),
    unmatchedBankPurchases: Number(matching.summary?.unmatchedBankPurchases ?? bankStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED).length),
    unmatchedReceipts: Number(matching.summary?.unmatchedReceipts ?? receiptStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED).length),
    ineligibleBankEntries: Number(matching.summary?.ineligibleBankEntries ?? bankStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE).length),
    ineligibleReceipts: Number(matching.summary?.ineligibleReceipts ?? receiptStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE).length),
  };
  const readiness = selectionFailure || summary.blockedMatchedPairs || summary.ambiguousBankPurchases || summary.ambiguousReceipts ? 'REVIEW_REQUIRED' : 'READY';
  return {
    modelVersion: MATCHED_PURCHASE_ORCHESTRATION_VERSION,
    readiness,
    ...(selectionFailure ? { selection: selectionFailure } : {}),
    summary,
    decisions,
    bankStatuses,
    receiptStatuses,
  };
}

export function logMatchedPurchaseOrchestrationPreview(result, options, logger = createLogger()) {
  logger?.info?.('matched_purchase_orchestration_preview_completed', {
    scopeKey: options.scopeKey ?? null,
    readiness: result.readiness,
    from: options.from ?? null,
    to: options.to ?? null,
    internalTransferMaxTimeDeltaMs: options.internalTransferMaxTimeDeltaMs,
    receiptMaxTimeDeltaMs: options.receiptMaxTimeDeltaMs,
    ...result.summary,
  });
}

export async function previewMatchedPurchaseOrchestration(pool, options = {}) {
  validateWindow(options.internalTransferMaxTimeDeltaMs, 'internalTransferMaxTimeDeltaMs');
  validateWindow(options.receiptMaxTimeDeltaMs, 'receiptMaxTimeDeltaMs');
  const matchKey = validateMatchedPurchaseMatchKey(options.matchKey);
  const approvedMatchKey = validateMatchedPurchaseMatchKey(options.approvedMatchKey);
  const automaticPolicy = options.automaticPolicy ?? null;
  if (automaticPolicy !== null && automaticPolicy !== MATCHED_PURCHASE_AUTO_POLICY) throw new Error('automaticPolicy is unsupported');
  if (automaticPolicy && approvedMatchKey) throw new Error('automatic policy and approved match key are mutually exclusive');
  if (approvedMatchKey && matchKey && approvedMatchKey !== matchKey) throw new Error('approved match key must match the selected match key');
  const selectedMatchKey = approvedMatchKey ?? matchKey;
  const loaderOptions = {
    scopeKey: options.scopeKey,
    from: options.from ?? null,
    to: options.to ?? null,
    bankIngestedAfter: options.bankIngestedAfter ?? null,
    matchKey: selectedMatchKey,
    internalTransferMaxTimeDeltaMs: options.internalTransferMaxTimeDeltaMs,
    receiptMaxTimeDeltaMs: options.receiptMaxTimeDeltaMs,
    ...(automaticPolicy ? {
      assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.UNAMBIGUOUS_COMPONENTS,
      requireSourceProviderBinding: true,
    } : {}),
  };
  const matching = await loadBankReceiptMatching(pool, loaderOptions);
  const exactMatches = selectedMatchKey
    ? (matching.matches ?? []).filter((match) => match.matchKey === selectedMatchKey)
    : (matching.matches ?? []);
  const selectionFailure = selectedMatchKey && exactMatches.length === 0
    ? { matchKey: selectedMatchKey, status: 'REVIEW_REQUIRED', reasonCode: 'MATCH_NOT_FOUND' }
    : null;
  const enrichments = await Promise.all(exactMatches.map(async (match) => loadMatchedPurchaseEnrichment(pool, { ...loaderOptions, matchKey: match.matchKey })));
  const result = buildMatchedPurchaseOrchestrationPreview({
    matching: { ...matching, matches: exactMatches }, enrichments, selectionFailure, approvedMatchKey, automaticPolicy,
  });
  logMatchedPurchaseOrchestrationPreview(result, loaderOptions, options.logger);
  return result;
}

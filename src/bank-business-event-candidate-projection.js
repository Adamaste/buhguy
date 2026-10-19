import crypto from 'node:crypto';
import {
  BALANCED_BANK_JOURNAL_PROJECTION_VERSION,
  JOURNAL_ACCOUNT_TYPES,
  loadBalancedBankJournalProjection,
  UNRESOLVED_BANK_ACCOUNT,
} from './balanced-bank-journal-projection.js';

export const BANK_BUSINESS_EVENT_CANDIDATE_PROJECTION_VERSION = 'bank-business-event-candidate-projection-v1';

export const BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES = Object.freeze({
  PROJECTED: 'PROJECTED',
  UNRESOLVED: 'UNRESOLVED',
});

export const BUSINESS_EVENT_CANDIDATE_KINDS = Object.freeze({
  PURCHASE: 'PURCHASE',
  TRANSFER: 'TRANSFER',
  UNCLASSIFIED_MONETARY_MOVEMENT: 'UNCLASSIFIED_MONETARY_MOVEMENT',
});

export const TRANSFER_DIRECTIONS = Object.freeze({ OUTGOING: 'OUTGOING', INCOMING: 'INCOMING' });

const HEX_SHA256 = /^[0-9a-f]{64}$/i;
const MONEY = /^(\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;
const SIDES = new Set(['DEBIT', 'CREDIT']);
const ACCOUNT_RESOLUTION_STATES = new Set(['EXACT', 'MANUAL', 'RECONCILED']);
const KNOWN_REASON_CODES = Object.freeze({
  PURCHASE: 'PROVEN_PURCHASE_DEBIT',
  OUTGOING_TRANSFER: 'PROVEN_OUTGOING_TRANSFER_DEBIT',
  INCOMING_TRANSFER: 'PROVEN_INCOMING_TRANSFER_CREDIT',
});

function expectedCashFlowProjectionKey(bankTransactionId) {
  return crypto.createHash('sha256')
    .update(`bank-cash-flow-projection-v1\0bank-transaction:${bankTransactionId}`)
    .digest('hex');
}

function canonicalAmount(value) {
  if (typeof value !== 'string' || !MONEY.test(value)) return null;
  const match = MONEY.exec(value);
  const integerPart = match[1].replace(/^0+(?=\d)/, '');
  return `${integerPart}.${(match[2] ?? '').padEnd(2, '0')}`;
}

function validCurrency(value) {
  return typeof value === 'string' && CURRENCY.test(value) ? value : null;
}

function validTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeAccount(account) {
  if (!account || typeof account !== 'object') return null;
  if (account.type === JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT
    && Number.isInteger(account.financialAccountId)
    && account.financialAccountId > 0) {
    return { type: account.type, financialAccountId: account.financialAccountId };
  }
  if (account.type === JOURNAL_ACCOUNT_TYPES.SYMBOLIC
    && typeof account.code === 'string' && account.code.length > 0) {
    return { type: account.type, code: account.code };
  }
  return null;
}

function safeBankSide(account) {
  const normalized = safeAccount(account);
  if (!normalized) return null;
  if (normalized.type === JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT) return normalized;
  return normalized.code === UNRESOLVED_BANK_ACCOUNT ? normalized : null;
}

function canonicalJournalAccount(account) {
  if (account.type === JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT) {
    return { type: JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT, financialAccountId: account.financialAccountId };
  }
  return { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code: account.code };
}

function contentJournalKey(journal, source, debit, credit, occurredAt, amount, currency) {
  const fingerprint = {
    modelVersion: journal.modelVersion,
    sourceProjection: {
      modelVersion: source.projectionVersion,
      projectionKey: source.projectionKey.toLowerCase(),
    },
    scopeKey: journal.scopeKey,
    bankTransactionId: journal.bankTransactionId,
    occurredAt,
    amount,
    currency,
    sourceEventType: journal.sourceEventType,
    direction: journal.direction,
    debitAccount: canonicalJournalAccount(debit.account),
    creditAccount: canonicalJournalAccount(credit.account),
  };
  return crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

function sameAccount(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeProvenance(journal) {
  const source = journal?.sourceProvenance;
  if (!source || typeof source !== 'object') return null;
  return {
    journalProjectionVersion: journal.modelVersion,
    journalKey: HEX_SHA256.test(journal.journalKey ?? '') ? journal.journalKey.toLowerCase() : null,
    cashFlowProjectionVersion: source.projectionVersion ?? null,
    cashFlowProjectionKey: HEX_SHA256.test(source.projectionKey ?? '') ? source.projectionKey.toLowerCase() : null,
    sourceReasonCode: source.sourceReasonCode ?? null,
    bankTransactionId: Number.isInteger(source.bankTransactionId) ? source.bankTransactionId : null,
    sourceProjectionStatus: source.sourceProjectionStatus ?? null,
    sourceMovementType: source.sourceMovementType ?? null,
    accountIdentityStatus: source.accountIdentityStatus ?? null,
    accountResolutionState: source.accountResolutionState ?? null,
    accountResolutionProvenance: source.accountResolutionProvenance ?? null,
    ...(source.sourceProviderBindingVerified !== undefined
      ? { sourceProviderBindingVerified: source.sourceProviderBindingVerified === true }
      : {}),
    ...(typeof source.provider === 'string' ? { provider: source.provider } : {}),
    ...(source.tbankCardSpecificAccountProofVerified !== undefined
      ? { tbankCardSpecificAccountProofVerified: source.tbankCardSpecificAccountProofVerified === true }
      : {}),
  };
}

function unresolved(journal, reasonCode) {
  return {
    modelVersion: BANK_BUSINESS_EVENT_CANDIDATE_PROJECTION_VERSION,
    projectionStatus: BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.UNRESOLVED,
    candidateKey: null,
    journalKey: HEX_SHA256.test(journal?.journalKey ?? '') ? journal.journalKey.toLowerCase() : null,
    bankTransactionId: Number.isInteger(journal?.bankTransactionId) ? journal.bankTransactionId : null,
    scopeKey: typeof journal?.scopeKey === 'string' ? journal.scopeKey : null,
    occurredAt: validTime(journal?.occurredAt),
    amount: canonicalAmount(journal?.amount),
    currency: validCurrency(journal?.currency),
    sourceEventType: typeof journal?.sourceEventType === 'string' ? journal.sourceEventType : null,
    direction: typeof journal?.direction === 'string' ? journal.direction : null,
    candidateKind: null,
    businessEventType: null,
    transferDirection: null,
    bankSide: null,
    reasonCode,
    sourceProvenance: safeProvenance(journal),
  };
}

function validateJournal(journal) {
  if (!journal || typeof journal !== 'object') return 'JOURNAL_CONTRACT_INVALID';
  if (journal.modelVersion !== BALANCED_BANK_JOURNAL_PROJECTION_VERSION
    || journal.projectionStatus !== 'PROJECTED'
    || !HEX_SHA256.test(journal.journalKey ?? '')) return 'JOURNAL_CONTRACT_INVALID';
  if (!Number.isInteger(journal.bankTransactionId) || journal.bankTransactionId <= 0
    || typeof journal.scopeKey !== 'string' || !journal.scopeKey.trim()) return 'JOURNAL_CONTRACT_INVALID';
  const amount = canonicalAmount(journal.amount);
  const currency = validCurrency(journal.currency);
  const occurredAt = validTime(journal.occurredAt);
  if (!amount || amount !== journal.amount || !currency || occurredAt == null) return 'JOURNAL_CONTRACT_INVALID';
  if (!Array.isArray(journal.postings) || journal.postings.length !== 2) return 'JOURNAL_CONTRACT_INVALID';
  const postings = journal.postings.map((posting) => ({
    ...posting,
    account: safeAccount(posting?.account),
  }));
  if (postings.some((posting) => !posting.account || !SIDES.has(posting.side)
    || posting.amount !== amount || posting.currency !== currency)) return 'JOURNAL_CONTRACT_INVALID';
  if (new Set(postings.map((posting) => posting.side)).size !== 2) return 'JOURNAL_CONTRACT_INVALID';
  const debit = postings.find((posting) => posting.side === 'DEBIT');
  const credit = postings.find((posting) => posting.side === 'CREDIT');
  const bankSide = safeBankSide(journal.bankSide);
  if (!bankSide || !sameAccount(bankSide, journal.bankSide)) return 'JOURNAL_CONTRACT_INVALID';
  if (!postings.some((posting) => sameAccount(posting.account, bankSide))) return 'JOURNAL_CONTRACT_INVALID';
  const source = journal.sourceProvenance;
  if (!source || source.projectionVersion !== 'bank-cash-flow-projection-v1'
    || !HEX_SHA256.test(source.projectionKey ?? '')
    || source.bankTransactionId !== journal.bankTransactionId) return 'JOURNAL_CONTRACT_INVALID';

  const known = journal.sourceEventType === 'PURCHASE' || journal.sourceEventType === 'OUTGOING_TRANSFER'
    || journal.sourceEventType === 'INCOMING_TRANSFER';
  const unknown = journal.sourceEventType === 'UNKNOWN'
    && journal.reasonCode === 'PROVEN_MONETARY_MOVEMENT_EVENT_TYPE_UNKNOWN'
    && source.sourceReasonCode === 'EVENT_TYPE_UNKNOWN'
    && source.sourceProjectionStatus === 'UNRESOLVED';
  if (!known && !unknown) return 'JOURNAL_SEMANTIC_MISMATCH';
  if (source.projectionKey.toLowerCase() !== expectedCashFlowProjectionKey(journal.bankTransactionId)) return 'JOURNAL_CONTRACT_INVALID';
  if (bankSide.type === JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT
    && (source.accountIdentityStatus !== 'CONCRETE'
      || !ACCOUNT_RESOLUTION_STATES.has(source.accountResolutionState))) return 'JOURNAL_CONTRACT_INVALID';
  if (bankSide.type === JOURNAL_ACCOUNT_TYPES.SYMBOLIC
    && source.accountIdentityStatus !== 'UNRESOLVED') return 'JOURNAL_CONTRACT_INVALID';
  if (known && (source.sourceProjectionStatus !== 'PROJECTED' || source.sourceMovementType !== journal.sourceEventType)) return 'JOURNAL_SEMANTIC_MISMATCH';
  if (unknown && source.sourceMovementType !== 'UNRESOLVED') return 'JOURNAL_SEMANTIC_MISMATCH';
  if (known && (source.sourceReasonCode !== KNOWN_REASON_CODES[journal.sourceEventType]
    || journal.reasonCode !== KNOWN_REASON_CODES[journal.sourceEventType])) return 'JOURNAL_SEMANTIC_MISMATCH';
  if ((known || unknown) && !['DEBIT', 'CREDIT'].includes(journal.direction)) return 'JOURNAL_SEMANTIC_MISMATCH';
  if ((journal.sourceEventType === 'PURCHASE' || journal.sourceEventType === 'OUTGOING_TRANSFER')
    && journal.direction !== 'DEBIT') return 'JOURNAL_SEMANTIC_MISMATCH';
  if (journal.sourceEventType === 'INCOMING_TRANSFER' && journal.direction !== 'CREDIT') return 'JOURNAL_SEMANTIC_MISMATCH';
  if (journal.sourceEventType === 'PURCHASE' && journal.direction === 'DEBIT'
    && (!sameAccount(debit.account, { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code: 'UNCLASSIFIED_PURCHASE' })
      || !sameAccount(credit.account, bankSide))) return 'JOURNAL_SEMANTIC_MISMATCH';
  if (journal.sourceEventType === 'OUTGOING_TRANSFER' && journal.direction === 'DEBIT'
    && (!sameAccount(debit.account, { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code: 'UNCLASSIFIED_OUTGOING' })
      || !sameAccount(credit.account, bankSide))) return 'JOURNAL_SEMANTIC_MISMATCH';
  if (journal.sourceEventType === 'INCOMING_TRANSFER' && journal.direction === 'CREDIT'
    && (!sameAccount(debit.account, bankSide)
      || !sameAccount(credit.account, { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code: 'UNCLASSIFIED_INCOMING' }))) return 'JOURNAL_SEMANTIC_MISMATCH';
  if (unknown && journal.direction === 'DEBIT'
    && (!sameAccount(debit.account, { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code: 'UNCLASSIFIED_OUTGOING' })
      || !sameAccount(credit.account, bankSide))) return 'JOURNAL_SEMANTIC_MISMATCH';
  if (unknown && journal.direction === 'CREDIT'
    && (!sameAccount(debit.account, bankSide)
      || !sameAccount(credit.account, { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code: 'UNCLASSIFIED_INCOMING' }))) return 'JOURNAL_SEMANTIC_MISMATCH';
  if (source.journalProjectionVersion && source.journalProjectionVersion !== journal.modelVersion) return 'JOURNAL_CONTRACT_INVALID';
  if (occurredAt !== journal.occurredAt
    || contentJournalKey(journal, source, debit, credit, occurredAt, amount, currency)
      !== journal.journalKey.toLowerCase()) return 'JOURNAL_CONTRACT_INVALID';
  return null;
}

function semanticMapping(journal) {
  if (journal.sourceEventType === 'PURCHASE' && journal.direction === 'DEBIT') {
    return { candidateKind: BUSINESS_EVENT_CANDIDATE_KINDS.PURCHASE, businessEventType: 'PURCHASE', transferDirection: null };
  }
  if (journal.sourceEventType === 'OUTGOING_TRANSFER' && journal.direction === 'DEBIT') {
    return { candidateKind: BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER, businessEventType: 'TRANSFER', transferDirection: TRANSFER_DIRECTIONS.OUTGOING };
  }
  if (journal.sourceEventType === 'INCOMING_TRANSFER' && journal.direction === 'CREDIT') {
    return { candidateKind: BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER, businessEventType: 'TRANSFER', transferDirection: TRANSFER_DIRECTIONS.INCOMING };
  }
  return { candidateKind: BUSINESS_EVENT_CANDIDATE_KINDS.UNCLASSIFIED_MONETARY_MOVEMENT, businessEventType: null, transferDirection: null };
}

export function projectBankBusinessEventCandidate(journal) {
  const invalidReason = validateJournal(journal);
  if (invalidReason) return unresolved(journal, invalidReason);
  const mapping = semanticMapping(journal);
  const sourceProvenance = safeProvenance(journal);
  const candidateIdentity = {
    modelVersion: BANK_BUSINESS_EVENT_CANDIDATE_PROJECTION_VERSION,
    journalKey: journal.journalKey.toLowerCase(),
    bankTransactionId: journal.bankTransactionId,
    candidateKind: mapping.candidateKind,
    businessEventType: mapping.businessEventType,
    transferDirection: mapping.transferDirection,
  };
  const candidateKey = crypto.createHash('sha256').update(JSON.stringify(candidateIdentity)).digest('hex');
  return {
    modelVersion: BANK_BUSINESS_EVENT_CANDIDATE_PROJECTION_VERSION,
    projectionStatus: BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.PROJECTED,
    candidateKey,
    journalKey: journal.journalKey.toLowerCase(),
    bankTransactionId: journal.bankTransactionId,
    scopeKey: journal.scopeKey,
    occurredAt: validTime(journal.occurredAt),
    amount: journal.amount,
    currency: journal.currency,
    sourceEventType: journal.sourceEventType,
    direction: journal.direction,
    candidateKind: mapping.candidateKind,
    businessEventType: mapping.businessEventType,
    transferDirection: mapping.transferDirection,
    bankSide: safeBankSide(journal.bankSide),
    reasonCode: journal.sourceEventType === 'UNKNOWN' ? 'PROVEN_MONETARY_MOVEMENT_EVENT_TYPE_UNKNOWN' : 'PROVEN_BUSINESS_EVENT_CANDIDATE',
    sourceProvenance,
  };
}

export function projectBankBusinessEventCandidates(journals) {
  if (!Array.isArray(journals)) throw new Error('journals must be an array');
  const projections = journals.map(projectBankBusinessEventCandidate);
  const projected = projections.filter((row) => row.projectionStatus === BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.PROJECTED);
  const unresolved = projections.filter((row) => row.projectionStatus === BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.UNRESOLVED);
  const unresolvedByReason = {};
  for (const row of unresolved) unresolvedByReason[row.reasonCode] = (unresolvedByReason[row.reasonCode] ?? 0) + 1;
  const summary = {
    totalJournals: projections.length,
    projectedCandidates: projected.length,
    unresolvedCandidates: unresolved.length,
    purchases: projected.filter((row) => row.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.PURCHASE).length,
    transfers: projected.filter((row) => row.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER).length,
    outgoingTransfers: projected.filter((row) => row.transferDirection === TRANSFER_DIRECTIONS.OUTGOING).length,
    incomingTransfers: projected.filter((row) => row.transferDirection === TRANSFER_DIRECTIONS.INCOMING).length,
    unclassifiedMonetaryMovements: projected.filter((row) => row.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.UNCLASSIFIED_MONETARY_MOVEMENT).length,
    unresolvedByReason,
  };
  if (summary.totalJournals !== summary.projectedCandidates + summary.unresolvedCandidates) throw new Error('Candidate projection summary invariant failed');
  return { projections, summary };
}

export async function loadBankBusinessEventCandidateProjection(pool, options = {}) {
  const journalProjection = await loadBalancedBankJournalProjection(pool, options);
  return projectBankBusinessEventCandidates(journalProjection.projections);
}

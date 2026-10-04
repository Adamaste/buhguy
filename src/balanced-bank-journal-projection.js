import crypto from 'node:crypto';
import {
  BANK_CASH_FLOW_PROJECTION_VERSION,
  loadBankCashFlowProjection,
} from './bank-cash-flow-projection.js';

export const BALANCED_BANK_JOURNAL_PROJECTION_VERSION = 'balanced-bank-journal-projection-v1';
export const JOURNAL_PROJECTION_STATUSES = Object.freeze({ PROJECTED: 'PROJECTED', UNRESOLVED: 'UNRESOLVED' });
export const JOURNAL_ACCOUNT_TYPES = Object.freeze({ FINANCIAL_ACCOUNT: 'FINANCIAL_ACCOUNT', SYMBOLIC: 'SYMBOLIC' });
export const UNRESOLVED_BANK_ACCOUNT = 'UNRESOLVED_BANK_ACCOUNT';

const DIRECTION_DEBIT = 'DEBIT';
const DIRECTION_CREDIT = 'CREDIT';
const EVENT_TYPE_UNKNOWN = 'UNKNOWN';
const VALID_CURRENCIES = /^[A-Z]{3}$/;
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

function canonicalAmount(value) {
  if (value == null || value === '') return null;
  const match = AMOUNT_PATTERN.exec(String(value));
  if (!match) return null;
  const integerPart = match[1].replace(/^0+(?=\d)/, '');
  const fractionPart = (match[2] ?? '').padEnd(2, '0');
  return `${integerPart}.${fractionPart}`;
}

function normalizedCurrency(value) {
  return typeof value === 'string' && VALID_CURRENCIES.test(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : null;
}

function validOccurredAt(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function symbolicAccount(code) {
  return { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code };
}

function bankAccountSide(source) {
  if (source.accountIdentityStatus === 'CONCRETE'
    && Number.isInteger(source.financialAccountId)
    && source.financialAccountId > 0) {
    return {
      type: JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT,
      financialAccountId: source.financialAccountId,
    };
  }
  return symbolicAccount(UNRESOLVED_BANK_ACCOUNT);
}

function journalKey(source) {
  return crypto.createHash('sha256')
    .update(`${BALANCED_BANK_JOURNAL_PROJECTION_VERSION}\0${source.scopeKey}\0${source.projectionKey}`)
    .digest('hex');
}

function sourceProvenance(source) {
  return {
    projectionVersion: source.modelVersion,
    projectionKey: source.projectionKey,
    sourceReasonCode: source.reasonCode,
    bankTransactionId: source.bankTransactionId,
  };
}

function unresolved(source, reasonCode = source?.reasonCode ?? 'SOURCE_PROJECTION_UNRESOLVED') {
  return {
    modelVersion: BALANCED_BANK_JOURNAL_PROJECTION_VERSION,
    projectionStatus: JOURNAL_PROJECTION_STATUSES.UNRESOLVED,
    journalKey: null,
    bankTransactionId: source?.bankTransactionId ?? null,
    scopeKey: source?.scopeKey ?? null,
    occurredAt: source?.occurredAt ?? null,
    amount: canonicalAmount(source?.amount),
    currency: normalizedCurrency(source?.currency),
    sourceEventType: source?.sourceEventType ?? EVENT_TYPE_UNKNOWN,
    direction: source?.direction ?? EVENT_TYPE_UNKNOWN,
    postings: [],
    reasonCode,
    sourceProvenance: source ? sourceProvenance(source) : null,
  };
}

function mappingFor(source) {
  if (source.sourceEventType === 'PURCHASE' && source.direction === DIRECTION_DEBIT) {
    return { debit: symbolicAccount('UNCLASSIFIED_PURCHASE'), credit: 'BANK' };
  }
  if (source.sourceEventType === 'OUTGOING_TRANSFER' && source.direction === DIRECTION_DEBIT) {
    return { debit: symbolicAccount('UNCLASSIFIED_OUTGOING'), credit: 'BANK' };
  }
  if (source.sourceEventType === 'INCOMING_TRANSFER' && source.direction === DIRECTION_CREDIT) {
    return { debit: 'BANK', credit: symbolicAccount('UNCLASSIFIED_INCOMING') };
  }
  if (source.sourceEventType === EVENT_TYPE_UNKNOWN && source.direction === DIRECTION_DEBIT) {
    return { debit: symbolicAccount('UNCLASSIFIED_OUTGOING'), credit: 'BANK' };
  }
  if (source.sourceEventType === EVENT_TYPE_UNKNOWN && source.direction === DIRECTION_CREDIT) {
    return { debit: 'BANK', credit: symbolicAccount('UNCLASSIFIED_INCOMING') };
  }
  return null;
}

function completeSourceFacts(source) {
  return source?.modelVersion === BANK_CASH_FLOW_PROJECTION_VERSION
    && typeof source.projectionKey === 'string'
    && source.projectionKey.length > 0
    && typeof source.scopeKey === 'string'
    && source.scopeKey.trim().length > 0
    && canonicalAmount(source.amount) != null
    && normalizedCurrency(source.currency) != null
    && validOccurredAt(source.occurredAt) != null
    && (source.direction === DIRECTION_DEBIT || source.direction === DIRECTION_CREDIT)
    && source.normalizationStatus === 'READY'
    && source.evidenceQuality === 'EXACT';
}

export function projectBalancedBankJournal(source) {
  if (!source || !Number.isInteger(source.bankTransactionId) || source.bankTransactionId <= 0) {
    return unresolved(source, 'SOURCE_PROJECTION_INVALID');
  }

  if (!completeSourceFacts(source)) {
    return unresolved(source, source?.reasonCode ?? 'CASH_FLOW_FACTS_INCOMPLETE');
  }

  const knownProjected = source.projectionStatus === 'PROJECTED' && source.movementType !== 'UNRESOLVED';
  const unknownExact = source.projectionStatus === 'UNRESOLVED'
    && source.reasonCode === 'EVENT_TYPE_UNKNOWN'
    && source.sourceEventType === EVENT_TYPE_UNKNOWN;
  if (!knownProjected && !unknownExact) return unresolved(source, source.reasonCode ?? 'SOURCE_PROJECTION_UNRESOLVED');

  const mapping = mappingFor(source);
  if (!mapping) return unresolved(source, 'EVENT_DIRECTION_CONFLICT');

  const amount = canonicalAmount(source.amount);
  const currency = normalizedCurrency(source.currency);
  const occurredAt = validOccurredAt(source.occurredAt);
  const bankSide = bankAccountSide(source);
  const postings = [
    { side: 'DEBIT', account: mapping.debit === 'BANK' ? bankSide : mapping.debit, amount, currency },
    { side: 'CREDIT', account: mapping.credit === 'BANK' ? bankSide : mapping.credit, amount, currency },
  ];
  return {
    modelVersion: BALANCED_BANK_JOURNAL_PROJECTION_VERSION,
    projectionStatus: JOURNAL_PROJECTION_STATUSES.PROJECTED,
    journalKey: journalKey(source),
    bankTransactionId: source.bankTransactionId,
    scopeKey: source.scopeKey,
    occurredAt,
    amount,
    currency,
    sourceEventType: source.sourceEventType,
    direction: source.direction,
    bankSide,
    postings,
    reasonCode: unknownExact ? 'PROVEN_MONETARY_MOVEMENT_EVENT_TYPE_UNKNOWN' : source.reasonCode,
    sourceProvenance: sourceProvenance(source),
  };
}

export function projectBalancedBankJournals(sources) {
  const projections = sources.map(projectBalancedBankJournal);
  const projected = projections.filter((row) => row.projectionStatus === JOURNAL_PROJECTION_STATUSES.PROJECTED);
  const unresolvedRows = projections.filter((row) => row.projectionStatus === JOURNAL_PROJECTION_STATUSES.UNRESOLVED);
  const unresolvedByReason = {};
  for (const row of unresolvedRows) unresolvedByReason[row.reasonCode] = (unresolvedByReason[row.reasonCode] ?? 0) + 1;
  const summary = {
    totalTransactions: projections.length,
    projectedTransactions: projected.length,
    unresolvedTransactions: unresolvedRows.length,
    unresolvedByReason,
  };
  if (summary.totalTransactions !== summary.projectedTransactions + summary.unresolvedTransactions) {
    throw new Error('Balanced journal projection summary invariant failed');
  }
  return { projections, summary };
}

export async function loadBalancedBankJournalProjection(pool, options = {}) {
  const cashFlow = await loadBankCashFlowProjection(pool, options);
  return projectBalancedBankJournals(cashFlow.projections);
}

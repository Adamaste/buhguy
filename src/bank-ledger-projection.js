import crypto from 'node:crypto';
import {
  JOURNAL_ACCOUNT_TYPES,
  projectBalancedBankJournal,
  loadBalancedBankJournalProjection,
  UNRESOLVED_BANK_ACCOUNT,
} from './balanced-bank-journal-projection.js';
import {
  BUSINESS_EVENT_CANDIDATE_KINDS,
  BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES,
  projectBankBusinessEventCandidate,
  projectBankBusinessEventCandidates,
  TRANSFER_DIRECTIONS,
} from './bank-business-event-candidate-projection.js';
import {
  INTERNAL_TRANSFER_MATCH_STATUSES,
  loadBankInternalTransferOwnershipSnapshot,
  matchBankInternalTransfers,
} from './bank-internal-transfer-matching.js';

export const BANK_LEDGER_PROJECTION_VERSION = 'bank-ledger-projection-v1';
export const BANK_LEDGER_PROJECTION_STATUSES = Object.freeze({
  PROJECTED: 'PROJECTED',
  UNRESOLVED: 'UNRESOLVED',
});
export const BANK_LEDGER_SOURCE_STATUSES = Object.freeze({
  STANDALONE: 'STANDALONE',
  CONSUMED_INTERNAL_TRANSFER: 'CONSUMED_INTERNAL_TRANSFER',
  UNRESOLVED: 'UNRESOLVED',
});

const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/i;
const SIDES = new Set(['DEBIT', 'CREDIT']);
const ALLOWED_SYMBOLIC = new Set([
  'UNCLASSIFIED_PURCHASE',
  'UNCLASSIFIED_OUTGOING',
  'UNCLASSIFIED_INCOMING',
  UNRESOLVED_BANK_ACCOUNT,
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableJson(value) { return JSON.stringify(canonicalize(value)); }

function positiveInteger(value) { return Number.isInteger(value) && value > 0; }

function canonicalMoney(value) {
  return typeof value === 'string' && MONEY.test(value) && value !== '0.00' ? value : null;
}

function canonicalCurrency(value) { return typeof value === 'string' && CURRENCY.test(value) ? value : null; }

function canonicalTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function account(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT && positiveInteger(value.financialAccountId)) {
    return { type: JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT, financialAccountId: value.financialAccountId };
  }
  if (value.type === JOURNAL_ACCOUNT_TYPES.SYMBOLIC && ALLOWED_SYMBOLIC.has(value.code)) {
    return { type: JOURNAL_ACCOUNT_TYPES.SYMBOLIC, code: value.code };
  }
  return null;
}

function sameAccount(left, right) { return stableJson(left) === stableJson(right); }

function sourceIdentity(entries) {
  const seen = new Map();
  for (const [field, read] of [
    ['bankTransactionId', (entry) => entry?.journal?.bankTransactionId],
    ['journalKey', (entry) => entry?.journal?.journalKey],
    ['candidateKey', (entry) => entry?.candidate?.candidateKey],
  ]) {
    seen.set(field, new Set());
    for (const entry of entries) {
      const value = read(entry);
      if (value == null) continue;
      const key = String(value);
      if (seen.get(field).has(key)) throw new Error(`duplicate ${field} input`);
      seen.get(field).add(key);
    }
  }
}

function validPosting(posting, amount, currency) {
  const normalized = account(posting?.account);
  return normalized
    && SIDES.has(posting?.side)
    && posting.amount === amount
    && posting.currency === currency
    && sameAccount(normalized, posting.account)
    ? { side: posting.side, account: normalized, amount, currency }
    : null;
}

function validateJournal(journal) {
  if (!journal || journal.projectionStatus !== 'PROJECTED'
    || !HEX_SHA256.test(journal.journalKey ?? '')
    || !positiveInteger(journal.bankTransactionId)
    || typeof journal.scopeKey !== 'string' || !journal.scopeKey.trim()
    || canonicalMoney(journal.amount) !== journal.amount
    || canonicalCurrency(journal.currency) !== journal.currency
    || canonicalTime(journal.occurredAt) !== journal.occurredAt
    || !Array.isArray(journal.postings) || journal.postings.length !== 2) return null;
  const postings = journal.postings.map((posting) => validPosting(posting, journal.amount, journal.currency));
  if (postings.some((posting) => posting == null) || new Set(postings.map((posting) => posting.side)).size !== 2) return null;
  const debit = postings.find((posting) => posting.side === 'DEBIT');
  const credit = postings.find((posting) => posting.side === 'CREDIT');
  if (!debit || !credit) return null;
  return { ...journal, postings, debit, credit };
}

function candidateMatches(supplied, regenerated) {
  const fields = [
    'modelVersion', 'projectionStatus', 'candidateKey', 'journalKey', 'bankTransactionId',
    'scopeKey', 'occurredAt', 'amount', 'currency', 'sourceEventType', 'direction',
    'candidateKind', 'businessEventType', 'transferDirection', 'bankSide', 'reasonCode',
    'sourceProvenance',
  ];
  return fields.every((field) => stableJson(supplied?.[field]) === stableJson(regenerated?.[field]));
}

function normalizeEntries(entries) {
  sourceIdentity(entries);
  return entries.map((entry) => {
    const journal = validateJournal(entry?.journal);
    if (!journal) return { entry, candidate: entry?.candidate ?? null, journal: null, reasonCode: 'JOURNAL_CONTRACT_INVALID' };
    const regenerated = projectBankBusinessEventCandidate(entry.journal);
    if (regenerated.projectionStatus !== BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.PROJECTED) {
      return { entry, candidate: entry?.candidate ?? null, journal, reasonCode: regenerated.reasonCode ?? 'CANDIDATE_UNRESOLVED' };
    }
    if (!candidateMatches(entry?.candidate, regenerated)) {
      return { entry, candidate: entry?.candidate ?? null, journal, reasonCode: 'CANDIDATE_JOURNAL_MISMATCH' };
    }
    return { entry, candidate: regenerated, journal, reasonCode: null };
  });
}

function outputProvenance(candidate, journal) {
  return {
    candidateKey: candidate.candidateKey,
    journalKey: journal.journalKey,
    bankTransactionId: journal.bankTransactionId,
    candidateProjectionVersion: candidate.modelVersion,
    journalProjectionVersion: journal.modelVersion,
    sourceProvenance: candidate.sourceProvenance,
  };
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function assertBalanced(postings, { internal = false } = {}) {
  if (!Array.isArray(postings) || postings.length !== 2) throw new Error('ledger entry must have exactly two postings');
  const sides = postings.map((posting) => posting.side);
  if (sides.filter((side) => side === 'DEBIT').length !== 1 || sides.filter((side) => side === 'CREDIT').length !== 1) {
    throw new Error('ledger entry must have one debit and one credit');
  }
  const [first, second] = postings;
  if (!canonicalMoney(first.amount) || first.amount !== second.amount
    || !canonicalCurrency(first.currency) || first.currency !== second.currency
    || !account(first.account) || !account(second.account)) throw new Error('ledger posting balance contract failed');
  if (internal && sameAccount(first.account, second.account)) throw new Error('internal transfer accounts must differ');
  return postings;
}

function standaloneEntry(row) {
  const { candidate, journal } = row;
  const postings = journal.postings.map((posting) => ({
    side: posting.side,
    account: account(posting.account),
    amount: posting.amount,
    currency: posting.currency,
  }));
  assertBalanced(postings);
  const ledgerKey = fingerprint({
    modelVersion: BANK_LEDGER_PROJECTION_VERSION,
    economicKind: candidate.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.PURCHASE
      ? 'PURCHASE'
      : candidate.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER
        ? (candidate.transferDirection === TRANSFER_DIRECTIONS.OUTGOING ? 'OUTGOING_TRANSFER' : 'INCOMING_TRANSFER')
        : 'UNCLASSIFIED_MONETARY_MOVEMENT',
    scopeKey: journal.scopeKey,
    occurredAt: journal.occurredAt,
    amount: journal.amount,
    currency: journal.currency,
    candidateKey: candidate.candidateKey,
    journalKey: journal.journalKey,
    bankTransactionId: journal.bankTransactionId,
    debitAccount: postings.find((posting) => posting.side === 'DEBIT').account,
    creditAccount: postings.find((posting) => posting.side === 'CREDIT').account,
  });
  const economicKind = candidate.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.PURCHASE
    ? 'PURCHASE'
    : candidate.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER
      ? (candidate.transferDirection === TRANSFER_DIRECTIONS.OUTGOING ? 'OUTGOING_TRANSFER' : 'INCOMING_TRANSFER')
      : 'UNCLASSIFIED_MONETARY_MOVEMENT';
  return {
    modelVersion: BANK_LEDGER_PROJECTION_VERSION,
    projectionStatus: BANK_LEDGER_PROJECTION_STATUSES.PROJECTED,
    ledgerKey,
    scopeKey: journal.scopeKey,
    occurredAt: journal.occurredAt,
    amount: journal.amount,
    currency: journal.currency,
    economicKind,
    postings,
    reasonCode: candidate.reasonCode,
    sourceProvenance: outputProvenance(candidate, journal),
  };
}

function internalEntry(match, outgoing, incoming) {
  if (match.matchStatus !== INTERNAL_TRANSFER_MATCH_STATUSES.MATCHED
    || match.businessEventType !== 'INTERNAL_TRANSFER') throw new Error('unexpected internal transfer match');
  if (match.scopeKey !== outgoing.candidate.scopeKey || match.scopeKey !== incoming.candidate.scopeKey
    || match.amount !== outgoing.candidate.amount || match.amount !== incoming.candidate.amount
    || match.currency !== outgoing.candidate.currency || match.currency !== incoming.candidate.currency
    || match.outgoing.candidateKey !== outgoing.candidate.candidateKey
    || match.incoming.candidateKey !== incoming.candidate.candidateKey
    || match.outgoing.bankTransactionId !== outgoing.candidate.bankTransactionId
    || match.incoming.bankTransactionId !== incoming.candidate.bankTransactionId
    || match.outgoing.financialAccountId !== outgoing.candidate.bankSide.financialAccountId
    || match.incoming.financialAccountId !== incoming.candidate.bankSide.financialAccountId
    || match.outgoing.occurredAt !== outgoing.candidate.occurredAt
    || match.incoming.occurredAt !== incoming.candidate.occurredAt) throw new Error('matcher/source contract mismatch');
  const debitAccount = { type: JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT, financialAccountId: incoming.candidate.bankSide.financialAccountId };
  const creditAccount = { type: JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT, financialAccountId: outgoing.candidate.bankSide.financialAccountId };
  const postings = [
    { side: 'DEBIT', account: debitAccount, amount: match.amount, currency: match.currency },
    { side: 'CREDIT', account: creditAccount, amount: match.amount, currency: match.currency },
  ];
  assertBalanced(postings, { internal: true });
  const occurredAt = outgoing.candidate.occurredAt;
  const ledgerKey = fingerprint({
    modelVersion: BANK_LEDGER_PROJECTION_VERSION,
    economicKind: 'INTERNAL_TRANSFER',
    matchKey: match.matchKey,
    scopeKey: match.scopeKey,
    occurredAt,
    amount: match.amount,
    currency: match.currency,
    outgoing: match.outgoing,
    incoming: match.incoming,
    debitAccount,
    creditAccount,
  });
  return {
    modelVersion: BANK_LEDGER_PROJECTION_VERSION,
    projectionStatus: BANK_LEDGER_PROJECTION_STATUSES.PROJECTED,
    ledgerKey,
    scopeKey: match.scopeKey,
    occurredAt,
    amount: match.amount,
    currency: match.currency,
    economicKind: 'INTERNAL_TRANSFER',
    postings,
    reasonCode: match.reasonCode,
    sourceProvenance: {
      matchKey: match.matchKey,
      ownerPersonId: match.ownerPersonId,
      outgoing: { ...match.outgoing, incomingOccurredAt: match.incoming.occurredAt },
      incoming: match.incoming,
      ownershipProvenance: match.ownershipProvenance,
    },
  };
}

function unresolvedSource(row, reasonCode) {
  return {
    bankTransactionId: positiveInteger(row?.journal?.bankTransactionId) ? row.journal.bankTransactionId : null,
    candidateKey: row?.candidate?.candidateKey ?? null,
    journalKey: row?.journal?.journalKey ?? null,
    status: BANK_LEDGER_SOURCE_STATUSES.UNRESOLVED,
    ledgerKey: null,
    reasonCode,
  };
}

function statusFor(candidate, matcher) {
  return matcher.candidateStatuses.find((status) => status.candidateKey === candidate.candidateKey) ?? null;
}

export function projectBankLedger(entries, ownershipSnapshot, { maxTimeDeltaMs } = {}) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  const normalized = normalizeEntries(entries);
  const matcher = matchBankInternalTransfers(entries, ownershipSnapshot, { maxTimeDeltaMs });
  const byCandidate = new Map(normalized.filter((row) => row.candidate?.candidateKey).map((row) => [row.candidate.candidateKey, row]));
  const matchByCandidate = new Map();
  for (const match of matcher.matches) {
    const outgoing = byCandidate.get(match.outgoing.candidateKey);
    const incoming = byCandidate.get(match.incoming.candidateKey);
    if (!outgoing || !incoming || !outgoing.journal || !incoming.journal) throw new Error('matcher returned unknown source');
    if (matchByCandidate.has(match.outgoing.candidateKey) || matchByCandidate.has(match.incoming.candidateKey)) throw new Error('matcher reused source');
    matchByCandidate.set(match.outgoing.candidateKey, match);
    matchByCandidate.set(match.incoming.candidateKey, match);
  }
  const ledgerEntries = [];
  const sourceStatuses = [];
  const ledgerKeyByMatch = new Map();
  const handledMatches = new Set();
  for (const row of normalized) {
    if (row.reasonCode) {
      sourceStatuses.push(unresolvedSource(row, row.reasonCode));
      continue;
    }
    const match = matchByCandidate.get(row.candidate.candidateKey);
    if (match) {
      if (!handledMatches.has(match.matchKey)) {
        const incoming = byCandidate.get(match.incoming.candidateKey);
        const outgoing = byCandidate.get(match.outgoing.candidateKey);
        const internal = internalEntry(match, outgoing, incoming);
        ledgerEntries.push(internal);
        ledgerKeyByMatch.set(match.matchKey, internal.ledgerKey);
        handledMatches.add(match.matchKey);
      }
      sourceStatuses.push({ bankTransactionId: row.journal.bankTransactionId, candidateKey: row.candidate.candidateKey, journalKey: row.journal.journalKey, status: BANK_LEDGER_SOURCE_STATUSES.CONSUMED_INTERNAL_TRANSFER, ledgerKey: ledgerKeyByMatch.get(match.matchKey), matchKey: match.matchKey, reasonCode: match.reasonCode });
      continue;
    }
    const entry = standaloneEntry(row);
    ledgerEntries.push(entry);
    const matcherStatus = statusFor(row.candidate, matcher);
    sourceStatuses.push({ bankTransactionId: row.journal.bankTransactionId, candidateKey: row.candidate.candidateKey, journalKey: row.journal.journalKey, status: BANK_LEDGER_SOURCE_STATUSES.STANDALONE, ledgerKey: entry.ledgerKey, reasonCode: matcherStatus?.reasonCode ?? 'NO_INTERNAL_TRANSFER_MATCH' });
  }
  sourceStatuses.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  ledgerEntries.sort((left, right) => left.ledgerKey.localeCompare(right.ledgerKey));
  const standalone = sourceStatuses.filter((row) => row.status === BANK_LEDGER_SOURCE_STATUSES.STANDALONE).length;
  const consumed = sourceStatuses.filter((row) => row.status === BANK_LEDGER_SOURCE_STATUSES.CONSUMED_INTERNAL_TRANSFER).length;
  const unresolved = sourceStatuses.filter((row) => row.status === BANK_LEDGER_SOURCE_STATUSES.UNRESOLVED).length;
  const summary = {
    totalSources: sourceStatuses.length,
    standaloneSources: standalone,
    consumedInternalTransferSources: consumed,
    unresolvedSources: unresolved,
    ledgerEntries: ledgerEntries.length,
    standaloneLedgerEntries: ledgerEntries.filter((row) => row.economicKind !== 'INTERNAL_TRANSFER').length,
    internalTransferLedgerEntries: ledgerEntries.filter((row) => row.economicKind === 'INTERNAL_TRANSFER').length,
    postings: ledgerEntries.reduce((total, row) => total + row.postings.length, 0),
    byEconomicKind: Object.fromEntries([...new Set(ledgerEntries.map((row) => row.economicKind))].sort().map((kind) => [kind, ledgerEntries.filter((row) => row.economicKind === kind).length])),
    unresolvedByReason: Object.fromEntries(sourceStatuses.filter((row) => row.status === BANK_LEDGER_SOURCE_STATUSES.UNRESOLVED).reduce((map, row) => map.set(row.reasonCode, (map.get(row.reasonCode) ?? 0) + 1), new Map())),
  };
  if (summary.totalSources !== standalone + consumed + unresolved
    || summary.ledgerEntries !== summary.standaloneLedgerEntries + summary.internalTransferLedgerEntries
    || consumed !== summary.internalTransferLedgerEntries * 2
    || summary.postings !== summary.ledgerEntries * 2) throw new Error('bank ledger projection summary invariant failed');
  return { entries: ledgerEntries, sourceStatuses, summary, matchingSummary: matcher.summary };
}

export async function loadBankLedgerProjection(pool, { scopeKey = null, from = null, to = null, maxTimeDeltaMs } = {}) {
  const journals = await loadBalancedBankJournalProjection(pool, { scopeKey, from, to });
  const candidates = projectBankBusinessEventCandidates(journals.projections);
  const journalsByTransaction = new Map(journals.projections.map((journal) => [journal.bankTransactionId, journal]));
  const entries = candidates.projections.map((candidate) => ({
    candidate,
    journal: journalsByTransaction.get(candidate.bankTransactionId)?.journalKey === candidate.journalKey
      ? journalsByTransaction.get(candidate.bankTransactionId)
      : undefined,
  }));
  const accountIds = entries
    .filter(({ candidate }) => candidate.projectionStatus === BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.PROJECTED
      && candidate.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER
      && (candidate.transferDirection === TRANSFER_DIRECTIONS.OUTGOING || candidate.transferDirection === TRANSFER_DIRECTIONS.INCOMING)
      && candidate.bankSide?.type === JOURNAL_ACCOUNT_TYPES.FINANCIAL_ACCOUNT)
    .map(({ candidate }) => candidate.bankSide.financialAccountId);
  const ownershipSnapshot = await loadBankInternalTransferOwnershipSnapshot(pool, accountIds);
  return projectBankLedger(entries, ownershipSnapshot, { maxTimeDeltaMs });
}

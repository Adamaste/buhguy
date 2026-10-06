import crypto from 'node:crypto';
import { BANK_RECEIPT_MATCHING_STATUSES, loadBankReceiptMatching } from './bank-receipt-matching.js';

export const MATCHED_PURCHASE_ENRICHMENT_VERSION = 'matched-purchase-enrichment-projection-v1';
export const MATCHED_PURCHASE_ENRICHMENT_STATUSES = Object.freeze({
  PROJECTED: 'PROJECTED',
  BLOCKED: 'BLOCKED',
});
export const PURCHASE_IDENTITY_DISPOSITIONS = Object.freeze({
  REUSE_EXISTING_PURCHASE: 'REUSE_EXISTING_PURCHASE',
  PROPOSE_NEW_PURCHASE: 'PROPOSE_NEW_PURCHASE',
  AMBIGUOUS: 'AMBIGUOUS',
});
export const LEDGER_DISPOSITIONS = Object.freeze({
  REFINE_EXISTING_FISCAL_FUNDING: 'REFINE_EXISTING_FISCAL_FUNDING',
  FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED: 'FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED',
  LEDGER_CONFLICT: 'LEDGER_CONFLICT',
});

const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const ACTIVE_STATUSES = new Set(['CANDIDATE', 'CONFIRMED', 'AMBIGUOUS']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function stableJson(value) { return JSON.stringify(canonicalize(value)); }
function fingerprint(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }
function positiveInteger(value) { return Number.isInteger(value) && value > 0; }
function money(value) { return typeof value === 'string' && MONEY.test(value) && value !== '0.00' ? value : null; }
function currency(value) { return typeof value === 'string' && CURRENCY.test(value) ? value : null; }

function isoTime(value) {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function valueOf(row, ...keys) {
  for (const key of keys) if (row?.[key] !== undefined) return row[key];
  return null;
}

function eventType(row) { return valueOf(row, 'event_type', 'eventType'); }
function resolutionStatus(row) { return valueOf(row, 'resolution_status', 'resolutionStatus'); }
function eventId(row) { return Number(valueOf(row, 'id', 'eventId')); }
function eventScope(row) { return valueOf(row, 'scope_key', 'scopeKey'); }
function eventAmount(row) { return valueOf(row, 'amount'); }
function eventCurrency(row) { return valueOf(row, 'currency'); }

function evidenceEventId(row) { return Number(valueOf(row, 'event_id', 'eventId')); }
function evidenceReceiptId(row) { return Number(valueOf(row, 'receipt_id', 'receiptId')); }

function eventReferencesReceipt(row, receiptId, evidence) {
  if (Number(valueOf(row, 'receiptId')) === receiptId) return true;
  if (Array.isArray(row?.receiptIds) && row.receiptIds.some((id) => Number(id) === receiptId)) return true;
  return evidence.some((item) => evidenceEventId(item) === eventId(row) && evidenceReceiptId(item) === receiptId);
}

function persistenceBoundary() {
  return {
    persistenceAllowed: false,
    blockedBySchemaBoundaries: [
      'business_event_evidence_is_receipt_only_and_cannot_link_bank_transaction_or_match',
      'ledger_source_links_cannot_link_bank_evidence',
      'persisted_ledger_has_no_reviewed_version_supersession_for_fiscal_clearing_refinement',
      'financial_account_identity_has_no_reviewed_persisted_ledger_account_mapping',
    ],
  };
}

function blocked(match, reasonCode, details = {}) {
  return {
    modelVersion: MATCHED_PURCHASE_ENRICHMENT_VERSION,
    projectionStatus: MATCHED_PURCHASE_ENRICHMENT_STATUSES.BLOCKED,
    reasonCode,
    enrichmentKey: null,
    matchKey: match?.matchKey ?? null,
    purchaseIdentity: null,
    ledgerDisposition: null,
    targetLedgerPlan: null,
    bankOccurredAt: null,
    receiptDateTime: null,
    sourceProvenance: null,
    persistenceBoundary: persistenceBoundary(),
    ...details,
  };
}

function normalizeMatch(match) {
  if (!match || match.modelVersion !== 'bank-receipt-matching-v1'
    || match.matchStatus !== BANK_RECEIPT_MATCHING_STATUSES.MATCHED
    || match.relationshipType !== 'RECEIPT_EVIDENCE_FOR_BANK_PURCHASE'
    || typeof match.matchKey !== 'string' || !SHA256.test(match.matchKey)
    || typeof match.scopeKey !== 'string' || !match.scopeKey.trim()
    || money(match.amount) !== match.amount || currency(match.currency) !== match.currency
    || !match.bank || !positiveInteger(match.bank.bankTransactionId)
    || !positiveInteger(match.bank.financialAccountId)
    || !SHA256.test(match.bank.ledgerKey ?? '')
    || !SHA256.test(match.bank.candidateKey ?? '')
    || !SHA256.test(match.bank.journalKey ?? '')
    || !isoTime(match.bank.occurredAt)
    || !match.receipt || !positiveInteger(match.receipt.receiptId)
    || !SHA256.test(match.receipt.receiptCandidateKey ?? '')
    || money(match.receipt.amount) !== match.amount || currency(match.receipt.currency) !== match.currency
    || !isoTime(match.receipt.dateTime)
    || typeof match.receipt.normalizationVersion !== 'string'
    || !SHA256.test(match.receipt.normalizedContentSha256 ?? '')) return null;
  return {
    ...match,
    amount: match.amount,
    currency: match.currency,
    bank: { ...match.bank, occurredAt: isoTime(match.bank.occurredAt) },
    receipt: { ...match.receipt, dateTime: isoTime(match.receipt.dateTime) },
    bankAccountOwnershipProvenance: Array.isArray(match.bankAccountOwnershipProvenance)
      ? [...match.bankAccountOwnershipProvenance].sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
      : match.bankAccountOwnershipProvenance ?? null,
  };
}

function activePurchaseState(match, events, evidence) {
  const related = events.filter((event) => eventType(event) === 'PURCHASE' && eventReferencesReceipt(event, match.receipt.receiptId, evidence));
  const active = related.filter((event) => ACTIVE_STATUSES.has(resolutionStatus(event)) && resolutionStatus(event) !== 'REJECTED' && resolutionStatus(event) !== 'SUPERSEDED');
  if (active.length > 1) return { disposition: PURCHASE_IDENTITY_DISPOSITIONS.AMBIGUOUS, reasonCode: 'MULTIPLE_ACTIVE_PURCHASE_EVENTS' };
  if (!active.length) return { disposition: PURCHASE_IDENTITY_DISPOSITIONS.PROPOSE_NEW_PURCHASE, event: null };
  const event = active[0];
  if (resolutionStatus(event) !== 'CONFIRMED') return { disposition: PURCHASE_IDENTITY_DISPOSITIONS.AMBIGUOUS, reasonCode: 'ACTIVE_PURCHASE_NOT_CONFIRMED' };
  if (eventScope(event) !== match.scopeKey) return { disposition: PURCHASE_IDENTITY_DISPOSITIONS.AMBIGUOUS, reasonCode: 'PURCHASE_SCOPE_CONTRADICTION' };
  if (eventAmount(event) !== null && eventAmount(event) !== undefined && eventAmount(event) !== match.amount) return { disposition: null, reasonCode: 'PURCHASE_AMOUNT_CONTRADICTION' };
  if (eventCurrency(event) !== null && eventCurrency(event) !== undefined && eventCurrency(event) !== match.currency) return { disposition: null, reasonCode: 'PURCHASE_CURRENCY_CONTRADICTION' };
  const linkedEvidence = evidence.filter((item) => evidenceEventId(item) === eventId(event) && evidenceReceiptId(item) === match.receipt.receiptId);
  if (!linkedEvidence.length) return { disposition: null, reasonCode: 'PURCHASE_RECEIPT_EVIDENCE_MISSING' };
  if (linkedEvidence.some((item) => valueOf(item, 'normalization_version', 'normalizationVersion') !== match.receipt.normalizationVersion)) return { disposition: null, reasonCode: 'PURCHASE_NORMALIZATION_CONTRADICTION' };
  return { disposition: PURCHASE_IDENTITY_DISPOSITIONS.REUSE_EXISTING_PURCHASE, event, linkedEvidence };
}

function postingSide(row) {
  if (row?.side === 'DEBIT' || row?.side === 'CREDIT') return row.side;
  if (row?.debit !== undefined && row?.credit !== undefined) return row.debit !== '0.00' && row.debit !== 0 ? 'DEBIT' : row.credit !== '0.00' && row.credit !== 0 ? 'CREDIT' : null;
  return null;
}

function postingAccount(row) {
  if (row?.account && typeof row.account === 'object') return row.account;
  if (typeof row?.account === 'string') return { type: 'CODE', code: row.account };
  if (typeof row?.account_code === 'string') return { type: 'CODE', code: row.account_code };
  return null;
}

function postingAmount(row) { return row?.amount ?? (postingSide(row) === 'DEBIT' ? row.debit : row.credit) ?? null; }

function exactFiscalLedgerShape(entry, match) {
  if (valueOf(entry, 'scopeKey', 'scope_key') !== match.scopeKey
    || valueOf(entry, 'currency') !== match.currency
    || valueOf(entry, 'derivationRule', 'derivation_rule') !== 'LEDGER_STANDALONE_PURCHASE_V1'
    || valueOf(entry, 'derivationStatus', 'derivation_status') !== 'READY') return false;
  const postings = Array.isArray(entry?.postings) ? entry.postings : [];
  if (postings.length !== 2) return false;
  const normalized = postings.map((posting) => ({ side: postingSide(posting), account: postingAccount(posting), amount: postingAmount(posting), currency: posting.currency ?? entry.currency }));
  const debit = normalized.find((posting) => posting.side === 'DEBIT');
  const credit = normalized.find((posting) => posting.side === 'CREDIT');
  return normalized.every((posting) => posting.side && posting.amount === match.amount && posting.currency === match.currency)
    && debit?.account?.type === 'CODE' && debit.account.code === 'UNCLASSIFIED_ACQUISITION'
    && credit?.account?.type === 'CODE' && credit.account.code === 'FISCAL_PAYMENT_CLEARING';
}

function relevantLedgerEntries(ledgerEntries, event) {
  const id = event ? eventId(event) : null;
  return (Array.isArray(ledgerEntries) ? ledgerEntries : []).filter((entry) => {
    const sourceId = Number(valueOf(entry, 'sourceEventId', 'source_event_id', 'businessEventId', 'business_event_id', 'eventId'));
    return id !== null ? sourceId === id : valueOf(entry, 'receiptId', 'receipt_id') != null;
  });
}

function targetLedgerPlan(match) {
  return {
    modelVersion: MATCHED_PURCHASE_ENRICHMENT_VERSION,
    scopeKey: match.scopeKey,
    amount: match.amount,
    currency: match.currency,
    occurredAt: match.bank.occurredAt,
    receiptDateTime: match.receipt.dateTime,
    postings: [
      { side: 'DEBIT', account: { type: 'CODE', code: 'UNCLASSIFIED_ACQUISITION' }, amount: match.amount, currency: match.currency },
      { side: 'CREDIT', account: { type: 'FINANCIAL_ACCOUNT', financialAccountId: match.bank.financialAccountId }, amount: match.amount, currency: match.currency },
    ],
  };
}

export function projectMatchedPurchaseEnrichment({ match, existingPurchaseEvents = [], existingPurchaseEvidence = [], existingLedgerEntries = [] } = {}) {
  const normalizedMatch = normalizeMatch(match);
  if (!normalizedMatch) return blocked(match, 'MATCH_CONTRACT_INVALID');
  const purchase = activePurchaseState(normalizedMatch, existingPurchaseEvents, existingPurchaseEvidence);
  if (!purchase.disposition) return blocked(normalizedMatch, purchase.reasonCode);
  if (purchase.disposition === PURCHASE_IDENTITY_DISPOSITIONS.AMBIGUOUS) return blocked(normalizedMatch, purchase.reasonCode, { purchaseIdentity: { disposition: purchase.disposition } });
  const relevant = relevantLedgerEntries(existingLedgerEntries, purchase.event);
  if (relevant.length > 1 || (relevant.length === 1 && !exactFiscalLedgerShape(relevant[0], normalizedMatch))) {
    return blocked(normalizedMatch, 'LEDGER_CONFLICT', {
      purchaseIdentity: { disposition: purchase.disposition, eventId: purchase.event ? eventId(purchase.event) : null },
      ledgerDisposition: LEDGER_DISPOSITIONS.LEDGER_CONFLICT,
    });
  }
  const ledgerDisposition = relevant.length === 1
    ? LEDGER_DISPOSITIONS.REFINE_EXISTING_FISCAL_FUNDING
    : LEDGER_DISPOSITIONS.FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED;
  const plan = targetLedgerPlan(normalizedMatch);
  const purchaseIdentity = purchase.disposition === PURCHASE_IDENTITY_DISPOSITIONS.REUSE_EXISTING_PURCHASE
    ? { disposition: purchase.disposition, eventId: eventId(purchase.event), identityKey: fingerprint({ type: 'EXISTING_PURCHASE', scopeKey: normalizedMatch.scopeKey, eventId: eventId(purchase.event) }) }
    : { disposition: purchase.disposition, identityKey: fingerprint({ type: 'PROPOSED_PURCHASE', matchKey: normalizedMatch.matchKey, receiptCandidateKey: normalizedMatch.receipt.receiptCandidateKey, bankTransactionId: normalizedMatch.bank.bankTransactionId }) };
  const sourceProvenance = {
    matchKey: normalizedMatch.matchKey,
    bankLedgerKey: normalizedMatch.bank.ledgerKey ?? null,
    bankCandidateKey: normalizedMatch.bank.candidateKey ?? null,
    bankJournalKey: normalizedMatch.bank.journalKey ?? null,
    bankTransactionId: normalizedMatch.bank.bankTransactionId,
    financialAccountId: normalizedMatch.bank.financialAccountId,
    receiptCandidateKey: normalizedMatch.receipt.receiptCandidateKey,
    receiptId: normalizedMatch.receipt.receiptId,
    normalizationVersion: normalizedMatch.receipt.normalizationVersion,
    bankAccountOwnershipProvenance: normalizedMatch.bankAccountOwnershipProvenance ?? null,
  };
  const enrichmentKey = fingerprint({
    modelVersion: MATCHED_PURCHASE_ENRICHMENT_VERSION,
    match: normalizedMatch,
    purchaseIdentity,
    ledgerDisposition,
    existingLedgerFingerprint: relevant.map((entry) => fingerprint(entry)).sort(),
    targetLedgerPlan: plan,
  });
  return {
    modelVersion: MATCHED_PURCHASE_ENRICHMENT_VERSION,
    projectionStatus: MATCHED_PURCHASE_ENRICHMENT_STATUSES.PROJECTED,
    reasonCode: 'MATCHED_BANK_PURCHASE_RECEIPT_ENRICHMENT_READY',
    enrichmentKey,
    matchKey: normalizedMatch.matchKey,
    purchaseIdentity,
    ledgerDisposition,
    targetLedgerPlan: plan,
    bankOccurredAt: normalizedMatch.bank.occurredAt,
    receiptDateTime: normalizedMatch.receipt.dateTime,
    sourceProvenance,
    persistenceBoundary: persistenceBoundary(),
  };
}

function eventIdList(events) { return events.map((event) => Number(event.id ?? event.event_id)).filter(positiveInteger); }

export async function loadMatchedPurchaseEnrichment(pool, options = {}) {
  const { matchingLoader = loadBankReceiptMatching } = options;
  const matching = await matchingLoader(pool, options);
  const matches = matching.matches ?? [];
  const match = options.matchKey ? matches.find((item) => item.matchKey === options.matchKey) : matches.length === 1 ? matches[0] : null;
  if (!match) return blocked({ matchKey: options.matchKey ?? null }, matches.length ? 'MATCH_SELECTION_REQUIRED' : 'MATCH_NOT_FOUND');
  const receiptId = match.receipt.receiptId;
  const eventRows = (await pool.query(`SELECT DISTINCT ON (e.id) e.*, s.scope_key FROM business_events e JOIN accounting_scopes s ON s.id=e.scope_id WHERE EXISTS (SELECT 1 FROM business_event_evidence ev WHERE ev.event_id=e.id AND ev.receipt_id=$1) ORDER BY e.id`, [receiptId])).rows;
  const ids = eventIdList(eventRows);
  if (!ids.length) return projectMatchedPurchaseEnrichment({ match, existingPurchaseEvents: [], existingPurchaseEvidence: [], existingLedgerEntries: [] });
  const evidenceRows = (await pool.query('SELECT * FROM business_event_evidence WHERE event_id = ANY($1::bigint[]) ORDER BY id', [ids])).rows;
  const ledgerRows = (await pool.query(`SELECT le.*, s.scope_key FROM ledger_entries le JOIN accounting_scopes s ON s.id=le.scope_id WHERE le.source_event_id = ANY($1::bigint[]) ORDER BY le.id`, [ids])).rows;
  const ledgerIds = ledgerRows.map((row) => Number(row.id)).filter(positiveInteger);
  const postingRows = ledgerIds.length
    ? (await pool.query('SELECT lp.*, la.account_code FROM ledger_postings lp JOIN ledger_accounts la ON la.id=lp.account_id WHERE lp.ledger_entry_id = ANY($1::bigint[]) ORDER BY lp.id', [ledgerIds])).rows
    : [];
  const postingsByEntry = new Map();
  for (const posting of postingRows) {
    const list = postingsByEntry.get(Number(posting.ledger_entry_id)) ?? [];
    list.push(posting);
    postingsByEntry.set(Number(posting.ledger_entry_id), list);
  }
  return projectMatchedPurchaseEnrichment({
    match,
    existingPurchaseEvents: eventRows,
    existingPurchaseEvidence: evidenceRows,
    existingLedgerEntries: ledgerRows.map((row) => ({ ...row, postings: postingsByEntry.get(Number(row.id)) ?? [] })),
  });
}

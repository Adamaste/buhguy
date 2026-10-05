import crypto from 'node:crypto';
import {
  BANK_LEDGER_PROJECTION_STATUSES,
  projectBankLedger,
} from './bank-ledger-projection.js';
import { loadBalancedBankJournalProjection } from './balanced-bank-journal-projection.js';
import { projectBankBusinessEventCandidates } from './bank-business-event-candidate-projection.js';
import { loadBankInternalTransferOwnershipSnapshot } from './bank-internal-transfer-matching.js';

export const BANK_RECEIPT_MATCHING_VERSION = 'bank-receipt-matching-v1';
export const BANK_RECEIPT_MATCHING_STATUSES = Object.freeze({
  MATCHED: 'MATCHED',
  UNMATCHED: 'UNMATCHED',
  AMBIGUOUS: 'AMBIGUOUS',
  INELIGIBLE: 'INELIGIBLE',
});

const NORMALIZED_FACT_VERSION = 'fiscal-normalizer-v1';
const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function stableJson(value) { return JSON.stringify(canonicalize(value)); }
function fingerprint(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }
function positiveInteger(value) { return Number.isInteger(value) && value > 0; }
function canonicalMoney(value) { return typeof value === 'string' && MONEY.test(value) && value !== '0.00' ? value : null; }
function canonicalCurrency(value) { return typeof value === 'string' && CURRENCY.test(value) ? value : null; }
function canonicalTime(value) {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const result = date.toISOString();
  return ISO_TIME.test(result) ? result : null;
}

function explicitZero(value, state) { return value === '0.00' && state === 'EXPLICIT_ZERO'; }
function canonicalScopeKeys(row) {
  const keys = row?.scopeKeys ?? row?.resolvedScopeKeys;
  if (!Array.isArray(keys)) return null;
  const normalized = [...new Set(keys.filter((key) => typeof key === 'string' && key.trim()).map((key) => key.trim()))];
  return normalized.length === 1 ? normalized : null;
}

function ownerSnapshotAccount(snapshot, financialAccountId) {
  return (snapshot?.accounts ?? []).find((account) => account.financialAccountId === financialAccountId) ?? null;
}

function ownerGate(snapshot, financialAccountId, scopeKey) {
  const account = ownerSnapshotAccount(snapshot, financialAccountId);
  if (!account || account.accountScopeKey !== scopeKey || !Array.isArray(account.owners)) return null;
  const owners = account.owners
    .filter((owner) => owner?.financialAccountId === financialAccountId
      && owner.relationType === 'OWNER'
      && owner.personScopeKey === scopeKey
      && positiveInteger(owner.personId)
      && typeof owner.provenance === 'string' && owner.provenance.trim())
    .map((owner) => ({
      financialAccountId,
      accountScopeKey: scopeKey,
      personId: owner.personId,
      personScopeKey: owner.personScopeKey,
      relationType: 'OWNER',
      provenance: owner.provenance,
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return owners.length ? owners : null;
}

function bankPosting(entry, side) { return entry.postings.find((posting) => posting.side === side) ?? null; }

function projectBankReceiptEligibility(entry, ownershipSnapshot) {
  if (!entry || entry.projectionStatus !== BANK_LEDGER_PROJECTION_STATUSES.PROJECTED) return { status: BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE, reasonCode: 'BANK_LEDGER_UNRESOLVED' };
  if (entry.economicKind !== 'PURCHASE') return { status: BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE, reasonCode: 'BANK_NOT_PURCHASE' };
  if (!canonicalMoney(entry.amount) || !canonicalCurrency(entry.currency) || !canonicalTime(entry.occurredAt) || typeof entry.scopeKey !== 'string' || !entry.scopeKey.trim()) return { status: BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE, reasonCode: 'BANK_MONETARY_EVIDENCE_INVALID' };
  const debit = bankPosting(entry, 'DEBIT');
  const credit = bankPosting(entry, 'CREDIT');
  if (debit?.account?.type !== 'SYMBOLIC' || debit.account.code !== 'UNCLASSIFIED_PURCHASE'
    || credit?.account?.type !== 'FINANCIAL_ACCOUNT' || !positiveInteger(credit.account.financialAccountId)
    || debit.amount !== entry.amount || credit.amount !== entry.amount
    || debit.currency !== entry.currency || credit.currency !== entry.currency) return { status: BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE, reasonCode: 'BANK_POSTINGS_NOT_PURCHASE_SHAPE' };
  const source = entry.sourceProvenance;
  if (!SHA256.test(source?.candidateKey ?? '') || !SHA256.test(source?.journalKey ?? '') || !positiveInteger(source?.bankTransactionId)) return { status: BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE, reasonCode: 'BANK_PROVENANCE_INCOMPLETE' };
  const owners = ownerGate(ownershipSnapshot, credit.account.financialAccountId, entry.scopeKey);
  if (!owners) return { status: BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE, reasonCode: 'BANK_ACCOUNT_OWNER_UNPROVEN' };
  return {
    status: BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED,
    bank: {
      ledgerKey: entry.ledgerKey,
      candidateKey: source.candidateKey,
      journalKey: source.journalKey,
      bankTransactionId: source.bankTransactionId,
      financialAccountId: credit.account.financialAccountId,
      scopeKey: entry.scopeKey,
      amount: entry.amount,
      currency: entry.currency,
      occurredAt: entry.occurredAt,
      ownershipProvenance: owners,
    },
  };
}

export function projectBankReceiptCandidate(row) {
  const rawReceiptId = row?.receiptId ?? row?.id;
  const parsedReceiptId = Number(rawReceiptId);
  const receiptId = positiveInteger(parsedReceiptId) ? parsedReceiptId : null;
  const scopeKeys = canonicalScopeKeys(row);
  const amount = row?.ecashTotalSum;
  const currency = canonicalCurrency(row?.currency);
  const dateTime = canonicalTime(row?.dateTime);
  const itemCodes = row?.itemPaymentTypeCodes;
  const valid = positiveInteger(receiptId)
    && row?.normalizationVersion === NORMALIZED_FACT_VERSION
    && SHA256.test(row?.normalizedContentSha256 ?? '')
    && row?.normalizationStatus === 'READY'
    && dateTime !== null
    && scopeKeys !== null
    && currency !== null
    && Number(row?.fiscalOperationType) === 1
    && row?.householdCashDirection === 'OUT'
    && row?.paymentComponentsStatus === 'RECONCILED'
    && row?.paymentStage === 'SETTLEMENT_ONLY'
    && row?.correctionStatus === 'UNKNOWN'
    && Number.isInteger(row?.receiptItemCount) && row.receiptItemCount > 0
    && Number.isInteger(row?.normalizedItemFactCount) && row.normalizedItemFactCount === row.receiptItemCount
    && Array.isArray(itemCodes) && itemCodes.length === row.receiptItemCount && itemCodes.every((code) => Number(code) === 4)
    && row?.ecashTotalState === 'PRESENT_VALUE'
    && canonicalMoney(amount) !== null
    && explicitZero(row?.cashTotalSum, row?.cashTotalState)
    && explicitZero(row?.prepaidSum, row?.prepaidState)
    && explicitZero(row?.creditSum, row?.creditState)
    && explicitZero(row?.provisionSum, row?.provisionState)
    && row?.totalSum === amount;
  if (!valid) return { status: BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE, reasonCode: 'RECEIPT_EVIDENCE_INELIGIBLE', receiptId: positiveInteger(receiptId) ? receiptId : null };
  const scopeKey = scopeKeys[0];
  const receiptCandidateKey = fingerprint({
    modelVersion: BANK_RECEIPT_MATCHING_VERSION,
    receiptId,
    normalizationVersion: row.normalizationVersion,
    normalizedContentSha256: row.normalizedContentSha256.toLowerCase(),
    scopeKey,
    dateTime,
    amount,
    currency,
    semantics: { fiscalOperationType: 1, householdCashDirection: 'OUT', paymentStage: 'SETTLEMENT_ONLY', itemPaymentTypeCodes: [4], amountBasis: 'ECASH_TOTAL_SUM' },
  });
  return {
    status: BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED,
    receipt: {
      receiptCandidateKey,
      receiptId,
      normalizationVersion: row.normalizationVersion,
      normalizedContentSha256: row.normalizedContentSha256.toLowerCase(),
      scopeKey,
      dateTime,
      amount,
      currency,
      amountBasis: 'ECASH_TOTAL_SUM',
    },
  };
}

function validateWindow(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a finite positive safe integer`);
}

function validateReceiptInputs(rows) {
  if (!Array.isArray(rows)) throw new Error('receiptRows must be an array');
  const ids = new Set();
  const keys = new Set();
  for (const row of rows) {
    const candidate = projectBankReceiptCandidate(row);
    const id = candidate.receipt?.receiptId ?? candidate.receiptId;
    if (id !== null) {
      if (ids.has(id)) throw new Error('duplicate receiptId input');
      ids.add(id);
    }
    if (candidate.receipt?.receiptCandidateKey) {
      if (keys.has(candidate.receipt.receiptCandidateKey)) throw new Error('duplicate receiptCandidateKey input');
      keys.add(candidate.receipt.receiptCandidateKey);
    }
  }
}

function addEdge(graph, left, right) {
  graph.bank.get(left).push(right);
  graph.receipt.get(right).push(left);
}

function matchKey(bank, receipt, timeDeltaMs) {
  return fingerprint({
    modelVersion: BANK_RECEIPT_MATCHING_VERSION,
    relationshipType: 'RECEIPT_EVIDENCE_FOR_BANK_PURCHASE',
    bankLedgerKey: bank.ledgerKey,
    bankCandidateKey: bank.candidateKey,
    bankJournalKey: bank.journalKey,
    bankTransactionId: bank.bankTransactionId,
    financialAccountId: bank.financialAccountId,
    receiptCandidateKey: receipt.receiptCandidateKey,
    receiptId: receipt.receiptId,
    normalizationVersion: receipt.normalizationVersion,
    normalizedContentSha256: receipt.normalizedContentSha256,
    scopeKey: bank.scopeKey,
    amount: bank.amount,
    currency: bank.currency,
    bankOccurredAt: bank.occurredAt,
    receiptDateTime: receipt.dateTime,
    timeDeltaMs,
    bankAccountOwnershipProvenance: bank.ownershipProvenance,
  });
}

export function matchBankReceipts(bankEntries, ownershipSnapshot, receiptRows, { internalTransferMaxTimeDeltaMs, receiptMaxTimeDeltaMs } = {}) {
  validateWindow(internalTransferMaxTimeDeltaMs, 'internalTransferMaxTimeDeltaMs');
  validateWindow(receiptMaxTimeDeltaMs, 'receiptMaxTimeDeltaMs');
  if (!Array.isArray(bankEntries)) throw new Error('bankEntries must be an array');
  validateReceiptInputs(receiptRows);
  const ledger = projectBankLedger(bankEntries, ownershipSnapshot, { maxTimeDeltaMs: internalTransferMaxTimeDeltaMs });
  const bankCandidates = ledger.entries.map((entry) => ({ entry, eligibility: projectBankReceiptEligibility(entry, ownershipSnapshot) }));
  const eligibleBanks = bankCandidates.filter((row) => row.eligibility.bank).map((row) => row.eligibility.bank);
  const receiptCandidates = receiptRows.map((row) => projectBankReceiptCandidate(row));
  const eligibleReceipts = receiptCandidates.filter((row) => row.receipt).map((row) => row.receipt);
  const bankByKey = new Map(eligibleBanks.map((bank) => [bank.candidateKey, bank]));
  const receiptByKey = new Map(eligibleReceipts.map((receipt) => [receipt.receiptCandidateKey, receipt]));
  const graph = { bank: new Map(eligibleBanks.map((bank) => [bank.candidateKey, []])), receipt: new Map(eligibleReceipts.map((receipt) => [receipt.receiptCandidateKey, []])) };
  for (const bank of eligibleBanks) {
    for (const receipt of eligibleReceipts) {
      const bankTime = Date.parse(bank.occurredAt);
      const receiptTime = Date.parse(receipt.dateTime);
      const timeDeltaMs = Math.abs(bankTime - receiptTime);
      if (bank.scopeKey === receipt.scopeKey && bank.amount === receipt.amount && bank.currency === receipt.currency && timeDeltaMs <= receiptMaxTimeDeltaMs) addEdge(graph, bank.candidateKey, receipt.receiptCandidateKey);
    }
  }
  const statuses = new Map();
  const matches = [];
  const visitedBanks = new Set();
  const visitedReceipts = new Set();
  for (const bank of eligibleBanks) statuses.set(`bank:${bank.candidateKey}`, BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED);
  for (const receipt of eligibleReceipts) statuses.set(`receipt:${receipt.receiptCandidateKey}`, BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED);
  const visit = (type, key, component) => {
    const marker = `${type}:${key}`;
    if ((type === 'bank' ? visitedBanks : visitedReceipts).has(key)) return;
    (type === 'bank' ? visitedBanks : visitedReceipts).add(key);
    component.push([type, key]);
    const adjacent = type === 'bank' ? graph.bank.get(key) : graph.receipt.get(key);
    for (const next of adjacent) visit(type === 'bank' ? 'receipt' : 'bank', next, component);
  };
  for (const bank of eligibleBanks) {
    if (visitedBanks.has(bank.candidateKey)) continue;
    if (graph.bank.get(bank.candidateKey).length === 0) {
      visitedBanks.add(bank.candidateKey);
      continue;
    }
    const component = [];
    visit('bank', bank.candidateKey, component);
    const banks = component.filter(([type]) => type === 'bank').map(([, key]) => bankByKey.get(key));
    const receipts = component.filter(([type]) => type === 'receipt').map(([, key]) => receiptByKey.get(key));
    if (banks.length === 1 && receipts.length === 1 && graph.bank.get(banks[0].candidateKey).length === 1) {
      const timeDeltaMs = Math.abs(Date.parse(banks[0].occurredAt) - Date.parse(receipts[0].dateTime));
      matches.push({
        modelVersion: BANK_RECEIPT_MATCHING_VERSION,
        matchStatus: BANK_RECEIPT_MATCHING_STATUSES.MATCHED,
        matchKey: matchKey(banks[0], receipts[0], timeDeltaMs),
        relationshipType: 'RECEIPT_EVIDENCE_FOR_BANK_PURCHASE',
        scopeKey: banks[0].scopeKey,
        amount: banks[0].amount,
        currency: banks[0].currency,
        timeDeltaMs,
        reasonCode: 'PROVEN_EXACT_ECASH_RECEIPT_BANK_PURCHASE_MATCH',
        bank: { ledgerKey: banks[0].ledgerKey, candidateKey: banks[0].candidateKey, journalKey: banks[0].journalKey, bankTransactionId: banks[0].bankTransactionId, financialAccountId: banks[0].financialAccountId, occurredAt: banks[0].occurredAt },
        receipt: receipts[0],
        bankAccountOwnershipProvenance: banks[0].ownershipProvenance,
      });
      statuses.set(`bank:${banks[0].candidateKey}`, BANK_RECEIPT_MATCHING_STATUSES.MATCHED);
      statuses.set(`receipt:${receipts[0].receiptCandidateKey}`, BANK_RECEIPT_MATCHING_STATUSES.MATCHED);
    } else {
      for (const item of component) statuses.set(`${item[0]}:${item[1]}`, BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS);
    }
  }
  for (const receipt of eligibleReceipts) {
    if (visitedReceipts.has(receipt.receiptCandidateKey)) continue;
    visitedReceipts.add(receipt.receiptCandidateKey);
  }
  const bankStatuses = ledger.entries.map((entry) => {
    const eligibility = projectBankReceiptEligibility(entry, ownershipSnapshot);
    const source = entry.sourceProvenance ?? {};
    const eligible = eligibility.bank;
    const status = eligible
      ? statuses.get(`bank:${eligible.candidateKey}`) ?? BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED
      : BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE;
    return {
      ledgerKey: entry.ledgerKey,
      economicKind: entry.economicKind,
      status,
      reasonCode: eligible
        ? (status === BANK_RECEIPT_MATCHING_STATUSES.MATCHED
          ? 'PROVEN_EXACT_ECASH_RECEIPT_BANK_PURCHASE_MATCH'
          : status === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS
            ? 'AMBIGUOUS_COMPATIBLE_RECEIPTS'
            : 'NO_COMPATIBLE_RECEIPT')
        : eligibility.reasonCode,
      upstreamReasonCode: entry.reasonCode ?? null,
      candidateKey: source.candidateKey ?? null,
      journalKey: source.journalKey ?? null,
      bankTransactionId: source.bankTransactionId ?? null,
    };
  }).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const receiptStatuses = receiptCandidates.map((candidate) => ({
    receiptId: candidate.receipt?.receiptId ?? candidate.receiptId,
    receiptCandidateKey: candidate.receipt?.receiptCandidateKey ?? null,
    status: candidate.receipt ? (statuses.get(`receipt:${candidate.receipt.receiptCandidateKey}`) ?? BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED) : candidate.status,
    reasonCode: candidate.receipt
      ? (statuses.get(`receipt:${candidate.receipt.receiptCandidateKey}`) === BANK_RECEIPT_MATCHING_STATUSES.MATCHED
        ? 'PROVEN_EXACT_ECASH_RECEIPT_BANK_PURCHASE_MATCH'
        : statuses.get(`receipt:${candidate.receipt.receiptCandidateKey}`) === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS
          ? 'AMBIGUOUS_COMPATIBLE_BANK_PURCHASES'
          : 'NO_COMPATIBLE_BANK_PURCHASE')
      : candidate.reasonCode ?? null,
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  matches.sort((left, right) => left.matchKey.localeCompare(right.matchKey));
  const summary = {
    totalBankLedgerEntries: ledger.entries.length,
    eligibleBankPurchases: bankStatuses.filter((row) => row.status !== BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE).length,
    ineligibleBankEntries: bankStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE).length,
    totalReceipts: receiptRows.length,
    eligibleReceipts: eligibleReceipts.length,
    ineligibleReceipts: receiptStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE).length,
    matchedPairs: matches.length,
    matchedBankPurchases: bankStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.MATCHED).length,
    matchedReceipts: receiptStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.MATCHED).length,
    unmatchedBankPurchases: bankStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED).length,
    unmatchedReceipts: receiptStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.UNMATCHED).length,
    ambiguousBankPurchases: bankStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS).length,
    ambiguousReceipts: receiptStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS).length,
    receiptIneligibleByReason: Object.fromEntries(receiptStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE).reduce((map, row) => map.set(row.reasonCode, (map.get(row.reasonCode) ?? 0) + 1), new Map())),
    bankIneligibleByReason: Object.fromEntries(bankStatuses.filter((row) => row.status === BANK_RECEIPT_MATCHING_STATUSES.INELIGIBLE).reduce((map, row) => map.set(row.reasonCode, (map.get(row.reasonCode) ?? 0) + 1), new Map())),
  };
  if (summary.totalBankLedgerEntries !== bankStatuses.length
    || summary.totalReceipts !== receiptStatuses.length
    || summary.totalBankLedgerEntries !== summary.eligibleBankPurchases + summary.ineligibleBankEntries
    || summary.totalReceipts !== summary.eligibleReceipts + summary.ineligibleReceipts
    || summary.eligibleBankPurchases !== summary.matchedBankPurchases + summary.unmatchedBankPurchases + summary.ambiguousBankPurchases
    || summary.eligibleReceipts !== summary.matchedReceipts + summary.unmatchedReceipts + summary.ambiguousReceipts
    || summary.matchedBankPurchases !== summary.matchedPairs
    || summary.matchedReceipts !== summary.matchedPairs) throw new Error('receipt matching cardinality invariant failed');
  return { matches, bankStatuses, receiptStatuses, summary };
}

function expandedBound(value, delta, direction) {
  if (value == null) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error('from/to must be valid timestamps');
  return new Date(time + direction * delta).toISOString();
}

export async function loadBankReceiptMatching(pool, { scopeKey = null, from = null, to = null, internalTransferMaxTimeDeltaMs, receiptMaxTimeDeltaMs } = {}) {
  validateWindow(internalTransferMaxTimeDeltaMs, 'internalTransferMaxTimeDeltaMs');
  validateWindow(receiptMaxTimeDeltaMs, 'receiptMaxTimeDeltaMs');
  const journals = await loadBalancedBankJournalProjection(pool, { scopeKey, from, to });
  const candidates = projectBankBusinessEventCandidates(journals.projections);
  const journalsByTransaction = new Map(journals.projections.map((journal) => [journal.bankTransactionId, journal]));
  const entries = candidates.projections.map((candidate) => ({
    candidate,
    journal: journalsByTransaction.get(candidate.bankTransactionId)?.journalKey === candidate.journalKey ? journalsByTransaction.get(candidate.bankTransactionId) : undefined,
  }));
  const accountIds = entries
    .filter(({ candidate }) => candidate.candidateKind === 'PURCHASE' || candidate.candidateKind === 'TRANSFER')
    .map(({ candidate }) => candidate.bankSide?.financialAccountId)
    .filter(positiveInteger);
  const ownershipSnapshot = await loadBankInternalTransferOwnershipSnapshot(pool, accountIds);
  const dateFrom = expandedBound(from, receiptMaxTimeDeltaMs, -1);
  const dateTo = expandedBound(to, receiptMaxTimeDeltaMs, 1);
  const params = [NORMALIZED_FACT_VERSION, dateFrom, dateTo, scopeKey];
  const receipts = (await pool.query(`
    WITH receipt_scopes AS (
      SELECT observation.receipt_id,
             COALESCE(array_agg(DISTINCT receipt_scope.scope_key) FILTER (WHERE receipt_scope.scope_key IS NOT NULL), ARRAY[]::text[]) AS "scopeKeys"
      FROM receipt_source_observations observation
      LEFT JOIN fns_sources source ON source.id = observation.fns_source_id
      LEFT JOIN accounting_scopes receipt_scope ON receipt_scope.id = source.scope_id
      GROUP BY observation.receipt_id
    ), receipt_item_coverage AS (
      SELECT item.receipt_id,
             count(DISTINCT item.id)::integer AS "receiptItemCount",
             count(DISTINCT item_fact.receipt_item_id)::integer AS "normalizedItemFactCount",
             COALESCE(array_agg(item_fact.payment_type_code ORDER BY item.id) FILTER (WHERE item_fact.receipt_item_id IS NOT NULL), ARRAY[]::smallint[]) AS "itemPaymentTypeCodes"
      FROM receipt_items item
      LEFT JOIN receipt_item_fiscal_facts item_fact ON item_fact.receipt_item_id = item.id AND item_fact.normalization_version = $1
      GROUP BY item.receipt_id
    )
    SELECT r.id AS "receiptId", r.date_time AS "dateTime", r.currency,
           f.normalization_version AS "normalizationVersion", f.normalized_content_sha256 AS "normalizedContentSha256",
           f.normalization_status AS "normalizationStatus", f.fiscal_operation_type AS "fiscalOperationType",
           f.household_cash_direction AS "householdCashDirection", f.payment_components_status AS "paymentComponentsStatus",
           f.payment_stage AS "paymentStage", f.correction_status AS "correctionStatus",
           f.ecash_total_sum AS "ecashTotalSum", f.ecash_total_state AS "ecashTotalState",
           f.cash_total_sum AS "cashTotalSum", f.cash_total_state AS "cashTotalState",
           f.prepaid_sum AS "prepaidSum", f.prepaid_state AS "prepaidState",
           f.credit_sum AS "creditSum", f.credit_state AS "creditState",
           f.provision_sum AS "provisionSum", f.provision_state AS "provisionState",
           r.total_sum AS "totalSum",
           receipt_item_coverage."receiptItemCount", receipt_item_coverage."normalizedItemFactCount",
           receipt_item_coverage."itemPaymentTypeCodes", COALESCE(receipt_scopes."scopeKeys", ARRAY[]::text[]) AS "scopeKeys"
    FROM receipts r
    JOIN receipt_fiscal_facts f ON f.receipt_id = r.id AND f.normalization_version = $1
    LEFT JOIN receipt_item_coverage ON receipt_item_coverage.receipt_id = r.id
    LEFT JOIN receipt_scopes ON receipt_scopes.receipt_id = r.id
    WHERE ($2::timestamptz IS NULL OR r.date_time >= $2::timestamptz)
      AND ($3::timestamptz IS NULL OR r.date_time < $3::timestamptz)
      AND ($4::text IS NULL OR $4 = ANY(COALESCE(receipt_scopes."scopeKeys", ARRAY[]::text[])))
    GROUP BY r.id, f.normalization_version, f.normalized_content_sha256, f.normalization_status,
      f.fiscal_operation_type, f.household_cash_direction, f.payment_components_status,
      f.payment_stage, f.correction_status, f.ecash_total_sum, f.ecash_total_state,
      f.cash_total_sum, f.cash_total_state, f.prepaid_sum, f.prepaid_state,
      f.credit_sum, f.credit_state, f.provision_sum, f.provision_state,
      receipt_item_coverage."receiptItemCount", receipt_item_coverage."normalizedItemFactCount", receipt_item_coverage."itemPaymentTypeCodes", receipt_scopes."scopeKeys"
    ORDER BY r.id`, params)).rows;
  return matchBankReceipts(entries, ownershipSnapshot, receipts, { internalTransferMaxTimeDeltaMs, receiptMaxTimeDeltaMs });
}

import { resolveFnsReceiptCurrency } from './fns-receipt-currency.js';
import { BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES } from './bank-receipt-matching.js';
import { MATCHED_PURCHASE_AUTO_POLICY } from './matched-purchase-orchestration.js';

export const PRELIMINARY_BANK_RECEIPT_WINDOW_MS = 5 * 60 * 1000;
export const PRELIMINARY_CANDIDATE_STATUSES = Object.freeze({
  UNIQUE: 'UNIQUE_AMOUNT_TIME_CANDIDATE',
  AMBIGUOUS: 'AMBIGUOUS',
});

const MONEY_TEXT = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const SAFE_REASON_CODE = /^[A-Z0-9_]{1,64}$/;

function decimalText(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const source = String(value).trim();
  const match = MONEY_TEXT.exec(source);
  if (!match) return null;
  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2];
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const digits = `${integer}${fraction}`;
  const point = integer.length + exponent;
  let whole;
  let fractional;
  if (point <= 0) {
    whole = '0';
    fractional = `${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    whole = `${digits}${'0'.repeat(point - digits.length)}`;
    fractional = '';
  } else {
    whole = digits.slice(0, point);
    fractional = digits.slice(point);
  }
  whole = whole.replace(/^0+(?=\d)/, '');
  fractional = fractional.replace(/0+$/, '');
  const isZero = /^0+$/.test(whole) && fractional === '';
  return `${isZero ? '' : sign}${whole}${fractional ? `.${fractional}` : ''}`;
}

function epoch(value) {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function idText(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = String(value);
  return /^\d+$/.test(result) && result !== '0' ? result : null;
}

function displayLabel(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}

function safeReason(value, fallback) {
  return typeof value === 'string' && SAFE_REASON_CODE.test(value) ? value : fallback;
}

function pairKey(bankId, receiptId) { return `${bankId}:${receiptId}`; }

function blockerReasons(bank, receipt, {
  ambiguous,
  persistedConflict,
  strictBankStatus,
  strictReceiptStatus,
  strictDecision,
  cohortStartAt,
} = {}) {
  const reasons = new Set();
  if (ambiguous) reasons.add('AMBIGUOUS_AMOUNT_TIME_CANDIDATES');
  if (persistedConflict) reasons.add('EXISTING_MATCH_CONFLICT');

  if (bank.eventType !== 'PURCHASE') reasons.add('BANK_NOT_PURCHASE');
  if (bank.direction !== 'DEBIT') reasons.add('BANK_DIRECTION_NOT_DEBIT');
  if (bank.normalizationStatus !== 'READY') reasons.add('BANK_NORMALIZATION_NOT_READY');
  if (bank.evidenceQuality !== 'EXACT') reasons.add('BANK_EVIDENCE_NOT_EXACT');
  if (bank.accountResolutionState !== 'EXACT'
    && bank.accountResolutionState !== 'MANUAL'
    && bank.accountResolutionState !== 'RECONCILED') reasons.add('BANK_ACCOUNT_UNRESOLVED');
  if (bank.sourceProviderBindingVerified !== true && bank.tbankCardSpecificAccountProofVerified !== true) {
    reasons.add('BANK_SOURCE_PROVIDER_BINDING_UNPROVEN');
  }
  if (bank.ownerProven !== true) reasons.add('BANK_ACCOUNT_OWNER_UNPROVEN');
  if (!bank.scopeKey) reasons.add('BANK_SCOPE_UNRESOLVED');

  if (Number(receipt.operationType) !== 1
    || (receipt.fiscalOperationType !== null && receipt.fiscalOperationType !== undefined
      && Number(receipt.fiscalOperationType) !== 1)) reasons.add('FNS_OPERATION_NOT_PURCHASE');
  if (receipt.normalizationStatus !== 'READY') reasons.add('FNS_NORMALIZATION_NOT_READY');
  if (receipt.paymentStage !== 'SETTLEMENT_ONLY') reasons.add('FNS_PAYMENT_STAGE_NOT_SETTLED_PURCHASE');
  if (receipt.paymentComponentsStatus !== 'RECONCILED') reasons.add('FNS_PAYMENT_COMPONENTS_UNRECONCILED');
  if (receipt.householdCashDirection !== 'OUT') reasons.add('FNS_HOUSEHOLD_DIRECTION_NOT_OUT');
  if (receipt.fnsSourceProven !== true) reasons.add('FNS_SOURCE_UNPROVEN');

  const receiptScopes = Array.isArray(receipt.scopeKeys) ? receipt.scopeKeys.filter((scope) => typeof scope === 'string' && scope) : [];
  if (receiptScopes.length !== 1) reasons.add('RECEIPT_SCOPE_UNRESOLVED');
  else if (bank.scopeKey && receiptScopes[0] !== bank.scopeKey) reasons.add('ACCOUNTING_SCOPE_MISMATCH');

  const receiptCurrency = resolveFnsReceiptCurrency({
    explicitCurrency: receipt.currency,
    fnsSourceProven: receipt.fnsSourceProven === true,
  });
  if (!bank.currency) reasons.add('BANK_CURRENCY_UNRESOLVED');
  if (receiptCurrency.status !== 'RESOLVED') reasons.add('RECEIPT_CURRENCY_UNRESOLVED');
  else if (bank.currency && receiptCurrency.currency !== bank.currency) reasons.add('CURRENCY_MISMATCH');

  const cutoff = epoch(cohortStartAt);
  if (cutoff !== null) {
    const occurredAt = epoch(bank.occurredAt);
    const observedAt = epoch(bank.observationCreatedAt);
    if ((occurredAt !== null && occurredAt < cutoff) || (observedAt !== null && observedAt < cutoff)) {
      reasons.add('AUTO_BANK_EVENT_OUTSIDE_COHORT');
    }
  }

  const bankStatus = strictBankStatus?.status;
  if (bankStatus === 'INELIGIBLE' && strictBankStatus?.reasonCode) reasons.add(safeReason(strictBankStatus.reasonCode, 'STRICT_BANK_MATCHER_BLOCKED'));
  if (bankStatus === 'AMBIGUOUS' && strictBankStatus?.reasonCode) reasons.add(safeReason(strictBankStatus.reasonCode, 'STRICT_BANK_MATCHER_AMBIGUOUS'));
  const receiptStatus = strictReceiptStatus?.status;
  if (receiptStatus === 'INELIGIBLE' && strictReceiptStatus?.reasonCode) reasons.add(safeReason(strictReceiptStatus.reasonCode, 'STRICT_RECEIPT_MATCHER_BLOCKED'));
  if (receiptStatus === 'AMBIGUOUS' && strictReceiptStatus?.reasonCode) reasons.add(safeReason(strictReceiptStatus.reasonCode, 'STRICT_RECEIPT_MATCHER_AMBIGUOUS'));
  if (strictDecision?.reasonCode && strictDecision.orchestrationAction === 'BLOCKED') {
    reasons.add(safeReason(strictDecision.reasonCode, 'STRICT_ORCHESTRATION_BLOCKED'));
  }
  if (strictDecision?.orchestrationAction === 'PERSIST_REQUIRED') reasons.add('STRICT_GATES_PASS_PREVIEW_ONLY');
  if (strictDecision?.orchestrationAction === 'NOOP_ALREADY_PERSISTED') reasons.add('ALREADY_ACCOUNTED_NO_NEW_POSTING');
  if (!reasons.size) reasons.add('STRICT_MATCH_REQUIRES_SEPARATE_APPROVAL');
  return [...reasons].sort();
}

function persistedLinksByPair(persistedMatches) {
  const result = new Map();
  for (const match of persistedMatches) {
    const bankId = idText(match?.bankTransactionId);
    const receiptId = idText(match?.receiptId);
    if (!bankId || !receiptId) continue;
    result.set(pairKey(bankId, receiptId), match);
  }
  return result;
}

function indexById(rows, field) {
  const result = new Map();
  for (const row of rows) {
    const id = idText(row?.[field]);
    if (id) result.set(id, row);
  }
  return result;
}

export function findPreliminaryBankReceiptCandidates({
  bankRows,
  receiptRows,
  persistedMatches = [],
  strictBankStatuses = [],
  strictReceiptStatuses = [],
  strictDecisions = [],
  cohortStartAt = null,
  from = null,
  to = null,
  windowMs = PRELIMINARY_BANK_RECEIPT_WINDOW_MS,
} = {}) {
  if (!Array.isArray(bankRows) || !Array.isArray(receiptRows) || !Array.isArray(persistedMatches)
    || !Array.isArray(strictBankStatuses) || !Array.isArray(strictReceiptStatuses) || !Array.isArray(strictDecisions)) {
    throw new TypeError('candidate inputs must be arrays');
  }
  if (windowMs !== PRELIMINARY_BANK_RECEIPT_WINDOW_MS) throw new RangeError('preliminary candidate window is fixed at five minutes');
  const fromTime = from === null ? null : epoch(from);
  const toTime = to === null ? null : epoch(to);
  if ((from !== null && fromTime === null) || (to !== null && toTime === null)
    || (fromTime !== null && toTime !== null && fromTime >= toTime)) throw new RangeError('invalid candidate report period');

  const banksByAmount = new Map();
  for (const bank of bankRows) {
    const bankId = idText(bank?.bankTransactionId);
    const amount = decimalText(bank?.amount);
    const occurredAt = epoch(bank?.occurredAt);
    if (!bankId || amount === null || occurredAt === null) continue;
    const group = banksByAmount.get(amount) ?? [];
    group.push({ ...bank, bankTransactionId: bankId, amountKey: amount, occurredAtMs: occurredAt });
    banksByAmount.set(amount, group);
  }

  const receiptByAmount = new Map();
  for (const receipt of receiptRows) {
    const receiptId = idText(receipt?.receiptId);
    const amount = decimalText(receipt?.amount);
    const dateTime = epoch(receipt?.dateTime);
    if (!receiptId || amount === null || dateTime === null) continue;
    const group = receiptByAmount.get(amount) ?? [];
    group.push({ ...receipt, receiptId, amountKey: amount, dateTimeMs: dateTime });
    receiptByAmount.set(amount, group);
  }

  const persistedByPair = persistedLinksByPair(persistedMatches);
  const bankStrictById = indexById(strictBankStatuses, 'bankTransactionId');
  const receiptStrictById = indexById(strictReceiptStatuses, 'receiptId');
  const decisionsByPair = new Map();
  for (const decision of strictDecisions) {
    const bankId = idText(decision?.bankTransactionId);
    const receiptId = idText(decision?.receiptId);
    if (bankId && receiptId) decisionsByPair.set(pairKey(bankId, receiptId), decision);
  }

  const edges = [];
  for (const [amount, receipts] of receiptByAmount) {
    const banks = banksByAmount.get(amount) ?? [];
    for (const receipt of receipts) {
      for (const bank of banks) {
        const timeDeltaMs = Math.abs(bank.occurredAtMs - receipt.dateTimeMs);
        if (timeDeltaMs > PRELIMINARY_BANK_RECEIPT_WINDOW_MS) continue;
        if (fromTime !== null || toTime !== null) {
          const receiptInPeriod = (fromTime === null || receipt.dateTimeMs >= fromTime) && (toTime === null || receipt.dateTimeMs < toTime);
          const bankInPeriod = (fromTime === null || bank.occurredAtMs >= fromTime) && (toTime === null || bank.occurredAtMs < toTime);
          if (!receiptInPeriod && !bankInPeriod) continue;
        }
        edges.push({ bank, receipt, amount, timeDeltaMs });
      }
    }
  }

  const bankDegree = new Map();
  const receiptDegree = new Map();
  for (const edge of edges) {
    bankDegree.set(edge.bank.bankTransactionId, (bankDegree.get(edge.bank.bankTransactionId) ?? 0) + 1);
    receiptDegree.set(edge.receipt.receiptId, (receiptDegree.get(edge.receipt.receiptId) ?? 0) + 1);
  }
  const linkedReceiptByBank = new Map();
  const linkedBankByReceipt = new Map();
  for (const match of persistedMatches) {
    const bankId = idText(match?.bankTransactionId);
    const receiptId = idText(match?.receiptId);
    if (!bankId || !receiptId) continue;
    linkedReceiptByBank.set(bankId, receiptId);
    linkedBankByReceipt.set(receiptId, bankId);
  }

  return edges.map(({ bank, receipt, amount, timeDeltaMs }) => {
    const key = pairKey(bank.bankTransactionId, receipt.receiptId);
    const savedLink = persistedByPair.get(key) ?? null;
    const persistedConflict = (!savedLink && (
      (linkedReceiptByBank.has(bank.bankTransactionId) && linkedReceiptByBank.get(bank.bankTransactionId) !== receipt.receiptId)
      || (linkedBankByReceipt.has(receipt.receiptId) && linkedBankByReceipt.get(receipt.receiptId) !== bank.bankTransactionId)
    ));
    const ambiguous = (bankDegree.get(bank.bankTransactionId) ?? 0) > 1 || (receiptDegree.get(receipt.receiptId) ?? 0) > 1;
    const strictBankStatus = bankStrictById.get(bank.bankTransactionId) ?? null;
    const strictReceiptStatus = receiptStrictById.get(receipt.receiptId) ?? null;
    const strictDecision = decisionsByPair.get(key) ?? null;
    const reasonCodes = blockerReasons(bank, receipt, {
      ambiguous,
      persistedConflict,
      strictBankStatus,
      strictReceiptStatus,
      strictDecision,
      cohortStartAt,
    });
    const linkStatus = savedLink
      ? (savedLink.reasonCode === 'PROVEN_EXACT_ECASH_RECEIPT_BANK_PURCHASE_MATCH' ? 'SAVED_EXACT' : 'SAVED_STATUS_UNRECORDED')
      : persistedConflict ? 'CONFLICTING_SAVED_LINK' : 'NOT_SAVED';
    const candidateStatus = ambiguous ? PRELIMINARY_CANDIDATE_STATUSES.AMBIGUOUS : PRELIMINARY_CANDIDATE_STATUSES.UNIQUE;
    const automaticAccountingAction = strictDecision?.orchestrationAction ?? 'NOT_EVALUATED';
    const automaticAccountingApprovalBasis = safeReason(strictDecision?.approvalBasis, 'NONE');
    const hasCurrentAutomaticPolicyBasis = strictDecision?.approvalBasis === MATCHED_PURCHASE_AUTO_POLICY
      && strictDecision?.automaticPolicy === MATCHED_PURCHASE_AUTO_POLICY
      && strictDecision?.assignmentPolicy === BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.UNAMBIGUOUS_COMPONENTS;
    const passesAutomaticAccountingPolicy = !ambiguous && !persistedConflict
      && hasCurrentAutomaticPolicyBasis
      && ['PERSIST_REQUIRED', 'NOOP_ALREADY_PERSISTED'].includes(automaticAccountingAction);
    return {
      receiptId: receipt.receiptId,
      bankTransactionId: bank.bankTransactionId,
      amount,
      timeDeltaMs,
      candidateStatus,
      linkStatus,
      persistedReasonCode: savedLink ? safeReason(savedLink.reasonCode, 'PERSISTED_MATCH') : null,
      bookkeepingReasonCodes: reasonCodes,
      automaticAccountingAction,
      automaticAccountingApprovalBasis,
      passesAutomaticAccountingPolicy,
      bank: {
        occurredAt: bank.occurredAt ?? null,
        eventType: bank.eventType ?? null,
        direction: bank.direction ?? null,
        normalizationStatus: bank.normalizationStatus ?? null,
        evidenceQuality: bank.evidenceQuality ?? null,
        currency: bank.currency ?? null,
        merchant: displayLabel(bank.merchant),
        accountResolutionState: bank.accountResolutionState ?? 'UNKNOWN',
        sourceProviderBindingVerified: bank.sourceProviderBindingVerified === true,
        tbankCardSpecificAccountProofVerified: bank.tbankCardSpecificAccountProofVerified === true,
        ownerProven: bank.ownerProven === true,
        scopeKey: bank.scopeKey ?? null,
      },
      receipt: {
        dateTime: receipt.dateTime ?? null,
        operationType: receipt.operationType ?? null,
        fiscalOperationType: receipt.fiscalOperationType ?? null,
        paymentStage: receipt.paymentStage ?? null,
        paymentComponentsStatus: receipt.paymentComponentsStatus ?? null,
        householdCashDirection: receipt.householdCashDirection ?? null,
        normalizationStatus: receipt.normalizationStatus ?? null,
        currency: receipt.currency ?? null,
        currencyResolved: resolveFnsReceiptCurrency({
          explicitCurrency: receipt.currency,
          fnsSourceProven: receipt.fnsSourceProven === true,
        }).currency,
        merchant: displayLabel(receipt.merchant),
        scopeKeys: Array.isArray(receipt.scopeKeys) ? [...receipt.scopeKeys] : [],
      },
      strictMatcher: strictDecision ? {
        action: strictDecision.orchestrationAction ?? null,
        reasonCode: safeReason(strictDecision.reasonCode, 'STRICT_MATCHER_DECISION'),
      } : {
        bankStatus: strictBankStatus?.status ?? null,
        bankReasonCode: safeReason(strictBankStatus?.reasonCode, null),
        receiptStatus: strictReceiptStatus?.status ?? null,
        receiptReasonCode: safeReason(strictReceiptStatus?.reasonCode, null),
      },
      ledgerWritesAllowed: false,
    };
  }).sort((left, right) => left.receiptId.localeCompare(right.receiptId)
    || left.bankTransactionId.localeCompare(right.bankTransactionId));
}

export function summarizePreliminaryBankReceiptCandidates(candidates = []) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  const bankAdjacency = new Map();
  const receiptAdjacency = new Map();
  for (const candidate of candidates) {
    const bankId = idText(candidate?.bankTransactionId);
    const receiptId = idText(candidate?.receiptId);
    if (!bankId || !receiptId) continue;
    const bankNeighbors = bankAdjacency.get(bankId) ?? new Set();
    bankNeighbors.add(receiptId);
    bankAdjacency.set(bankId, bankNeighbors);
    const receiptNeighbors = receiptAdjacency.get(receiptId) ?? new Set();
    receiptNeighbors.add(bankId);
    receiptAdjacency.set(receiptId, receiptNeighbors);
  }
  const visitedBanks = new Set();
  const visitedReceipts = new Set();
  let ambiguousComponents = 0;
  for (const startBankId of bankAdjacency.keys()) {
    if (visitedBanks.has(startBankId)) continue;
    const bankIds = new Set();
    const receiptIds = new Set();
    const pending = [{ side: 'bank', id: startBankId }];
    while (pending.length) {
      const current = pending.pop();
      if (current.side === 'bank') {
        if (visitedBanks.has(current.id)) continue;
        visitedBanks.add(current.id);
        bankIds.add(current.id);
        for (const id of bankAdjacency.get(current.id) ?? []) pending.push({ side: 'receipt', id });
      } else {
        if (visitedReceipts.has(current.id)) continue;
        visitedReceipts.add(current.id);
        receiptIds.add(current.id);
        for (const id of receiptAdjacency.get(current.id) ?? []) pending.push({ side: 'bank', id });
      }
    }
    if (bankIds.size !== 1 || receiptIds.size !== 1) ambiguousComponents += 1;
  }
  const saved = candidates.filter((row) => row.linkStatus === 'SAVED_EXACT' || row.linkStatus === 'SAVED_STATUS_UNRECORDED');
  return {
    candidateEdges: candidates.length,
    uniqueOneToOnePairs: candidates.filter((row) => row.candidateStatus === PRELIMINARY_CANDIDATE_STATUSES.UNIQUE).length,
    ambiguousEdges: candidates.filter((row) => row.candidateStatus === PRELIMINARY_CANDIDATE_STATUSES.AMBIGUOUS).length,
    ambiguousComponents,
    savedPairs: saved.length,
    savedExactPairs: saved.filter((row) => row.linkStatus === 'SAVED_EXACT').length,
    savedStatusUnrecordedPairs: saved.filter((row) => row.linkStatus === 'SAVED_STATUS_UNRECORDED').length,
    persistedReasonRequiresApprovalPairs: saved.filter((row) => row.persistedReasonCode === 'UNIQUE_COMPATIBLE_PAIR_REQUIRES_APPROVAL').length,
    automaticAccountingPolicyPasses: candidates.filter((row) => row.passesAutomaticAccountingPolicy).length,
  };
}

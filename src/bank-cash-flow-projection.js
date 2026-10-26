import crypto from 'node:crypto';
import { TBANK_ANDROID_PROVIDER } from './matched-purchase-account-proof.js';

export const BANK_CASH_FLOW_PROJECTION_VERSION = 'bank-cash-flow-projection-v1';

export const MOVEMENT_TYPES = Object.freeze({
  PURCHASE: 'PURCHASE',
  OUTGOING_TRANSFER: 'OUTGOING_TRANSFER',
  INCOMING_TRANSFER: 'INCOMING_TRANSFER',
  UNRESOLVED: 'UNRESOLVED',
});

export const PROJECTION_STATUSES = Object.freeze({ PROJECTED: 'PROJECTED', UNRESOLVED: 'UNRESOLVED' });

const ALFA_ANDROID_PROVIDER = 'ru.alfabank.mobile.android';
const OPAQUE_NOTIFICATION_LIFECYCLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_RESOLVED_STATES = new Set(['EXACT', 'MANUAL', 'RECONCILED']);
const SUPPORTED_EVENT_TYPES = new Set(['PURCHASE', 'OUTGOING_TRANSFER', 'INCOMING_TRANSFER']);

function projectionKey(bankTransactionId) {
  return crypto.createHash('sha256')
    .update(`${BANK_CASH_FLOW_PROJECTION_VERSION}\0bank-transaction:${bankTransactionId}`)
    .digest('hex');
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : null;
}

function normalizeOccurredAt(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeAmount(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const integerPart = match[1].replace(/^0+(?=\d)/, '');
  const fractionPart = (match[2] ?? '').padEnd(2, '0');
  return `${integerPart}.${fractionPart}`;
}

function asScopeKeys(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))].sort();
}

export function isTbankCardSpecificAccountProof(row, { scopeKey = null } = {}) {
  const sourceScopeKeys = asScopeKeys(row?.sourceScopeKeys);
  const accountId = Number(row?.financialAccountId);
  const instrumentId = Number(row?.paymentInstrumentId);
  const instrumentAccountId = Number(row?.paymentInstrumentFinancialAccountId);
  const candidateCount = Number(row?.matchingCardReferenceInstrumentCount);
  const resolvedScopeKey = row?.financialAccountScopeKey;
  return row?.provider === TBANK_ANDROID_PROVIDER
    && normalizeText(row.sourceEventType) === 'PURCHASE'
    && normalizeText(row.direction) === 'DEBIT'
    && normalizeText(row.normalizationStatus) === 'READY'
    && normalizeText(row.evidenceQuality) === 'EXACT'
    && normalizeText(row.currency) === 'RUB'
    && row.accountReferenceKind === 'MASKED_CARD'
    && row.accountReference === '****7268'
    && row.paymentInstrumentResolutionState === 'EXACT'
    && row.paymentInstrumentResolutionProvenance === 'OBSERVED_PROVIDER_REFERENCE'
    && row.accountResolutionState === 'EXACT'
    && row.accountResolutionProvenance === 'OBSERVED_PROVIDER_REFERENCE'
    && Number.isSafeInteger(instrumentId) && instrumentId > 0
    && Number.isSafeInteger(accountId) && accountId > 0
    && Number.isSafeInteger(instrumentAccountId) && instrumentAccountId === accountId
    && row.paymentInstrumentProvider === TBANK_ANDROID_PROVIDER
    && row.paymentInstrumentType === 'CARD'
    && row.paymentInstrumentActive === true
    && row.financialAccountActive === true
    && row.paymentInstrumentScopeKey === resolvedScopeKey
    && row.financialAccountCurrency === 'RUB'
    && candidateCount === 1
    && row.tbankReferenceTargetsResolvedInstrument === true
    && sourceScopeKeys.length === 1
    && sourceScopeKeys[0] === resolvedScopeKey
    && (scopeKey == null || sourceScopeKeys[0] === scopeKey);
}

function accountIdentity(row, sourceScopeKeys, requestedScopeKey) {
  const state = normalizeText(row.accountResolutionState);
  const accountId = row.financialAccountId == null ? null : Number(row.financialAccountId);
  const accountScopeKey = typeof row.financialAccountScopeKey === 'string' ? row.financialAccountScopeKey : null;
  const sourceScopeKey = sourceScopeKeys.length === 1 ? sourceScopeKeys[0] : null;
  const scopeConflict = accountId != null && (
    (requestedScopeKey != null && accountScopeKey !== requestedScopeKey)
    || (sourceScopeKey != null && accountScopeKey !== sourceScopeKey)
  );
  const concrete = Number.isInteger(accountId) && accountId > 0 && ACCOUNT_RESOLVED_STATES.has(state) && !scopeConflict;
  return {
    financialAccountId: concrete ? accountId : null,
    accountResolutionState: state,
    accountResolutionProvenance: concrete && typeof row.accountResolutionProvenance === 'string' ? row.accountResolutionProvenance : null,
    accountIdentityStatus: concrete ? 'CONCRETE' : 'UNRESOLVED',
    scopeConflict,
  };
}

function unresolvedReason(row, sourceScopeKeys, requestedScopeKey, account) {
  if (row.manualTroikaTopupAlreadyAccounted === true) return 'MANUAL_TROIKA_TOPUP_ALREADY_ACCOUNTED';
  if (sourceScopeKeys.length !== 1) return 'SOURCE_SCOPE_AMBIGUOUS';
  if (requestedScopeKey != null && sourceScopeKeys[0] !== requestedScopeKey) return 'SOURCE_SCOPE_OUT_OF_SCOPE';
  if (account.scopeConflict) return 'ACCOUNT_SCOPE_CONFLICT';
  if (normalizeText(row.normalizationStatus) !== 'READY') return 'NORMALIZATION_NOT_READY';
  if (normalizeText(row.evidenceQuality) !== 'EXACT') return 'EVIDENCE_NOT_EXACT';
  if (normalizeAmount(row.amount) == null || normalizeText(row.currency) == null || normalizeOccurredAt(row.occurredAt) == null) return 'CASH_FLOW_FACTS_INCOMPLETE';

  const eventType = normalizeText(row.sourceEventType);
  const direction = normalizeText(row.direction);
  if (eventType == null || eventType === 'UNKNOWN') return 'EVENT_TYPE_UNKNOWN';
  if (!SUPPORTED_EVENT_TYPES.has(eventType)) return 'EVENT_TYPE_UNSUPPORTED';
  if ((eventType === 'PURCHASE' && direction !== 'DEBIT')
    || (eventType === 'OUTGOING_TRANSFER' && direction !== 'DEBIT')
    || (eventType === 'INCOMING_TRANSFER' && direction !== 'CREDIT')) return 'EVENT_DIRECTION_CONFLICT';
  return null;
}

function movementType(row) {
  const eventType = normalizeText(row.sourceEventType);
  const direction = normalizeText(row.direction);
  if (eventType === 'PURCHASE' && direction === 'DEBIT') return MOVEMENT_TYPES.PURCHASE;
  if (eventType === 'OUTGOING_TRANSFER' && direction === 'DEBIT') return MOVEMENT_TYPES.OUTGOING_TRANSFER;
  if (eventType === 'INCOMING_TRANSFER' && direction === 'CREDIT') return MOVEMENT_TYPES.INCOMING_TRANSFER;
  return MOVEMENT_TYPES.UNRESOLVED;
}

function projectedReason(movement) {
  if (movement === MOVEMENT_TYPES.PURCHASE) return 'PROVEN_PURCHASE_DEBIT';
  if (movement === MOVEMENT_TYPES.OUTGOING_TRANSFER) return 'PROVEN_OUTGOING_TRANSFER_DEBIT';
  return 'PROVEN_INCOMING_TRANSFER_CREDIT';
}

export function projectBankCashFlowTransaction(row, { scopeKey = null } = {}) {
  if (!row || !Number.isInteger(Number(row.bankTransactionId))) throw new Error('bankTransactionId is required');
  const sourceScopeKeys = asScopeKeys(row.sourceScopeKeys);
  const account = accountIdentity(row, sourceScopeKeys, scopeKey);
  const reasonCode = unresolvedReason(row, sourceScopeKeys, scopeKey, account);
  const projected = reasonCode == null;
  const movement = projected ? movementType(row) : MOVEMENT_TYPES.UNRESOLVED;
  const provenScopeKey = sourceScopeKeys.length === 1
    && (scopeKey == null || sourceScopeKeys[0] === scopeKey)
    ? sourceScopeKeys[0]
    : null;
  return {
    modelVersion: BANK_CASH_FLOW_PROJECTION_VERSION,
    projectionKey: projectionKey(Number(row.bankTransactionId)),
    scopeKey: provenScopeKey,
    bankTransactionId: Number(row.bankTransactionId),
    occurredAt: normalizeOccurredAt(row.occurredAt),
    amount: normalizeAmount(row.amount),
    currency: normalizeText(row.currency),
    sourceEventType: normalizeText(row.sourceEventType) ?? 'UNKNOWN',
    direction: normalizeText(row.direction) ?? 'UNKNOWN',
    normalizationStatus: normalizeText(row.normalizationStatus),
    evidenceQuality: normalizeText(row.evidenceQuality),
    movementType: movement,
    projectionStatus: projected ? PROJECTION_STATUSES.PROJECTED : PROJECTION_STATUSES.UNRESOLVED,
    reasonCode: reasonCode ?? projectedReason(movement),
    financialAccountId: account.financialAccountId,
    accountResolutionState: account.accountResolutionState,
    accountResolutionProvenance: account.accountResolutionProvenance,
    accountIdentityStatus: account.accountIdentityStatus,
    ...(row.sourceProviderBindingVerified !== undefined
      ? { sourceProviderBindingVerified: row.sourceProviderBindingVerified === true }
      : {}),
    ...(typeof row.provider === 'string' ? { provider: row.provider } : {}),
    ...(row.provider === ALFA_ANDROID_PROVIDER
      && OPAQUE_NOTIFICATION_LIFECYCLE_ID.test(row.notificationLifecycleId ?? '')
      ? { notificationLifecycleId: row.notificationLifecycleId }
      : {}),
    ...(row.provider === TBANK_ANDROID_PROVIDER
      ? { tbankCardSpecificAccountProofVerified: isTbankCardSpecificAccountProof(row, { scopeKey }) }
      : {}),
  };
}

export function projectBankCashFlowTransactions(rows, options = {}) {
  const projections = rows.map((row) => projectBankCashFlowTransaction(row, options));
  const unresolvedByReason = {};
  for (const row of projections) if (row.projectionStatus === PROJECTION_STATUSES.UNRESOLVED) unresolvedByReason[row.reasonCode] = (unresolvedByReason[row.reasonCode] ?? 0) + 1;
  const projected = projections.filter((row) => row.projectionStatus === PROJECTION_STATUSES.PROJECTED);
  const unresolved = projections.length - projected.length;
  const summary = {
    totalTransactions: projections.length,
    projectedTransactions: projected.length,
    unresolvedTransactions: unresolved,
    purchases: projected.filter((row) => row.movementType === MOVEMENT_TYPES.PURCHASE).length,
    outgoingTransfers: projected.filter((row) => row.movementType === MOVEMENT_TYPES.OUTGOING_TRANSFER).length,
    incomingTransfers: projected.filter((row) => row.movementType === MOVEMENT_TYPES.INCOMING_TRANSFER).length,
    concreteAccountIdentity: projections.filter((row) => row.accountIdentityStatus === 'CONCRETE').length,
    unresolvedAccountIdentity: projections.filter((row) => row.accountIdentityStatus === 'UNRESOLVED').length,
    unresolvedByReason,
  };
  if (summary.totalTransactions !== summary.projectedTransactions + summary.unresolvedTransactions) throw new Error('Projection summary invariant failed');
  return { projections, summary };
}

function normalizeBankIngestedAfter(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw Object.assign(new Error('bank ingestion cutoff is invalid'), { code: 'BANK_INGESTED_AFTER_INVALID' });
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeBankOccurredAfter(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw Object.assign(new Error('bank purchase cutoff is invalid'), { code: 'BANK_OCCURRED_AFTER_INVALID' });
  }
  return new Date(Date.parse(value)).toISOString();
}

export async function loadBankCashFlowProjection(pool, { scopeKey = null, from = null, to = null, bankIngestedAfter = null, bankOccurredAfter = null, bankTransactionIds = null } = {}) {
  const ingestedAfter = normalizeBankIngestedAfter(bankIngestedAfter);
  const occurredAfter = normalizeBankOccurredAfter(bankOccurredAfter);
  const transactionIds = bankTransactionIds == null ? null : [...new Set(bankTransactionIds.map(Number))];
  if (transactionIds?.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw Object.assign(new Error('bank transaction filter is invalid'), { code: 'BANK_TRANSACTION_FILTER_INVALID' });
  }
  const result = await pool.query(`
    WITH source_scopes AS (
      SELECT bs.id AS bank_source_id,
             COALESCE(array_agg(DISTINCT s.scope_key ORDER BY s.scope_key) FILTER (WHERE s.scope_key IS NOT NULL), ARRAY[]::text[]) AS source_scope_keys
      FROM bank_sources bs
      LEFT JOIN bank_source_person bsp ON bsp.bank_source_id = bs.id
      LEFT JOIN persons p ON p.id = bsp.person_id
      LEFT JOIN accounting_scopes s ON s.id = p.scope_id
      GROUP BY bs.id
    )
    SELECT bt.id AS "bankTransactionId", bt.occurred_at AS "occurredAt", bt.amount, bt.currency,
           bt.event_type AS "sourceEventType", bt.direction,
           bt.normalization_status AS "normalizationStatus", bt.evidence_quality AS "evidenceQuality",
           eo.ingestion_metadata->>'provider' AS provider,
           eo.ingestion_metadata->>'notificationLifecycleId' AS "notificationLifecycleId",
           bt.account_reference AS "accountReference", bt.account_reference_kind AS "accountReferenceKind",
           r.financial_account_id AS "financialAccountId", r.resolution_state AS "accountResolutionState",
           r.provenance AS "accountResolutionProvenance", a_scope.scope_key AS "financialAccountScopeKey",
           a.active AS "financialAccountActive", a.currency AS "financialAccountCurrency",
           pir.payment_instrument_id AS "paymentInstrumentId",
           pir.resolution_state AS "paymentInstrumentResolutionState",
           pir.provenance AS "paymentInstrumentResolutionProvenance",
           pi.financial_account_id AS "paymentInstrumentFinancialAccountId",
           pi.provider AS "paymentInstrumentProvider", pi.instrument_type AS "paymentInstrumentType",
           pi.active AS "paymentInstrumentActive", pi_scope.scope_key AS "paymentInstrumentScopeKey",
           (SELECT count(DISTINCT candidate_pi.id)::integer
            FROM bank_account_references candidate_ref
            JOIN payment_instruments candidate_pi ON candidate_pi.id=candidate_ref.payment_instrument_id
            JOIN financial_accounts candidate_account ON candidate_account.id=candidate_pi.financial_account_id
            WHERE candidate_ref.provider=eo.ingestion_metadata->>'provider'
              AND candidate_ref.reference_kind='MASKED_CARD'
              AND candidate_ref.reference_value=bt.account_reference
              AND candidate_pi.provider=eo.ingestion_metadata->>'provider'
              AND candidate_pi.instrument_type='CARD' AND candidate_pi.active
              AND candidate_pi.scope_id=a.scope_id
              AND candidate_account.scope_id=candidate_pi.scope_id AND candidate_account.active
           ) AS "matchingCardReferenceInstrumentCount",
           EXISTS (
             SELECT 1 FROM bank_account_references exact_ref
             WHERE exact_ref.provider=eo.ingestion_metadata->>'provider'
               AND exact_ref.reference_kind='MASKED_CARD'
               AND exact_ref.reference_value=bt.account_reference
               AND exact_ref.payment_instrument_id=pir.payment_instrument_id
           ) AS "tbankReferenceTargetsResolvedInstrument",
           EXISTS (
             SELECT 1 FROM bank_source_provider_account_bindings binding
             WHERE binding.bank_source_id=eo.bank_source_id
               AND binding.provider=eo.ingestion_metadata->>'provider'
               AND binding.financial_account_id=r.financial_account_id
               AND binding.active
               AND binding.provenance='USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT'
               AND eo.ingestion_metadata->>'provider' IS DISTINCT FROM 'com.idamob.tinkoff.android'
           ) AS "sourceProviderBindingVerified",
           EXISTS (
             SELECT 1 FROM manual_troika_topup_expenses manual_topup
             WHERE manual_topup.scope_id=ANY(
               SELECT p.scope_id FROM bank_source_person bsp JOIN persons p ON p.id=bsp.person_id
               WHERE bsp.bank_source_id=eo.bank_source_id AND bsp.relation_type='OWNER'
             )
               AND manual_topup.bank_transaction_id=bt.id
           ) AS "manualTroikaTopupAlreadyAccounted",
           ss.source_scope_keys AS "sourceScopeKeys"
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id = bt.observation_id
    JOIN source_scopes ss ON ss.bank_source_id = eo.bank_source_id
    LEFT JOIN bank_transaction_account_resolution r ON r.bank_transaction_id = bt.id
    LEFT JOIN financial_accounts a ON a.id = r.financial_account_id
    LEFT JOIN accounting_scopes a_scope ON a_scope.id = a.scope_id
    LEFT JOIN bank_transaction_payment_instrument_resolution pir ON pir.bank_transaction_id=bt.id
    LEFT JOIN payment_instruments pi ON pi.id=pir.payment_instrument_id
    LEFT JOIN accounting_scopes pi_scope ON pi_scope.id=pi.scope_id
    WHERE ($1::text IS NULL OR $1 = ANY(ss.source_scope_keys))
      AND ($2::timestamptz IS NULL OR bt.occurred_at >= $2::timestamptz)
      AND ($3::timestamptz IS NULL OR bt.occurred_at < $3::timestamptz)
      AND ($4::timestamptz IS NULL OR eo.created_at >= $4::timestamptz)
      AND ($5::timestamptz IS NULL OR bt.occurred_at >= $5::timestamptz)
      AND ($6::bigint[] IS NULL OR bt.id=ANY($6::bigint[]))
    ORDER BY bt.id`, [scopeKey, from, to, ingestedAfter, occurredAfter, transactionIds]);
  return projectBankCashFlowTransactions(result.rows, { scopeKey });
}

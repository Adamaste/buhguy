import crypto from 'node:crypto';

export const BANK_CASH_FLOW_PROJECTION_VERSION = 'bank-cash-flow-projection-v1';

export const MOVEMENT_TYPES = Object.freeze({
  PURCHASE: 'PURCHASE',
  OUTGOING_TRANSFER: 'OUTGOING_TRANSFER',
  INCOMING_TRANSFER: 'INCOMING_TRANSFER',
  UNRESOLVED: 'UNRESOLVED',
});

export const PROJECTION_STATUSES = Object.freeze({ PROJECTED: 'PROJECTED', UNRESOLVED: 'UNRESOLVED' });

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

export async function loadBankCashFlowProjection(pool, { scopeKey = null, from = null, to = null } = {}) {
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
           r.financial_account_id AS "financialAccountId", r.resolution_state AS "accountResolutionState",
           r.provenance AS "accountResolutionProvenance", a_scope.scope_key AS "financialAccountScopeKey",
           ss.source_scope_keys AS "sourceScopeKeys"
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id = bt.observation_id
    JOIN source_scopes ss ON ss.bank_source_id = eo.bank_source_id
    LEFT JOIN bank_transaction_account_resolution r ON r.bank_transaction_id = bt.id
    LEFT JOIN financial_accounts a ON a.id = r.financial_account_id
    LEFT JOIN accounting_scopes a_scope ON a_scope.id = a.scope_id
    WHERE ($1::text IS NULL OR $1 = ANY(ss.source_scope_keys))
      AND ($2::timestamptz IS NULL OR bt.occurred_at >= $2::timestamptz)
      AND ($3::timestamptz IS NULL OR bt.occurred_at < $3::timestamptz)
    ORDER BY bt.id`, [scopeKey, from, to]);
  return projectBankCashFlowTransactions(result.rows, { scopeKey });
}

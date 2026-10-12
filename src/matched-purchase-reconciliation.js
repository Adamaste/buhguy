import { runAccountingCatchup } from './accounting-pipeline.js';
import {
  APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
  APPROVED_RECEIPT_WINDOW_MS,
  MAX_PREVIEW_PERIOD_MS,
  PREVIEW_LOCK_TIMEOUT_MS,
  PREVIEW_STATEMENT_TIMEOUT_MS,
} from '../scripts/matched-purchase-preview-read-only.mjs';
import {
  MATCHED_PURCHASE_ORCHESTRATION_VERSION,
  ORCHESTRATION_DECISIONS,
  previewMatchedPurchaseOrchestration,
  validateMatchedPurchaseMatchKey,
} from './matched-purchase-orchestration.js';
import { persistMatchedPurchase } from './matched-purchase-persistence.js';
import { deriveAccountingCatchupScopeKeys } from './source-sync-cycle.js';

export const MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV = 'MATCHED_PURCHASE_RECONCILIATION_ENABLED';
export const MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV = 'MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE';
export const MATCHED_PURCHASE_RECONCILIATION_APPROVED_MATCH_KEY_ENV = 'MATCHED_PURCHASE_RECONCILIATION_APPROVED_MATCH_KEY';
// The per-call write cap is reinforced across both runtime processes by one configured approved key.
export const MATCHED_PURCHASE_RECONCILIATION_MAX_WRITES = 1;

const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

function safeErrorCode(error) {
  return typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code) ? error.code : 'RECONCILIATION_ERROR';
}

export function readMatchedPurchaseReconciliationOptIn(env = process.env) {
  return {
    enabled: env[MATCHED_PURCHASE_RECONCILIATION_ENABLED_ENV] === 'true',
    canaryScopeKey: typeof env[MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV] === 'string'
      ? env[MATCHED_PURCHASE_RECONCILIATION_CANARY_SCOPE_ENV].trim() || null
      : null,
    approvedMatchKey: typeof env[MATCHED_PURCHASE_RECONCILIATION_APPROVED_MATCH_KEY_ENV] === 'string'
      ? env[MATCHED_PURCHASE_RECONCILIATION_APPROVED_MATCH_KEY_ENV].trim().toLowerCase() || null
      : null,
  };
}

export function matchedPurchaseReconciliationWindow(now = new Date()) {
  const end = new Date(now);
  if (!Number.isFinite(end.getTime())) throw new Error('reconciliation window clock is invalid');
  const start = new Date(end.getTime() - MAX_PREVIEW_PERIOD_MS);
  return { from: start.toISOString(), to: end.toISOString() };
}

function emptySummary(status, reasonCode = null) {
  return {
    status,
    ...(reasonCode ? { reasonCode } : {}),
    persisted: 0,
    reused: 0,
    blocked: 0,
    ambiguous: 0,
    ambiguousReceipts: 0,
    errors: 0,
    deferred: 0,
    unmatchedBankPurchases: 0,
    unmatchedReceipts: 0,
  };
}

function readSafeSummary(summary) {
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const fields = {
    persistRequired: integer(summary?.persistRequired),
    alreadyPersisted: integer(summary?.alreadyPersisted),
    blockedMatchedPairs: integer(summary?.blockedMatchedPairs),
    ineligibleBankEntries: integer(summary?.ineligibleBankEntries),
    ineligibleReceipts: integer(summary?.ineligibleReceipts),
    ambiguousBankPurchases: integer(summary?.ambiguousBankPurchases),
    ambiguousReceipts: integer(summary?.ambiguousReceipts),
    unmatchedBankPurchases: integer(summary?.unmatchedBankPurchases),
    unmatchedReceipts: integer(summary?.unmatchedReceipts),
  };
  if (Object.values(fields).some((value) => value === null)) return null;
  return {
    ...fields,
    blocked: fields.blockedMatchedPairs + fields.ineligibleBankEntries + fields.ineligibleReceipts,
    ambiguous: fields.ambiguousBankPurchases,
  };
}

function validDecisionMatchKey(value) {
  try { return typeof value === 'string' && validateMatchedPurchaseMatchKey(value) === value; } catch { return false; }
}

function validateRunOptions({ enabled, scopeKey, canaryScopeKey, approvedMatchKey, from, to, internalTransferMaxTimeDeltaMs, receiptMaxTimeDeltaMs }) {
  if (enabled !== true) return 'OPT_IN_DISABLED';
  if (typeof scopeKey !== 'string' || !scopeKey.trim() || typeof canaryScopeKey !== 'string' || !canaryScopeKey.trim()) return 'CANARY_SCOPE_REQUIRED';
  if (scopeKey !== canaryScopeKey) return 'CANARY_SCOPE_MISMATCH';
  if (!validDecisionMatchKey(approvedMatchKey)) return 'APPROVED_MATCH_KEY_REQUIRED';
  if (typeof from !== 'string' || typeof to !== 'string' || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return 'BOUNDED_PERIOD_REQUIRED';
  const duration = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_PREVIEW_PERIOD_MS) return 'BOUNDED_PERIOD_INVALID';
  if (!Number.isSafeInteger(internalTransferMaxTimeDeltaMs) || internalTransferMaxTimeDeltaMs <= 0
    || !Number.isSafeInteger(receiptMaxTimeDeltaMs) || receiptMaxTimeDeltaMs <= 0) return 'MATCH_WINDOW_INVALID';
  return null;
}

async function loadPreviewReadOnly(pool, preview, options) {
  const client = await pool.connect();
  let transactionOpen = false;
  let rollbackAttempted = false;
  let destroyClient = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${PREVIEW_STATEMENT_TIMEOUT_MS}ms`]);
    await client.query("SELECT set_config('lock_timeout',$1,true)", [`${PREVIEW_LOCK_TIMEOUT_MS}ms`]);
    const readOnly = await client.query("SELECT current_setting('transaction_read_only') AS value");
    if (readOnly.rows[0]?.value !== 'on') throw Object.assign(new Error('read-only preview transaction was not established'), { code: 'PREVIEW_READ_ONLY_REQUIRED' });
    const result = await preview(client, options);
    rollbackAttempted = true;
    await client.query('ROLLBACK');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen && !rollbackAttempted) {
      rollbackAttempted = true;
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        destroyClient = true;
      }
    } else if (transactionOpen) destroyClient = true;
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

export async function runBoundedMatchedPurchaseReconciliation(pool, options = {}) {
  const runOptions = {
    ...options,
    internalTransferMaxTimeDeltaMs: options.internalTransferMaxTimeDeltaMs ?? APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
    receiptMaxTimeDeltaMs: options.receiptMaxTimeDeltaMs ?? APPROVED_RECEIPT_WINDOW_MS,
  };
  const validated = validateRunOptions(runOptions);
  if (validated === 'OPT_IN_DISABLED') return emptySummary('DISABLED');
  if (validated) return { ...emptySummary('BLOCKED', validated), blocked: 1 };

  const preview = options.preview ?? previewMatchedPurchaseOrchestration;
  const persist = options.persist ?? persistMatchedPurchase;
  const result = emptySummary('COMPLETED');
  try {
    const projection = await loadPreviewReadOnly(pool, preview, {
      scopeKey: runOptions.scopeKey,
      matchKey: runOptions.approvedMatchKey,
      approvedMatchKey: runOptions.approvedMatchKey,
      from: new Date(runOptions.from).toISOString(),
      to: new Date(runOptions.to).toISOString(),
      internalTransferMaxTimeDeltaMs: runOptions.internalTransferMaxTimeDeltaMs,
      receiptMaxTimeDeltaMs: runOptions.receiptMaxTimeDeltaMs,
      logger: { info() {} },
    });
    const validReadiness = projection?.readiness === 'READY' || projection?.readiness === 'REVIEW_REQUIRED';
    if (projection?.modelVersion !== MATCHED_PURCHASE_ORCHESTRATION_VERSION || !validReadiness || !Array.isArray(projection.decisions)) {
      result.status = 'ERROR';
      result.errors = 1;
      result.reasonCode = 'PREVIEW_CONTRACT_INVALID';
      return result;
    }

    const actions = new Set(Object.values(ORCHESTRATION_DECISIONS));
    if (projection.decisions.some((decision) => !decision
      || decision.scopeKey !== runOptions.scopeKey
      || !actions.has(decision.orchestrationAction)
      || !validDecisionMatchKey(decision.matchKey))) {
      result.status = 'ERROR';
      result.errors = 1;
      result.reasonCode = 'PREVIEW_CONTRACT_INVALID';
      return result;
    }
    const safeSummary = readSafeSummary(projection.summary);
    if (!safeSummary) {
      result.status = 'ERROR';
      result.errors = 1;
      result.reasonCode = 'PREVIEW_CONTRACT_INVALID';
      return result;
    }

    const reusable = projection.decisions.filter((decision) => decision.orchestrationAction === ORCHESTRATION_DECISIONS.NOOP_ALREADY_PERSISTED);
    const writable = projection.decisions
      .filter((decision) => decision.orchestrationAction === ORCHESTRATION_DECISIONS.PERSIST_REQUIRED)
      .sort((left, right) => String(left.matchKey).localeCompare(String(right.matchKey)));
    const blockedDecisions = projection.decisions.filter((decision) => decision.orchestrationAction === ORCHESTRATION_DECISIONS.BLOCKED);
    if (safeSummary.persistRequired !== writable.length
      || safeSummary.alreadyPersisted !== reusable.length
      || safeSummary.blockedMatchedPairs !== blockedDecisions.length
      || writable.some((decision) => decision.matchKey !== runOptions.approvedMatchKey)) {
      result.status = 'ERROR';
      result.errors = 1;
      result.reasonCode = 'PREVIEW_CONTRACT_INVALID';
      return result;
    }
    Object.assign(result, {
      blocked: safeSummary.blocked,
      ambiguous: safeSummary.ambiguous,
      ambiguousReceipts: safeSummary.ambiguousReceipts,
      unmatchedBankPurchases: safeSummary.unmatchedBankPurchases,
      unmatchedReceipts: safeSummary.unmatchedReceipts,
    });
    result.reused = reusable.length;
    result.deferred = Math.max(0, writable.length - MATCHED_PURCHASE_RECONCILIATION_MAX_WRITES);

    const selected = writable.find((decision) => decision.matchKey === runOptions.approvedMatchKey);
    if (selected) {
      if (typeof selected.matchKey !== 'string' || selected.scopeKey !== options.scopeKey) {
        result.status = 'ERROR';
        result.errors = 1;
        result.reasonCode = 'MATCH_SELECTION_INVALID';
        return result;
      }
      try {
        const persisted = await persist(pool, {
          scopeKey: runOptions.scopeKey,
          from: new Date(runOptions.from).toISOString(),
          to: new Date(runOptions.to).toISOString(),
          matchKey: selected.matchKey,
          approvedMatchKey: runOptions.approvedMatchKey,
          internalTransferMaxTimeDeltaMs: runOptions.internalTransferMaxTimeDeltaMs,
          receiptMaxTimeDeltaMs: runOptions.receiptMaxTimeDeltaMs,
        });
        if (persisted?.outcome === 'REUSED') result.reused += 1;
        else if (persisted?.outcome === 'PERSISTED') result.persisted += 1;
        else throw Object.assign(new Error('writer result contract is invalid'), { code: 'WRITER_RESULT_INVALID' });
      } catch (error) {
        result.errors += 1;
        result.reasonCode = safeErrorCode(error);
      }
    }
    if (result.errors) result.status = 'ERROR';
    else if (result.blocked || result.ambiguous) result.status = 'REVIEW_REQUIRED';
    return result;
  } catch (error) {
    result.status = 'ERROR';
    result.errors = 1;
    result.reasonCode = safeErrorCode(error);
    return result;
  }
}

export async function runAccountingCatchupsWithMatchedPurchaseCanary({
  pool,
  sources,
  scopeOverride = null,
  canary = readMatchedPurchaseReconciliationOptIn(),
  logger = console,
  now = new Date(),
  runCatchup = (scopeKey) => runAccountingCatchup(pool, { scopeKey, logger }),
  reconcile = runBoundedMatchedPurchaseReconciliation,
} = {}) {
  const scopeKeys = deriveAccountingCatchupScopeKeys(sources, scopeOverride);
  const reconciliations = [];
  for (const scopeKey of scopeKeys) {
    await runCatchup(scopeKey);
    if (canary?.enabled === true && canary.canaryScopeKey === scopeKey) {
      reconciliations.push(await reconcile(pool, {
        ...matchedPurchaseReconciliationWindow(now),
        enabled: true,
        scopeKey,
        canaryScopeKey: canary.canaryScopeKey,
        approvedMatchKey: canary.approvedMatchKey,
        internalTransferMaxTimeDeltaMs: APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
        receiptMaxTimeDeltaMs: APPROVED_RECEIPT_WINDOW_MS,
      }));
    }
  }
  return { scopeKeys, reconciliations };
}

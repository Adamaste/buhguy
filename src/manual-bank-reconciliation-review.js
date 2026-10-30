import {
  APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
  APPROVED_RECEIPT_WINDOW_MS,
} from './matched-purchase-reconciliation-constants.js';
import { loadBankReceiptMatching } from './bank-receipt-matching.js';
import { persistMatchedPurchase } from './matched-purchase-persistence.js';
import { lockMatchedPurchaseBankTransaction, lockMatchedPurchaseSourceProvider } from './matched-purchase-locks.js';
import {
  assertManualReviewCohortCutoff,
  insertManualReviewEvidence,
  MANUAL_RECONCILIATION_REVIEW_KINDS,
  manualReviewKey,
  normalizeManualReviewEvidence,
} from './manual-reconciliation-evidence.js';

const integerId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function loadHistoricalAccountContext(client, bankTransactionId, financialAccountId) {
  const row = (await client.query(`SELECT bt.id,bt.amount::text AS amount,bt.currency,bt.event_type,bt.direction,
      bt.normalization_status,bt.evidence_quality,bt.occurred_at,eo.created_at AS observed_at,
      eo.bank_source_id,eo.ingestion_metadata->>'provider' AS provider,
      COALESCE(array_agg(DISTINCT p.scope_id) FILTER (WHERE p.scope_id IS NOT NULL),ARRAY[]::bigint[]) AS source_scope_ids,
      resolution.financial_account_id AS resolved_account_id,resolution.resolution_state,
      account.id AS target_account_id,account.scope_id AS target_scope_id,account.currency AS target_currency,
      account.active AS target_account_active
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id=bt.observation_id
    LEFT JOIN bank_source_person sp ON sp.bank_source_id=eo.bank_source_id AND sp.relation_type='OWNER'
    LEFT JOIN persons p ON p.id=sp.person_id
    LEFT JOIN bank_transaction_account_resolution resolution ON resolution.bank_transaction_id=bt.id
    LEFT JOIN financial_accounts account ON account.id=$2
    WHERE bt.id=$1
    GROUP BY bt.id,eo.created_at,eo.bank_source_id,eo.ingestion_metadata,resolution.financial_account_id,
      resolution.resolution_state,account.id,account.scope_id,account.currency,account.active`, [bankTransactionId, financialAccountId])).rows[0];
  if (!row) return { reasonCode: 'BANK_TRANSACTION_NOT_FOUND' };
  if (row.event_type !== 'PURCHASE' || row.direction !== 'DEBIT'
    || row.normalization_status !== 'READY' || row.evidence_quality !== 'EXACT'
    || !row.amount || !row.currency) return { row, reasonCode: 'BANK_EVENT_NOT_EXACT_PURCHASE' };
  if (!Array.isArray(row.source_scope_ids) || row.source_scope_ids.length !== 1) return { row, reasonCode: 'BANK_SOURCE_SCOPE_NOT_UNIQUE' };
  if (!row.target_account_id || row.target_account_active !== true) return { row, reasonCode: 'ACCOUNT_NOT_FOUND_OR_INACTIVE' };
  const scopeId = Number(row.source_scope_ids[0]);
  if (Number(row.target_scope_id) !== scopeId || row.target_currency !== row.currency) return { row, reasonCode: 'ACCOUNT_SCOPE_OR_CURRENCY_MISMATCH' };
  if (row.resolution_state && (row.resolution_state !== 'UNKNOWN' || row.resolved_account_id != null)) return { row, reasonCode: 'ACCOUNT_ALREADY_RESOLVED' };
  const accounted = await client.query(`SELECT
      EXISTS(SELECT 1 FROM bank_receipt_matches WHERE bank_transaction_id=$1) AS matched,
      EXISTS(SELECT 1 FROM ledger_source_links WHERE bank_transaction_id=$1) AS ledger_linked,
      EXISTS(SELECT 1 FROM manual_troika_topup_expenses WHERE bank_transaction_id=$1) AS legacy_accounted`, [bankTransactionId]);
  if (accounted.rows[0].matched || accounted.rows[0].ledger_linked || accounted.rows[0].legacy_accounted) {
    return { row, reasonCode: 'BANK_TRANSACTION_ALREADY_ACCOUNTED' };
  }
  return { row, scopeId, reasonCode: null };
}

/**
 * Review a single historical bank transaction against independent statement/API
 * evidence. Dry-run is the default. A persisted result changes only the one
 * account-resolution row and appends evidence metadata; it never writes a ledger.
 */
export async function reviewHistoricalBankAccountResolution(pool, {
  bankTransactionId: rawBankTransactionId,
  financialAccountId: rawFinancialAccountId,
  evidence: rawEvidence = null,
  persist = false,
} = {}) {
  const bankTransactionId = integerId(rawBankTransactionId);
  const financialAccountId = integerId(rawFinancialAccountId);
  if (!bankTransactionId || !financialAccountId) fail('HISTORICAL_REVIEW_IDS_INVALID');
  if (typeof persist !== 'boolean') fail('HISTORICAL_REVIEW_PERSIST_INVALID');
  const evidence = persist ? normalizeManualReviewEvidence(rawEvidence, { reviewKind: MANUAL_RECONCILIATION_REVIEW_KINDS.ACCOUNT_RESOLUTION }) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockMatchedPurchaseBankTransaction(client, bankTransactionId);
    const lockedAccount = (await client.query('SELECT id FROM financial_accounts WHERE id=$1 FOR SHARE', [financialAccountId])).rows[0];
    if (!lockedAccount) {
      await client.query('ROLLBACK');
      return { status: 'FAIL_CLOSED', reasonCode: 'ACCOUNT_NOT_FOUND_OR_INACTIVE' };
    }
    const context = await loadHistoricalAccountContext(client, bankTransactionId, financialAccountId);
    if (persist && context.row && Number(context.row.resolved_account_id) === financialAccountId
      && Number(context.row.source_scope_ids?.length) === 1) {
      const scopeId = Number(context.row.source_scope_ids[0]);
      const reviewKey = manualReviewKey({ scopeId, bankTransactionId, financialAccountId, evidence });
      const existingReview = (await client.query(`SELECT id FROM manual_bank_reconciliation_review_evidence
        WHERE review_key=$1 AND review_kind='ACCOUNT_RESOLUTION'`, [reviewKey])).rows[0];
      if (existingReview) {
        await client.query('COMMIT');
        return { status: 'ALREADY_REVIEWED', bankTransactionId, financialAccountId, scopeId, evidenceReviewId: Number(existingReview.id), ledgerChanged: false };
      }
    }
    if (context.reasonCode) {
      await client.query('ROLLBACK');
      return { status: 'FAIL_CLOSED', reasonCode: context.reasonCode };
    }
    if (!context.row.provider || !Number.isSafeInteger(Number(context.row.bank_source_id))) {
      await client.query('ROLLBACK');
      return { status: 'FAIL_CLOSED', reasonCode: 'BANK_SOURCE_PROVIDER_UNAVAILABLE' };
    }
    await lockMatchedPurchaseSourceProvider(client, Number(context.row.bank_source_id), context.row.provider);
    if (!persist) {
      await client.query('ROLLBACK');
      return {
        status: 'DRY_RUN',
        bankTransactionId,
        financialAccountId,
        scopeId: context.scopeId,
        eventType: context.row.event_type,
        direction: context.row.direction,
        normalizationStatus: context.row.normalization_status,
        evidenceQuality: context.row.evidence_quality,
        amount: context.row.amount,
        currency: context.row.currency,
        occurredAt: iso(context.row.occurred_at),
        observedAt: iso(context.row.observed_at),
        currentResolution: 'UNKNOWN',
        evidenceRequired: true,
        ledgerChanged: false,
      };
    }

    const insertedEvidence = await insertManualReviewEvidence(client, {
      scopeId: context.scopeId, bankTransactionId, financialAccountId, evidence,
    });
    const resolution = await client.query(`INSERT INTO bank_transaction_account_resolution
        (bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
      VALUES($1,$2,'RECONCILED','INDEPENDENT_EXTERNAL_BANK_EVIDENCE',
        'One historical transaction reviewed against independent bank statement/API evidence')
      ON CONFLICT(bank_transaction_id) DO UPDATE SET
        financial_account_id=EXCLUDED.financial_account_id,
        resolution_state=EXCLUDED.resolution_state,
        provenance=EXCLUDED.provenance,
        reason=EXCLUDED.reason,
        resolved_at=NOW()
      WHERE bank_transaction_account_resolution.resolution_state='UNKNOWN'
        AND bank_transaction_account_resolution.financial_account_id IS NULL
      RETURNING bank_transaction_id`, [bankTransactionId, financialAccountId]);
    if (!resolution.rowCount) fail('ACCOUNT_RESOLUTION_CHANGED_DURING_REVIEW');
    await client.query('COMMIT');
    return {
      status: insertedEvidence.reused ? 'ALREADY_REVIEWED' : 'ACCOUNT_RESOLVED_FROM_EXTERNAL_EVIDENCE',
      bankTransactionId,
      financialAccountId,
      scopeId: context.scopeId,
      evidenceReviewId: insertedEvidence.id,
      ledgerChanged: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function loadPairContext(pool, { bankTransactionId, receiptId, financialAccountId, scopeKey }) {
  const context = (await pool.query(`SELECT bt.id,bt.amount::text AS bank_amount,bt.currency AS bank_currency,
      bt.occurred_at,eo.created_at AS observed_at,ar.financial_account_id AS resolved_account_id,
      ar.resolution_state,ar.provenance AS resolution_provenance,
      r.date_time AS receipt_date_time,r.total_sum::text AS receipt_total,r.currency AS receipt_currency,
      scope.id AS scope_id,scope.scope_key,
      account.scope_id AS account_scope_id,account.currency AS account_currency,account.active AS account_active,
      COALESCE(array_agg(DISTINCT source_scope.scope_id) FILTER (WHERE source_scope.scope_id IS NOT NULL),ARRAY[]::bigint[]) AS source_scope_ids
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id=bt.observation_id
    JOIN receipts r ON r.id=$2
    JOIN accounting_scopes scope ON scope.scope_key=$4
    JOIN financial_accounts account ON account.id=$3
    LEFT JOIN bank_transaction_account_resolution ar ON ar.bank_transaction_id=bt.id
    LEFT JOIN bank_source_person sp ON sp.bank_source_id=eo.bank_source_id AND sp.relation_type='OWNER'
    LEFT JOIN persons source_scope ON source_scope.id=sp.person_id
    WHERE bt.id=$1
    GROUP BY bt.id,eo.created_at,ar.financial_account_id,ar.resolution_state,ar.provenance,
      r.date_time,r.total_sum,r.currency,scope.id,scope.scope_key,account.scope_id,account.currency,account.active`,
  [bankTransactionId, receiptId, financialAccountId, scopeKey])).rows[0];
  if (!context) return { reasonCode: 'HISTORICAL_REVIEW_TARGET_NOT_FOUND' };
  if (!context.resolution_state || context.resolution_state === 'UNKNOWN'
    || Number(context.resolved_account_id) !== financialAccountId) return { reasonCode: 'BANK_ACCOUNT_NOT_RESOLVED_TO_SELECTED_ACCOUNT' };
  if (Number(context.account_scope_id) !== Number(context.scope_id)
    || Number(context.source_scope_ids?.length) !== 1
    || Number(context.source_scope_ids[0]) !== Number(context.scope_id)
    || context.account_currency !== context.bank_currency || context.account_active !== true) return { reasonCode: 'HISTORICAL_REVIEW_SCOPE_OR_CURRENCY_CONFLICT' };
  if (context.bank_currency !== 'RUB' || context.receipt_currency && context.receipt_currency !== 'RUB'
    || context.receipt_total !== context.bank_amount) return { reasonCode: 'HISTORICAL_REVIEW_AMOUNT_OR_CURRENCY_CONFLICT' };
  return { context, reasonCode: null };
}

async function loadUniquePair(pool, { bankTransactionId, receiptId, financialAccountId, scopeKey }) {
  const loaded = await loadPairContext(pool, { bankTransactionId, receiptId, financialAccountId, scopeKey });
  if (loaded.reasonCode) return { ...loaded, pair: null };
  const { context } = loaded;
  const bankAt = new Date(context.occurred_at).getTime();
  const receiptAt = new Date(context.receipt_date_time).getTime();
  const from = new Date(Math.min(bankAt, receiptAt) - APPROVED_RECEIPT_WINDOW_MS).toISOString();
  const to = new Date(Math.max(bankAt, receiptAt) + APPROVED_RECEIPT_WINDOW_MS + 1).toISOString();
  const matching = await loadBankReceiptMatching(pool, {
    scopeKey,
    from,
    to,
    internalTransferMaxTimeDeltaMs: APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
    receiptMaxTimeDeltaMs: APPROVED_RECEIPT_WINDOW_MS,
  });
  const competingMatches = matching.matches.filter((item) => Number(item.bank.bankTransactionId) === bankTransactionId
    || Number(item.receipt.receiptId) === receiptId);
  if (competingMatches.length !== 1
    || Number(competingMatches[0].bank.bankTransactionId) !== bankTransactionId
    || Number(competingMatches[0].receipt.receiptId) !== receiptId) {
    return { context, matching, from, to, pair: null, reasonCode: 'PAIR_NOT_UNIQUE_IN_MATCHER_COMPONENT' };
  }
  const pair = competingMatches[0];
  if (Number(pair.bank.financialAccountId) !== financialAccountId
    || pair.reasonCode !== 'UNIQUE_COMPATIBLE_PAIR_REQUIRES_APPROVAL'
    || pair.timeDeltaMs > APPROVED_RECEIPT_WINDOW_MS) return { context, matching, from, to, pair: null, reasonCode: 'PAIR_REQUIRES_DIFFERENT_EVIDENCE_OR_REVIEW' };
  return { context, matching, from, to, pair, reasonCode: null };
}

export async function previewHistoricalReceiptBankMatch(pool, ids = {}) {
  const bankTransactionId = integerId(ids.bankTransactionId);
  const receiptId = integerId(ids.receiptId);
  const financialAccountId = integerId(ids.financialAccountId);
  const scopeKey = typeof ids.scopeKey === 'string' ? ids.scopeKey : '';
  if (!bankTransactionId || !receiptId || !financialAccountId || !scopeKey) fail('HISTORICAL_REVIEW_IDS_INVALID');
  const result = await loadUniquePair(pool, { bankTransactionId, receiptId, financialAccountId, scopeKey });
  if (!result.pair) return { status: 'FAIL_CLOSED', reasonCode: result.reasonCode };
  return {
    status: 'DRY_RUN',
    bankTransactionId,
    receiptId,
    financialAccountId,
    scopeKey,
    amount: result.pair.amount,
    currency: result.pair.currency,
    timeDeltaMs: result.pair.timeDeltaMs,
    matchKey: result.pair.matchKey,
    reasonCode: result.pair.reasonCode,
    competingPairCount: 0,
    bankOccurredAt: iso(result.context.occurred_at),
    bankObservedAt: iso(result.context.observed_at),
    receiptDateTime: iso(result.context.receipt_date_time),
    from: result.from,
    to: result.to,
    ledgerChanged: false,
  };
}

/** Persist exactly one independently evidenced pre-cohort pair through the
 * existing matched-purchase writer. There is no batch or automatic mode here. */
export async function approveHistoricalReceiptBankMatch(pool, {
  bankTransactionId: rawBankTransactionId,
  receiptId: rawReceiptId,
  financialAccountId: rawFinancialAccountId,
  scopeKey,
  expectedMatchKey,
  cohortCutoff,
  evidence: rawEvidence,
  persist = false,
} = {}) {
  const bankTransactionId = integerId(rawBankTransactionId);
  const receiptId = integerId(rawReceiptId);
  const financialAccountId = integerId(rawFinancialAccountId);
  if (!bankTransactionId || !receiptId || !financialAccountId || typeof scopeKey !== 'string' || !scopeKey) fail('HISTORICAL_REVIEW_IDS_INVALID');
  if (typeof persist !== 'boolean') fail('HISTORICAL_REVIEW_PERSIST_INVALID');
  const cutoffMs = assertManualReviewCohortCutoff(cohortCutoff);
  const result = await loadUniquePair(pool, { bankTransactionId, receiptId, financialAccountId, scopeKey });
  if (!result.pair) return { status: 'FAIL_CLOSED', reasonCode: result.reasonCode };
  if (typeof expectedMatchKey !== 'string' || result.pair.matchKey !== expectedMatchKey.toLowerCase()) {
    return { status: 'FAIL_CLOSED', reasonCode: 'EXPECTED_MATCH_KEY_MISMATCH' };
  }
  if (Date.parse(result.context.occurred_at) >= cutoffMs
    || Date.parse(result.context.observed_at) >= cutoffMs
    || Date.parse(result.context.receipt_date_time) >= cutoffMs) {
    return { status: 'FAIL_CLOSED', reasonCode: 'PAIR_IS_NOT_PRE_COHORT' };
  }
  if (!persist) {
    return { ...(await previewHistoricalReceiptBankMatch(pool, { bankTransactionId, receiptId, financialAccountId, scopeKey })), cohortCutoff: cohortCutoff };
  }
  const evidence = normalizeManualReviewEvidence(rawEvidence, {
    reviewKind: MANUAL_RECONCILIATION_REVIEW_KINDS.RECEIPT_BANK_MATCH,
    receiptId,
    cohortCutoff,
    matchKey: result.pair.matchKey,
  });
  const persisted = await persistMatchedPurchase(pool, {
    scopeKey,
    from: result.from,
    to: result.to,
    internalTransferMaxTimeDeltaMs: APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
    receiptMaxTimeDeltaMs: APPROVED_RECEIPT_WINDOW_MS,
    matchKey: result.pair.matchKey,
    approvedMatchKey: result.pair.matchKey,
    historicalReviewEvidence: {
      evidence: {
        evidenceType: evidence.evidenceType,
        evidenceSha256: evidence.evidenceSha256,
        evidenceReferenceSha256: evidence.evidenceReferenceSha256,
        reviewerCode: evidence.reviewerCode,
      },
      cohortCutoff: evidence.cohortCutoff,
    },
  });
  return { status: persisted.outcome === 'REUSED' ? 'APPROVED_AND_ALREADY_ACCOUNTED' : 'APPROVED_AND_PERSISTED', ...persisted };
}

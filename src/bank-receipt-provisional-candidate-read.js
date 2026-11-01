import { PRELIMINARY_BANK_RECEIPT_WINDOW_MS } from './bank-receipt-provisional-candidates.js';

const REPORT_MAX_PERIOD_MS = 60 * 24 * 60 * 60 * 1000;
const READ_STATEMENT_TIMEOUT_MS = 30_000;
const READ_LOCK_TIMEOUT_MS = 2_000;

function validIso(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

export function validatePreliminaryCandidatePeriod({ from, to } = {}) {
  const normalizedFrom = validIso(from, 'from');
  const normalizedTo = validIso(to, 'to');
  const duration = Date.parse(normalizedTo) - Date.parse(normalizedFrom);
  if (duration <= 0 || duration > REPORT_MAX_PERIOD_MS) throw new RangeError('report period must be positive and at most 60 days');
  return { from: normalizedFrom, to: normalizedTo };
}

export async function loadPreliminaryCandidateRows(pool, period) {
  const { from, to } = validatePreliminaryCandidatePeriod(period);
  const params = [from, to, PRELIMINARY_BANK_RECEIPT_WINDOW_MS];
  const bankRows = await pool.query(`
      SELECT bt.id::text AS "bankTransactionId", bt.occurred_at AS "occurredAt",
             bt.amount::text AS amount, bt.currency,
             bt.event_type AS "eventType", bt.direction,
             bt.normalization_status AS "normalizationStatus", bt.evidence_quality AS "evidenceQuality",
             bt.merchant, eo.created_at AS "observationCreatedAt",
             resolution.resolution_state AS "accountResolutionState",
             account_scope.scope_key AS "scopeKey",
             EXISTS (
               SELECT 1 FROM financial_account_person_relations owner_relation
               JOIN persons owner_person ON owner_person.id=owner_relation.person_id
               JOIN accounting_scopes owner_scope ON owner_scope.id=owner_person.scope_id
               WHERE owner_relation.financial_account_id=resolution.financial_account_id
                 AND owner_relation.relation_type='OWNER'
                 AND owner_scope.id=account.scope_id
                 AND owner_scope.scope_key=account_scope.scope_key
                 AND btrim(owner_relation.provenance)<>''
             ) AS "ownerProven",
             EXISTS (
               SELECT 1 FROM bank_source_provider_account_bindings binding
               WHERE binding.bank_source_id=eo.bank_source_id
                 AND binding.provider=eo.ingestion_metadata->>'provider'
                 AND binding.financial_account_id=resolution.financial_account_id
                 AND binding.active
                 AND binding.provenance='USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT'
                 AND eo.ingestion_metadata->>'provider' IS NOT NULL
             ) AS "sourceProviderBindingVerified"
      FROM bank_transactions bt
      JOIN bank_event_observations eo ON eo.id=bt.observation_id
      LEFT JOIN bank_transaction_account_resolution resolution ON resolution.bank_transaction_id=bt.id
      LEFT JOIN financial_accounts account ON account.id=resolution.financial_account_id
      LEFT JOIN accounting_scopes account_scope ON account_scope.id=account.scope_id
      WHERE bt.occurred_at >= $1::timestamptz - ($3::bigint * interval '1 millisecond')
        AND bt.occurred_at < $2::timestamptz + ($3::bigint * interval '1 millisecond')
      ORDER BY bt.occurred_at, bt.id`, params);
  const receiptRows = await pool.query(`
      SELECT r.id::text AS "receiptId", r.date_time AS "dateTime",
             r.total_sum::text AS amount, r.currency, r.seller AS merchant,
             r.operation_type AS "operationType",
             facts.fiscal_operation_type AS "fiscalOperationType",
             facts.normalization_status AS "normalizationStatus",
             facts.household_cash_direction AS "householdCashDirection",
             facts.payment_components_status AS "paymentComponentsStatus",
             facts.payment_stage AS "paymentStage",
             facts.correction_status AS "correctionStatus",
             COALESCE(fns_source."fnsSourceProven", FALSE) AS "fnsSourceProven",
             COALESCE(receipt_scopes."scopeKeys", ARRAY[]::text[]) AS "scopeKeys",
             COALESCE(item_coverage."receiptItemCount", 0)::integer AS "receiptItemCount",
             COALESCE(item_coverage."normalizedItemFactCount", 0)::integer AS "normalizedItemFactCount",
             COALESCE(item_coverage."itemPaymentTypeCodes", ARRAY[]::smallint[]) AS "itemPaymentTypeCodes"
      FROM receipts r
      LEFT JOIN receipt_fiscal_facts facts
        ON facts.receipt_id=r.id AND facts.normalization_version='fiscal-normalizer-v1'
      LEFT JOIN LATERAL (
        SELECT TRUE AS "fnsSourceProven"
        FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        WHERE observation.receipt_id=r.id
        LIMIT 1
      ) fns_source ON TRUE
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT scope.scope_key ORDER BY scope.scope_key)
                 FILTER (WHERE scope.scope_key IS NOT NULL) AS "scopeKeys"
        FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        JOIN accounting_scopes scope ON scope.id=source.scope_id
        WHERE observation.receipt_id=r.id
      ) receipt_scopes ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT item.id)::integer AS "receiptItemCount",
               count(DISTINCT item_fact.receipt_item_id)::integer AS "normalizedItemFactCount",
               array_agg(item_fact.payment_type_code ORDER BY item.id)
                 FILTER (WHERE item_fact.receipt_item_id IS NOT NULL) AS "itemPaymentTypeCodes"
        FROM receipt_items item
        LEFT JOIN receipt_item_fiscal_facts item_fact
          ON item_fact.receipt_item_id=item.id AND item_fact.normalization_version='fiscal-normalizer-v1'
        WHERE item.receipt_id=r.id
      ) item_coverage ON TRUE
      WHERE r.date_time >= $1::timestamptz - ($3::bigint * interval '1 millisecond')
        AND r.date_time < $2::timestamptz + ($3::bigint * interval '1 millisecond')
      ORDER BY r.date_time, r.id`, params);
  const persistedMatches = await pool.query(`
      SELECT match.bank_transaction_id::text AS "bankTransactionId",
             match.receipt_id::text AS "receiptId", match.reason_code AS "reasonCode"
      FROM bank_receipt_matches match
      WHERE (match.bank_occurred_at >= $1::timestamptz AND match.bank_occurred_at < $2::timestamptz)
         OR (match.receipt_date_time >= $1::timestamptz AND match.receipt_date_time < $2::timestamptz)
      ORDER BY match.bank_transaction_id, match.receipt_id`, [from, to]);
  return { bankRows: bankRows.rows, receiptRows: receiptRows.rows, persistedMatches: persistedMatches.rows };
}

export async function runPreliminaryCandidateRead(pool, period, options = {}) {
  const normalizedPeriod = validatePreliminaryCandidatePeriod(period);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${READ_STATEMENT_TIMEOUT_MS}ms`]);
    await client.query("SELECT set_config('lock_timeout',$1,true)", [`${READ_LOCK_TIMEOUT_MS}ms`]);
    const readOnly = await client.query("SELECT current_setting('transaction_read_only') AS value");
    if (readOnly.rows[0]?.value !== 'on') throw new Error('read-only transaction was not established');
    const data = await loadPreliminaryCandidateRows(client, normalizedPeriod);
    const candidates = await options.findCandidates(data, normalizedPeriod, client, options.strict ?? {});
    await client.query('ROLLBACK');
    transactionOpen = false;
    return { period: normalizedPeriod, ...candidates };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const PRELIMINARY_CANDIDATE_READ_LIMITS = Object.freeze({
  maxPeriodMs: REPORT_MAX_PERIOD_MS,
  statementTimeoutMs: READ_STATEMENT_TIMEOUT_MS,
  lockTimeoutMs: READ_LOCK_TIMEOUT_MS,
});

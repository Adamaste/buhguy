-- Reproduce source-grain coverage for two separate Moscow-date intervals:
-- 1–26 October and 1 October through 29 October 2026 (inclusive).
-- READ ONLY: aggregate output only; no identifiers, people, merchants, or raw
-- notification/fiscal payloads are selected.
-- Run with a SELECT-only PostgreSQL role. The certified-spend total still must
-- be validated with resolveCurrentSpendingSnapshot/currentHouseholdSummary.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';

-- 1. READY acquisition amounts in the default scope, at business-event grain.
-- Include PURCHASE and the one FULFILLMENT lifecycle event that recognizes
-- acquisition from a merchant advance. The advance itself is not an expense.
-- Blocked/unsupported rows and superseded history are excluded.
WITH periods(period_key,period_start,period_end) AS (VALUES
  ('oct_01_26', TIMESTAMPTZ '2026-09-30 21:00:00+00', TIMESTAMPTZ '2026-10-26 21:00:00+00'),
  ('oct_01_29_as_of_2026_10_29', TIMESTAMPTZ '2026-09-30 21:00:00+00', TIMESTAMPTZ '2026-10-29 21:00:00+00')
), active_entry_rows AS (
  SELECT p.period_key, be.id, be.event_type, be.amount, be.currency, le.id AS ledger_entry_id
  FROM periods p
  JOIN business_events be ON TRUE
  JOIN accounting_scopes sc
    ON sc.id=be.scope_id AND sc.scope_key='default'
  JOIN ledger_entries le ON le.scope_id=be.scope_id AND le.source_event_id=be.id
  WHERE (be.event_type='PURCHASE'
         OR (be.event_type='FULFILLMENT' AND be.rule_code='PREPAYMENT_SETTLEMENT_V1'))
    AND be.resolution_status='CONFIRMED'
    AND le.derivation_status='READY'
    AND le.certification_status IN ('BUSINESS_CONFIRMED','FUNDING_UNRECONCILED','CERTIFIED')
    AND le.event_at >= p.period_start AND le.event_at < p.period_end
    AND NOT EXISTS (
      SELECT 1 FROM ledger_entry_supersessions s
      WHERE s.scope_id=le.scope_id AND s.superseded_ledger_entry_id=le.id
    )
), active_acquisition_events AS (
  SELECT period_key,id,event_type,amount,currency,
         count(DISTINCT ledger_entry_id) AS active_ready_ledger_entries
  FROM active_entry_rows
  GROUP BY period_key,id,event_type,amount,currency
)
SELECT period_key,'active_ready_acquisition_events' AS metric,
       event_type,
       currency,
       count(*) AS unique_events,
       sum(amount)::numeric(18,2) AS amount,
       count(*) FILTER (WHERE active_ready_ledger_entries <> 1) AS events_without_exactly_one_ready_entry
FROM active_acquisition_events
GROUP BY period_key,event_type,currency
ORDER BY period_key,event_type,currency;

-- 2. READY bank purchase debits at transaction grain, split by whether any
-- scope has a non-superseded READY ledger event linked to the transaction.
-- This is source-link coverage only and makes no owner attribution.
WITH periods(period_key,period_start,period_end) AS (VALUES
  ('oct_01_26', TIMESTAMPTZ '2026-09-30 21:00:00+00', TIMESTAMPTZ '2026-10-26 21:00:00+00'),
  ('oct_01_29_as_of_2026_10_29', TIMESTAMPTZ '2026-09-30 21:00:00+00', TIMESTAMPTZ '2026-10-29 21:00:00+00')
), active_purchase_events AS (
  SELECT DISTINCT be.scope_id, be.id
  FROM business_events be
  JOIN ledger_entries le ON le.scope_id=be.scope_id AND le.source_event_id=be.id
  WHERE be.event_type='PURCHASE'
    AND be.resolution_status='CONFIRMED'
    AND le.derivation_status='READY'
    AND le.certification_status IN ('BUSINESS_CONFIRMED','FUNDING_UNRECONCILED','CERTIFIED')
    AND NOT EXISTS (
      SELECT 1 FROM ledger_entry_supersessions s
      WHERE s.scope_id=le.scope_id AND s.superseded_ledger_entry_id=le.id
    )
), active_bank_transactions AS (
  SELECT DISTINCT sl.bank_transaction_id
  FROM ledger_source_links sl
  JOIN active_purchase_events e ON e.id=sl.business_event_id
  JOIN ledger_entries le
    ON le.id=sl.ledger_entry_id AND le.scope_id=e.scope_id AND le.source_event_id=e.id
  WHERE NOT EXISTS (
    SELECT 1 FROM ledger_entry_supersessions s
    WHERE s.scope_id=le.scope_id AND s.superseded_ledger_entry_id=le.id
  )
    AND le.derivation_status='READY'
    AND le.certification_status IN ('BUSINESS_CONFIRMED','FUNDING_UNRECONCILED','CERTIFIED')
    AND sl.bank_transaction_id IS NOT NULL
  UNION
  SELECT DISTINCT bt.id
  FROM bank_transactions bt
  JOIN bank_receipt_matches m ON m.bank_transaction_id=bt.id
  JOIN business_event_bank_evidence e
    ON e.scope_id=m.scope_id AND e.bank_receipt_match_id=m.id
  JOIN active_purchase_events a
    ON a.scope_id=e.scope_id AND a.id=e.business_event_id
), bank_transactions_in_period AS (
  SELECT p.period_key,bt.id,bt.amount,bt.currency
  FROM periods p
  JOIN bank_transactions bt
    ON bt.occurred_at >= p.period_start AND bt.occurred_at < p.period_end
  WHERE TRUE
    AND bt.normalization_status='READY'
    AND bt.event_type='PURCHASE'
    AND bt.direction='DEBIT'
    AND bt.amount IS NOT NULL AND bt.currency IS NOT NULL
)
SELECT b.period_key,
       CASE WHEN a.bank_transaction_id IS NULL
            THEN 'NO_ACTIVE_LEDGER_LINK' ELSE 'ALREADY_LINKED_TO_ACTIVE_LEDGER' END AS metric,
       b.currency,
       count(DISTINCT b.id) AS unique_bank_transactions,
       sum(b.amount)::numeric(18,2) AS amount
FROM bank_transactions_in_period b
LEFT JOIN active_bank_transactions a ON a.bank_transaction_id=b.id
GROUP BY b.period_key,
         CASE WHEN a.bank_transaction_id IS NULL
              THEN 'NO_ACTIVE_LEDGER_LINK' ELSE 'ALREADY_LINKED_TO_ACTIVE_LEDGER' END,
         b.currency
ORDER BY b.period_key,2,b.currency;

-- 3. FNS operation-1 payment stages, with a one-row-per-receipt normalizer
-- fact and an EXISTS-style active-event coverage flag. The fiscal header is
-- not assumed to be fresh cash: prepayment and settlement stay separate.
WITH periods(period_key,period_start,period_end) AS (VALUES
  ('oct_01_26', TIMESTAMPTZ '2026-09-30 21:00:00+00', TIMESTAMPTZ '2026-10-26 21:00:00+00'),
  ('oct_01_29_as_of_2026_10_29', TIMESTAMPTZ '2026-09-30 21:00:00+00', TIMESTAMPTZ '2026-10-29 21:00:00+00')
), active_acquisition_events AS (
  SELECT DISTINCT be.scope_id,be.id
  FROM business_events be
  JOIN accounting_scopes sc
    ON sc.id=be.scope_id AND sc.scope_key='default'
  JOIN ledger_entries le ON le.scope_id=be.scope_id AND le.source_event_id=be.id
  WHERE (be.event_type='PURCHASE'
         OR (be.event_type='FULFILLMENT' AND be.rule_code='PREPAYMENT_SETTLEMENT_V1'))
    AND be.resolution_status='CONFIRMED'
    AND le.derivation_status='READY'
    AND le.certification_status IN ('BUSINESS_CONFIRMED','FUNDING_UNRECONCILED','CERTIFIED')
    AND NOT EXISTS (
      SELECT 1 FROM ledger_entry_supersessions s
      WHERE s.scope_id=le.scope_id AND s.superseded_ledger_entry_id=le.id
    )
), receipt_event_links AS (
  SELECT DISTINCT e.receipt_id,e.event_id AS business_event_id
  FROM business_event_evidence e WHERE e.receipt_id IS NOT NULL
  UNION
  SELECT DISTINCT l.receipt_id,l.business_event_id
  FROM ledger_source_links l WHERE l.receipt_id IS NOT NULL
), receipts_in_period AS (
  SELECT p.period_key,r.id,r.currency,r.total_sum,
         f.normalization_status,f.payment_stage,f.household_cash_direction,
         f.payment_components_status,f.cash_total_sum,f.ecash_total_sum
  FROM periods p
  JOIN receipts r ON r.date_time >= p.period_start AND r.date_time < p.period_end
  JOIN receipt_fiscal_facts f
    ON f.receipt_id=r.id AND f.normalization_version='fiscal-normalizer-v1'
  WHERE r.operation_type=1
), classified_receipts AS (
  SELECT r.*,
         EXISTS (
           SELECT 1 FROM receipt_event_links l
           JOIN active_acquisition_events a ON a.id=l.business_event_id
           WHERE l.receipt_id=r.id
         ) AS has_active_acquisition,
         CASE WHEN r.payment_components_status='RECONCILED'
                   AND r.household_cash_direction='OUT'
              THEN COALESCE(r.cash_total_sum,0)+COALESCE(r.ecash_total_sum,0)
         END AS reconciled_new_money
  FROM receipts_in_period r
)
SELECT period_key,payment_stage,normalization_status,household_cash_direction,
       payment_components_status,has_active_acquisition,
       COALESCE(currency,'UNKNOWN') AS currency,
       count(*) AS unique_receipts,
       sum(total_sum)::numeric(18,2) AS fiscal_header_amount,
       sum(reconciled_new_money)::numeric(18,2) AS reconciled_new_money
FROM classified_receipts
GROUP BY period_key,payment_stage,normalization_status,household_cash_direction,
         payment_components_status,has_active_acquisition,COALESCE(currency,'UNKNOWN')
ORDER BY period_key,payment_stage,has_active_acquisition,currency;

-- 4. Receipt-side October outflow inventory at unique receipt grain.
-- Include receipts with reconciled new money; do not join source observations.
-- This reproduces the audited 108-receipt / 212,406.01 amount cohort while
-- keeping prepaid settlement-only headers with zero new money out. Receipt
-- currency is nullable and is reported explicitly as UNKNOWN when absent.
WITH periods(period_key,period_start,period_end) AS (VALUES
  ('oct_01_26', TIMESTAMPTZ '2026-09-30 21:00:00+00', TIMESTAMPTZ '2026-10-26 21:00:00+00'),
  ('oct_01_29_as_of_2026_10_29', TIMESTAMPTZ '2026-09-30 21:00:00+00', TIMESTAMPTZ '2026-10-29 21:00:00+00')
), receipt_grain AS (
  SELECT p.period_key,r.id,r.currency,r.total_sum,
         f.household_cash_direction,f.payment_components_status,
         COALESCE(f.cash_total_sum,0)+COALESCE(f.ecash_total_sum,0) AS reconciled_new_money
  FROM periods p
  JOIN receipts r ON r.date_time >= p.period_start AND r.date_time < p.period_end
  JOIN receipt_fiscal_facts f
    ON f.receipt_id=r.id AND f.normalization_version='fiscal-normalizer-v1'
  WHERE r.operation_type=1
), outflow_receipts AS (
  SELECT * FROM receipt_grain
  WHERE payment_components_status='RECONCILED'
    AND household_cash_direction='OUT'
    AND reconciled_new_money>0
)
SELECT period_key,COALESCE(currency,'UNKNOWN') AS currency,
       count(*) AS unique_receipts,
       sum(total_sum)::numeric(18,2) AS unique_receipt_header_total,
       sum(reconciled_new_money)::numeric(18,2) AS reconciled_new_money_total
FROM outflow_receipts
GROUP BY period_key,COALESCE(currency,'UNKNOWN')
ORDER BY period_key,COALESCE(currency,'UNKNOWN');

ROLLBACK;

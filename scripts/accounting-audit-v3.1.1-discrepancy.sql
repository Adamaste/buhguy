-- Forensic closeout, read-only. No DDL/DML.
-- Run: psql "$DATABASE_URL" -X -qAt -f scripts/accounting-audit-v3.1.1-discrepancy.sql
-- Output is one JSON object containing research/core/strict sets and pair predicates.

WITH base AS (
  SELECT r.id, r.fns_id, r.date_time, r.seller_inn, r.total_sum, x.payload,
    (x.payload->>'operationType')::int AS operation_type,
    (SELECT array_agg(item->>'paymentType' ORDER BY ord)
       FROM jsonb_array_elements(x.payload->'items') WITH ORDINALITY a(item,ord)) AS payment_types,
    (SELECT jsonb_agg(jsonb_build_object('name',item->>'name','quantity',item->>'quantity','price',item->>'price','sum',item->>'sum') ORDER BY ord)
       FROM jsonb_array_elements(x.payload->'items') WITH ORDINALITY a(item,ord)) AS core_items,
    (SELECT jsonb_agg(item - 'paymentType' ORDER BY ord)
       FROM jsonb_array_elements(x.payload->'items') WITH ORDINALITY a(item,ord)) AS strict_items,
    (x.payload->>'cashTotalSum')::numeric AS cash,
    (x.payload->>'ecashTotalSum')::numeric AS ecash,
    (x.payload->>'prepaidSum')::numeric AS prepaid,
    (x.payload->>'creditSum')::numeric AS credit,
    (x.payload->>'provisionSum')::numeric AS provision
  FROM receipts r JOIN receipt_raw x ON x.receipt_id=r.id
), pairs AS (
  SELECT
    a.id AS prepayment_receipt_id, b.id AS settlement_receipt_id,
    a.fns_id AS prepayment_fns_id, b.fns_id AS settlement_fns_id,
    a.seller_inn, a.total_sum AS amount,
    a.date_time AS prepayment_timestamp, b.date_time AS settlement_timestamp,
    a.operation_type = 1 AND b.operation_type = 1 AS operation_type_compatible,
    a.payment_types = ARRAY['1']::text[] AND b.payment_types = ARRAY['4']::text[] AS payment_type_compatible,
    b.date_time > a.date_time AS chronology,
    b.date_time <= a.date_time + interval '14 days' AS research_time_window,
    a.seller_inn = b.seller_inn AS seller_identity,
    a.total_sum = b.total_sum AS amount_equality,
    jsonb_array_length(a.payload->'items') = jsonb_array_length(b.payload->'items') AS item_count,
    (SELECT array_agg(item->>'name' ORDER BY ord) FROM jsonb_array_elements(a.payload->'items') WITH ORDINALITY z(item,ord)) =
    (SELECT array_agg(item->>'name' ORDER BY ord) FROM jsonb_array_elements(b.payload->'items') WITH ORDINALITY z(item,ord)) AS item_names,
    (SELECT array_agg(item->>'quantity' ORDER BY ord) FROM jsonb_array_elements(a.payload->'items') WITH ORDINALITY z(item,ord)) =
    (SELECT array_agg(item->>'quantity' ORDER BY ord) FROM jsonb_array_elements(b.payload->'items') WITH ORDINALITY z(item,ord)) AS quantity,
    (SELECT array_agg(item->>'price' ORDER BY ord) FROM jsonb_array_elements(a.payload->'items') WITH ORDINALITY z(item,ord)) =
    (SELECT array_agg(item->>'price' ORDER BY ord) FROM jsonb_array_elements(b.payload->'items') WITH ORDINALITY z(item,ord)) AS price,
    (SELECT array_agg(item->>'sum' ORDER BY ord) FROM jsonb_array_elements(a.payload->'items') WITH ORDINALITY z(item,ord)) =
    (SELECT array_agg(item->>'sum' ORDER BY ord) FROM jsonb_array_elements(b.payload->'items') WITH ORDINALITY z(item,ord)) AS item_sum,
    (SELECT array_agg(item->>'providerInn' ORDER BY ord) FROM jsonb_array_elements(a.payload->'items') WITH ORDINALITY z(item,ord)) =
    (SELECT array_agg(item->>'providerInn' ORDER BY ord) FROM jsonb_array_elements(b.payload->'items') WITH ORDINALITY z(item,ord)) AS provider_inn,
    (SELECT array_agg((item->'productCodeNew'->'code')::text ORDER BY ord) FROM jsonb_array_elements(a.payload->'items') WITH ORDINALITY z(item,ord)) =
    (SELECT array_agg((item->'productCodeNew'->'code')::text ORDER BY ord) FROM jsonb_array_elements(b.payload->'items') WITH ORDINALITY z(item,ord)) AS gtin_product_code,
    (a.cash+a.ecash = a.total_sum AND b.prepaid = b.total_sum AND b.cash=0 AND b.ecash=0) AS payment_component_condition,
    NULL::boolean AS external_ref_condition,
    'NOT_OBSERVED'::text AS external_ref_condition_result,
    md5(a.core_items::text) = md5(b.core_items::text) AS core_match,
    md5(a.strict_items::text) = md5(b.strict_items::text) AS strict_match
  FROM base a JOIN base b ON a.id <> b.id
  WHERE a.operation_type=1 AND b.operation_type=1
    AND a.payment_types=ARRAY['1']::text[] AND b.payment_types=ARRAY['4']::text[]
    AND a.seller_inn=b.seller_inn AND a.total_sum=b.total_sum
    AND b.date_time>a.date_time AND b.date_time<=a.date_time+interval '14 days'
), ranked AS (
  SELECT p.*, count(*) OVER(PARTITION BY settlement_receipt_id) AS competing_candidate_count
  FROM pairs p
), decorated AS (
  SELECT r.*, competing_candidate_count > 1 AS competing_candidate_condition, CASE
    WHEN NOT core_match THEN 'core_item_fingerprint_mismatch'
    WHEN NOT strict_match THEN 'strict_item_fingerprint_mismatch'
    WHEN NOT payment_component_condition THEN 'payment_component_condition_failed'
    WHEN external_ref_condition IS DISTINCT FROM TRUE THEN 'external_ref_condition_not_observed'
    WHEN competing_candidate_count > 1 THEN 'competing_candidate'
    ELSE NULL END AS first_exclusion_reason
  FROM ranked r
), payload AS (
  SELECT
    coalesce(jsonb_agg(to_jsonb(d) ORDER BY settlement_receipt_id,prepayment_receipt_id) FILTER(WHERE TRUE),'[]'::jsonb) AS research,
    coalesce(jsonb_agg(to_jsonb(d) ORDER BY settlement_receipt_id,prepayment_receipt_id) FILTER(WHERE core_match),'[]'::jsonb) AS core,
    coalesce(jsonb_agg(to_jsonb(d) ORDER BY settlement_receipt_id,prepayment_receipt_id) FILTER(WHERE strict_match),'[]'::jsonb) AS strict,
    count(*) AS research_count, count(*) FILTER(WHERE core_match) AS core_count, count(*) FILTER(WHERE strict_match) AS strict_count,
    count(DISTINCT settlement_receipt_id) AS research_settlement_count,
    count(DISTINCT settlement_receipt_id) FILTER(WHERE core_match) AS core_settlement_count,
    count(DISTINCT settlement_receipt_id) FILTER(WHERE strict_match) AS strict_settlement_count
  FROM decorated d
)
SELECT jsonb_build_object('pairKey','prepayment_receipt_id + settlement_receipt_id','research',research,'core',core,'strict',strict,
  'counts',jsonb_build_object('researchPairs',research_count,'researchSettlementReceipts',research_settlement_count,'corePairs',core_count,'coreSettlementReceipts',core_settlement_count,'strictPairs',strict_count,'strictSettlementReceipts',strict_settlement_count),
  'externalRefPolicy','external_ref_condition is NULL because no market_payment_id path was observed; it is not used as a positive match')::text
FROM payload;

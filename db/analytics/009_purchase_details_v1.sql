-- PURCHASE DETAILS ANALYTICS V1.
-- Curated, read-only surfaces. Apply only through a separately approved
-- analytics deployment; this directory is outside the runtime migration loader.
-- The acquisition fact and its proof-chain receipt are authoritative. In
-- particular, this does not union prepayment and fulfillment item lines.

CREATE OR REPLACE VIEW analytics_purchases AS
WITH certified_acquisitions AS (
  SELECT DISTINCT ON (p.certification_fact_id)
         p.certification_fact_id,
         be.scope_id,
         p.business_event_id,
         p.event_at AS purchased_at,
         p.amount,
         p.currency,
         p.status,
         p.rule_code,
         p.event_type,
         p.receipt_id
  FROM analytics_proof_chain p
  JOIN business_events be ON be.id = p.business_event_id
  WHERE p.metric_code = 'CONFIRMED_ACQUISITION_VALUE'
    AND p.status = 'CERTIFIED'
  ORDER BY p.certification_fact_id, (p.receipt_id IS NULL), p.receipt_id
)
SELECT a.business_event_id AS purchase_id,
       a.scope_id,
       a.certification_fact_id,
       a.purchased_at,
       a.amount,
       a.currency,
       a.status,
       a.rule_code,
       a.event_type,
       a.receipt_id,
       r.seller,
       r.seller_inn,
       (SELECT count(*)::integer FROM receipt_items i WHERE i.receipt_id = a.receipt_id) AS item_count,
       bank_merchant.merchant AS bank_merchant,
       bank_merchant.source_type AS bank_merchant_source,
       COALESCE(bank_merchant.merchant, NULLIF(btrim(r.seller), '')) AS merchant_display,
       CASE
         WHEN bank_merchant.merchant IS NOT NULL THEN bank_merchant.source_type
         WHEN NULLIF(btrim(r.seller), '') IS NOT NULL THEN 'FNS_RECEIPT'
       END AS merchant_display_source
FROM certified_acquisitions a
LEFT JOIN receipts r ON r.id = a.receipt_id
LEFT JOIN LATERAL (
  SELECT CASE
           WHEN count(DISTINCT bt.id) = 1
            AND count(DISTINCT NULLIF(btrim(bt.merchant), '')) = 1
           THEN min(NULLIF(btrim(bt.merchant), ''))
         END AS merchant,
         CASE
           WHEN count(DISTINCT bt.id) = 1
            AND count(DISTINCT NULLIF(btrim(bt.merchant), '')) = 1
           THEN min(bs.source_type)
         END AS source_type
  FROM business_event_bank_evidence e
  LEFT JOIN bank_receipt_matches m
    ON e.evidence_role = 'BANK_PURCHASE_MATCH'
   AND m.scope_id = e.scope_id
   AND m.id = e.bank_receipt_match_id
  JOIN bank_transactions bt
    ON bt.id = COALESCE(e.bank_transaction_id, m.bank_transaction_id)
  JOIN bank_event_observations beo ON beo.id = bt.observation_id
  JOIN bank_sources bs ON bs.id = beo.bank_source_id
  WHERE e.scope_id = a.scope_id
    AND e.business_event_id = a.business_event_id
) bank_merchant ON TRUE;

CREATE OR REPLACE VIEW analytics_purchase_items AS
WITH certified_acquisitions AS (
  SELECT DISTINCT ON (p.certification_fact_id)
         p.certification_fact_id,
         be.scope_id,
         p.business_event_id,
         p.event_at AS purchased_at,
         p.currency,
         p.receipt_id
  FROM analytics_proof_chain p
  JOIN business_events be ON be.id = p.business_event_id
  WHERE p.metric_code = 'CONFIRMED_ACQUISITION_VALUE'
    AND p.status = 'CERTIFIED'
  ORDER BY p.certification_fact_id, (p.receipt_id IS NULL), p.receipt_id
)
SELECT a.scope_id,
       a.business_event_id AS purchase_id,
       a.certification_fact_id,
       a.receipt_id,
       a.purchased_at,
       r.seller,
       r.seller_inn,
       i.position AS item_position,
       i.name AS item_name,
       i.quantity,
       i.price,
       i.item_sum,
       i.nds,
       a.currency
FROM certified_acquisitions a
JOIN receipts r ON r.id = a.receipt_id
JOIN receipt_items i ON i.receipt_id = a.receipt_id;

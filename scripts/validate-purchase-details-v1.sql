-- Read-only validation for PURCHASE DETAILS ANALYTICS V1.
-- Run only against a disposable clone where 009_purchase_details_v1.sql is applied.

SELECT 'source_counts' AS check_name,
       (SELECT count(*) FROM receipts) AS receipts,
       (SELECT count(*) FROM receipt_items) AS receipt_items,
       (SELECT count(*) FROM receipt_raw) AS receipt_raw,
       (SELECT count(*) FROM business_events) AS business_events,
       (SELECT count(*) FROM ledger_entries) AS ledger_entries,
       (SELECT count(*) FROM certification_facts) AS certification_facts;

SELECT 'august_headers' AS check_name,
       count(*) AS purchase_count,
       round(coalesce(sum(amount), 0), 2) AS purchase_amount,
       sum(item_count) AS header_item_count
FROM analytics_purchases
WHERE purchased_at >= '2026-08-01T00:00:00+03'
  AND purchased_at <  '2026-09-01T00:00:00+03';

SELECT 'august_items' AS check_name,
       count(*) AS item_lines,
       round(coalesce(sum(item_sum), 0), 2) AS item_sum_total
FROM analytics_purchase_items
WHERE purchased_at >= '2026-08-01T00:00:00+03'
  AND purchased_at <  '2026-09-01T00:00:00+03';

WITH reconciliation AS (
  SELECT p.purchase_id,
         p.amount,
         count(i.item_position) AS item_count,
         coalesce(sum(i.item_sum), 0) AS item_sum
  FROM analytics_purchases p
  LEFT JOIN analytics_purchase_items i ON i.purchase_id = p.purchase_id
  WHERE p.purchased_at >= '2026-08-01T00:00:00+03'
    AND p.purchased_at <  '2026-09-01T00:00:00+03'
  GROUP BY p.purchase_id, p.amount
)
SELECT 'august_reconciliation' AS check_name,
       count(*) FILTER (WHERE item_count > 0 AND item_sum = amount) AS match_count,
       count(*) FILTER (WHERE item_count > 0 AND item_sum <> amount) AS mismatch_count,
       count(*) FILTER (WHERE item_count = 0) AS no_items_count
FROM reconciliation;

SELECT 'xiaomi' AS check_name, p.purchase_id, p.purchased_at, p.seller,
       p.amount, p.item_count, i.item_position, i.item_name, i.quantity, i.item_sum
FROM analytics_purchases p
LEFT JOIN analytics_purchase_items i ON i.purchase_id = p.purchase_id
WHERE p.amount = 32380.00
ORDER BY p.purchase_id, i.item_position;

SELECT 'sample_purchases' AS check_name, p.purchased_at, p.seller,
       p.amount, p.item_count,
       string_agg(format('%s x %s = %s', i.item_name, i.quantity, i.item_sum), ' | ' ORDER BY i.item_position) AS items
FROM analytics_purchases p
LEFT JOIN analytics_purchase_items i ON i.purchase_id = p.purchase_id
WHERE p.purchased_at >= '2026-08-01T00:00:00+03'
  AND p.purchased_at <  '2026-09-01T00:00:00+03'
GROUP BY p.purchase_id, p.purchased_at, p.seller, p.amount, p.item_count
ORDER BY p.amount DESC, p.purchase_id
LIMIT 5;

SELECT 'exposed_columns' AS check_name, table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('analytics_purchases', 'analytics_purchase_items')
ORDER BY table_name, ordinal_position;

SELECT 'security_column_audit' AS check_name,
       count(*) FILTER (WHERE column_name ~* '(raw|payload|token|cookie|email|phone|auth|fiscal_sign|fns_id|source_state_key)') AS forbidden_columns
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('analytics_purchases', 'analytics_purchase_items');

-- Read-only source query used by PREPAYMENT_SETTLEMENT_V1.
-- The JavaScript matcher evaluates the returned rows and never writes them.
SELECT r.id, r.fns_id, r.date_time, r.seller_inn, r.operation_type,
       r.total_sum, r.currency, f.normalization_status, f.payment_stage,
       f.cash_total_sum, f.ecash_total_sum, f.prepaid_sum,
       f.credit_sum, f.provision_sum,
       COALESCE(jsonb_agg(jsonb_build_object(
         'name', i.name, 'quantity', i.quantity, 'price', i.price,
         'itemSum', i.item_sum, 'providerInn', fi.provider_inn,
         'gtin', fi.gtin, 'rawProductCode', fi.raw_product_code
       ) ORDER BY i.position) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
FROM receipts r
JOIN receipt_fiscal_facts f ON f.receipt_id = r.id
  AND f.normalization_version = 'fiscal-normalizer-v1'
LEFT JOIN receipt_items i ON i.receipt_id = r.id
LEFT JOIN receipt_item_fiscal_facts fi ON fi.receipt_item_id = i.id
  AND fi.normalization_version = 'fiscal-normalizer-v1'
WHERE f.normalization_status = 'READY'
GROUP BY r.id, f.receipt_id, f.normalization_version;

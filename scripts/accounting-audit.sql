-- Read-only audit queries. Run against a copy or production with a read-only role.
-- This file intentionally returns aggregates only; do not add raw payload output.
SELECT count(*) AS receipts, (SELECT count(*) FROM receipt_items) AS items,
       (SELECT count(*) FROM receipt_raw) AS raw, min(date_time), max(date_time)
FROM receipts;
SELECT operation_type, count(*) FROM receipts GROUP BY operation_type ORDER BY operation_type;
SELECT payload->>'fiscalDocumentFormatVer' AS ffd_version, count(*)
FROM receipt_raw GROUP BY 1 ORDER BY 1;
SELECT item->>'paymentType' AS item_payment_type, count(*)
FROM receipt_raw CROSS JOIN LATERAL jsonb_array_elements(payload->'items') item
GROUP BY 1 ORDER BY 1;
SELECT count(*) FILTER (WHERE payload ? 'correction') AS correction_present,
       count(*) FILTER (WHERE payload ? 'buyerPhoneOrAddress') AS contact_present,
       count(*) FILTER (WHERE payload ? 'fnsUrl') AS fns_url_present
FROM receipt_raw;

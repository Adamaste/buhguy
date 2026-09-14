-- Read-only Phase 1A production preflight. Run only with a read-only role.
SELECT 'counts' AS check_name,
       (SELECT count(*) FROM receipts) AS receipts,
       (SELECT count(*) FROM receipt_items) AS receipt_items,
       (SELECT count(*) FROM receipt_raw) AS receipt_raw;

SELECT count(*) AS duplicate_fns_id_groups
FROM (SELECT fns_id FROM receipts GROUP BY fns_id HAVING count(*) > 1) duplicates;

SELECT count(*) AS duplicate_canonical_fiscal_identity_groups
FROM (
  SELECT fiscal_drive_number, fiscal_document_number, fiscal_sign
  FROM receipts
  WHERE fiscal_drive_number IS NOT NULL
    AND fiscal_document_number IS NOT NULL
    AND fiscal_sign IS NOT NULL
  GROUP BY fiscal_drive_number, fiscal_document_number, fiscal_sign
  HAVING count(*) > 1
) duplicates;

-- A row-level disagreement is impossible when both channels are stored on the
-- same receipt, but this verifies the persisted tuple is internally coherent.
SELECT count(*) AS identity_channel_disagreements
FROM receipts r
WHERE r.fiscal_drive_number IS NOT NULL
  AND r.fiscal_document_number IS NOT NULL
  AND r.fiscal_sign IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM receipts same_receipt
    WHERE same_receipt.id = r.id
      AND same_receipt.fns_id = r.fns_id
      AND same_receipt.fiscal_drive_number = r.fiscal_drive_number
      AND same_receipt.fiscal_document_number = r.fiscal_document_number
      AND same_receipt.fiscal_sign = r.fiscal_sign
  );

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'receipts'
  AND indexname = 'receipts_canonical_fiscal_identity_unique';

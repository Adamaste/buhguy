DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM receipts
    WHERE fiscal_drive_number IS NOT NULL
      AND fiscal_document_number IS NOT NULL
      AND fiscal_sign IS NOT NULL
    GROUP BY fiscal_drive_number, fiscal_document_number, fiscal_sign
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add canonical fiscal identity constraint: duplicate fiscal identities exist';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS receipts_canonical_fiscal_identity_unique
  ON receipts (fiscal_drive_number, fiscal_document_number, fiscal_sign)
  WHERE fiscal_drive_number IS NOT NULL
    AND fiscal_document_number IS NOT NULL
    AND fiscal_sign IS NOT NULL;

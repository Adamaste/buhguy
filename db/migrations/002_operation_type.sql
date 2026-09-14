ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS operation_type SMALLINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'receipts_operation_type_check'
      AND conrelid = 'public.receipts'::regclass
  ) THEN
    ALTER TABLE receipts
      ADD CONSTRAINT receipts_operation_type_check
      CHECK (operation_type IN (1, 2, 3, 4));
  END IF;
END
$$;

UPDATE receipts AS r
SET operation_type = CASE
  WHEN raw.payload->>'operationType' ~ '^[1-4]$'
    THEN (raw.payload->>'operationType')::smallint
  ELSE NULL
END
FROM receipt_raw AS raw
WHERE raw.receipt_id = r.id;

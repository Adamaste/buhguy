ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS account_reference_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'bank_transactions'::regclass
      AND conname = 'bank_transactions_account_reference_kind_check'
  ) THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT bank_transactions_account_reference_kind_check
      CHECK (
        account_reference_kind IS NULL
        OR (account_reference IS NOT NULL AND account_reference_kind IN ('MASKED_CARD', 'MASKED_ACCOUNT', 'OTHER'))
      );
  END IF;
END $$;

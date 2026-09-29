ALTER TABLE payment_instruments
  ADD COLUMN IF NOT EXISTS scope_id BIGINT;

UPDATE payment_instruments pi
SET scope_id = fa.scope_id
FROM financial_accounts fa
WHERE fa.id = pi.financial_account_id
  AND pi.scope_id IS NULL;

ALTER TABLE payment_instruments
  ALTER COLUMN scope_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_instruments'::regclass
      AND conname = 'payment_instruments_scope_id_fkey'
  ) THEN
    ALTER TABLE payment_instruments
      ADD CONSTRAINT payment_instruments_scope_id_fkey
      FOREIGN KEY (scope_id) REFERENCES accounting_scopes(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE payment_instruments
  ALTER COLUMN financial_account_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS payment_instrument_person_relations (
  id BIGSERIAL PRIMARY KEY,
  payment_instrument_id BIGINT NOT NULL REFERENCES payment_instruments(id) ON DELETE CASCADE,
  person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('OWNER', 'AUTHORIZED_USER')),
  provenance TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payment_instrument_id, person_id, relation_type)
);

ALTER TABLE bank_account_references
  ADD COLUMN IF NOT EXISTS payment_instrument_id BIGINT REFERENCES payment_instruments(id) ON DELETE CASCADE;

ALTER TABLE bank_account_references
  ALTER COLUMN financial_account_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bank_account_references'::regclass
      AND conname = 'bank_account_references_exact_target_check'
  ) THEN
    ALTER TABLE bank_account_references
      ADD CONSTRAINT bank_account_references_exact_target_check
      CHECK ((financial_account_id IS NOT NULL)::int + (payment_instrument_id IS NOT NULL)::int = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payment_instruments_scope_idx
  ON payment_instruments(scope_id);

CREATE INDEX IF NOT EXISTS payment_instrument_person_relations_person_idx
  ON payment_instrument_person_relations(person_id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_instrument_one_owner_idx
  ON payment_instrument_person_relations(payment_instrument_id)
  WHERE relation_type = 'OWNER';

CREATE INDEX IF NOT EXISTS bank_account_references_instrument_idx
  ON bank_account_references(payment_instrument_id);

CREATE TABLE IF NOT EXISTS bank_transaction_payment_instrument_resolution (
  bank_transaction_id BIGINT PRIMARY KEY REFERENCES bank_transactions(id) ON DELETE CASCADE,
  payment_instrument_id BIGINT REFERENCES payment_instruments(id) ON DELETE RESTRICT,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('EXACT', 'UNKNOWN')),
  provenance TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (resolution_state = 'UNKNOWN' AND payment_instrument_id IS NULL)
    OR (resolution_state = 'EXACT' AND payment_instrument_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS bank_transaction_payment_instrument_resolution_instrument_idx
  ON bank_transaction_payment_instrument_resolution(payment_instrument_id);

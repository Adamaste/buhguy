-- Append-only manual accounting for the Troika stored-value wallet.
-- No wallet, movement, or balance is seeded by this schema migration.

ALTER TABLE payment_instruments
  ADD CONSTRAINT payment_instruments_scope_identity_unique
  UNIQUE (scope_id, id, financial_account_id, provider);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_scope_identity_event_unique
  UNIQUE (scope_id, id, source_event_id);

ALTER TABLE ledger_accounts
  DROP CONSTRAINT IF EXISTS ledger_accounts_account_type_check;

ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_account_type_check
  CHECK (account_type IN ('ASSET', 'CONTROL', 'RECEIVABLE', 'EXPENSE'));

CREATE TABLE prepaid_wallets (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  owner_person_id BIGINT NOT NULL,
  wallet_key TEXT NOT NULL CHECK (length(btrim(wallet_key)) > 0),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provenance TEXT NOT NULL CHECK (provenance = 'USER_CONFIRMED'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, id),
  UNIQUE (scope_id, wallet_key),
  FOREIGN KEY (scope_id, owner_person_id) REFERENCES persons(scope_id, id) ON DELETE RESTRICT
);

CREATE TABLE prepaid_wallet_balance_snapshots (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  wallet_id BIGINT NOT NULL,
  balance NUMERIC(18,2) NOT NULL CHECK (balance >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  confirmed_by_person_id BIGINT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance = 'USER_CONFIRMED'),
  confirmation_key TEXT NOT NULL UNIQUE CHECK (length(btrim(confirmation_key)) > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, id),
  UNIQUE (scope_id, wallet_id, observed_at),
  FOREIGN KEY (scope_id, wallet_id) REFERENCES prepaid_wallets(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, confirmed_by_person_id) REFERENCES persons(scope_id, id) ON DELETE RESTRICT
);

CREATE INDEX prepaid_wallet_balance_snapshots_wallet_time_idx
  ON prepaid_wallet_balance_snapshots(scope_id, wallet_id, observed_at DESC, id DESC);

CREATE TABLE prepaid_wallet_movements (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  wallet_id BIGINT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('TOPUP', 'RIDE_REDEMPTION')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  bank_transaction_id BIGINT REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  source_provider TEXT,
  financial_account_id BIGINT,
  payment_instrument_id BIGINT,
  source_account_provenance TEXT,
  evidence_basis TEXT,
  confirmed_by_person_id BIGINT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance = 'USER_CONFIRMED'),
  confirmation_key TEXT NOT NULL UNIQUE CHECK (length(btrim(confirmation_key)) > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  business_event_id BIGINT NOT NULL,
  ledger_entry_id BIGINT NOT NULL,
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, id),
  UNIQUE (business_event_id),
  UNIQUE (ledger_entry_id),
  FOREIGN KEY (scope_id, wallet_id) REFERENCES prepaid_wallets(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, confirmed_by_person_id) REFERENCES persons(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, financial_account_id, currency) REFERENCES financial_accounts(scope_id, id, currency) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, payment_instrument_id, financial_account_id, source_provider)
    REFERENCES payment_instruments(scope_id, id, financial_account_id, provider) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, business_event_id) REFERENCES business_events(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, ledger_entry_id, business_event_id)
    REFERENCES ledger_entries(scope_id, id, source_event_id) ON DELETE RESTRICT,
  CHECK (
    (movement_type = 'TOPUP'
      AND bank_transaction_id IS NOT NULL
      AND source_provider = 'ru.alfabank.mobile.android'
      AND financial_account_id IS NOT NULL
      AND payment_instrument_id IS NOT NULL
      AND source_account_provenance = 'USER_CONFIRMED'
      AND evidence_basis IN ('USER_CONFIRMATION', 'BANK_DOCUMENT_AND_USER_CONFIRMATION'))
    OR
    (movement_type = 'RIDE_REDEMPTION'
      AND bank_transaction_id IS NULL
      AND source_provider IS NULL
      AND financial_account_id IS NULL
      AND payment_instrument_id IS NULL
      AND source_account_provenance IS NULL
      AND evidence_basis IS NULL)
  )
);

CREATE UNIQUE INDEX prepaid_wallet_movements_bank_transaction_unique
  ON prepaid_wallet_movements(bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

CREATE INDEX prepaid_wallet_movements_wallet_time_idx
  ON prepaid_wallet_movements(scope_id, wallet_id, occurred_at, id);

CREATE INDEX prepaid_wallet_movements_scope_bank_tx_idx
  ON prepaid_wallet_movements(scope_id, bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

CREATE TABLE prepaid_wallet_receipt_evidence (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  wallet_movement_id BIGINT NOT NULL,
  receipt_id BIGINT NOT NULL,
  normalization_version TEXT NOT NULL,
  payment_stage TEXT NOT NULL CHECK (payment_stage IN ('PREPAYMENT_ONLY', 'SETTLEMENT_ONLY')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  normalized_content_sha256 CHAR(64) NOT NULL CHECK (normalized_content_sha256 ~ '^[0-9a-f]{64}$'),
  provenance TEXT NOT NULL CHECK (provenance = 'USER_CONFIRMED'),
  confirmation_key TEXT NOT NULL UNIQUE CHECK (length(btrim(confirmation_key)) > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, id),
  UNIQUE (receipt_id),
  UNIQUE (wallet_movement_id),
  FOREIGN KEY (scope_id, wallet_movement_id) REFERENCES prepaid_wallet_movements(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (receipt_id, normalization_version) REFERENCES receipt_fiscal_facts(receipt_id, normalization_version) ON DELETE RESTRICT
);

CREATE INDEX prepaid_wallet_receipt_evidence_scope_receipt_idx
  ON prepaid_wallet_receipt_evidence(scope_id, receipt_id);

CREATE OR REPLACE FUNCTION reject_prepaid_wallet_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prepaid wallet records are append-only';
END;
$$;

CREATE TRIGGER prepaid_wallets_append_only
  BEFORE UPDATE OR DELETE ON prepaid_wallets
  FOR EACH ROW EXECUTE FUNCTION reject_prepaid_wallet_mutation();

CREATE TRIGGER prepaid_wallet_balance_snapshots_append_only
  BEFORE UPDATE OR DELETE ON prepaid_wallet_balance_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_prepaid_wallet_mutation();

CREATE TRIGGER prepaid_wallet_movements_append_only
  BEFORE UPDATE OR DELETE ON prepaid_wallet_movements
  FOR EACH ROW EXECUTE FUNCTION reject_prepaid_wallet_mutation();

CREATE TRIGGER prepaid_wallet_receipt_evidence_append_only
  BEFORE UPDATE OR DELETE ON prepaid_wallet_receipt_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_prepaid_wallet_mutation();

-- FNS runtime may only read these columns to exclude already-confirmed
-- wallet movements and their explicitly linked receipts from matching.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (scope_id, bank_transaction_id) ON public.prepaid_wallet_movements TO receipt_collector';
    EXECUTE 'GRANT SELECT (scope_id, receipt_id) ON public.prepaid_wallet_receipt_evidence TO receipt_collector';
  END IF;
END $$;

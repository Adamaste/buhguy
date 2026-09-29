CREATE TABLE IF NOT EXISTS financial_accounts (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  institution TEXT NOT NULL,
  provider TEXT,
  display_name TEXT NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS financial_accounts_scope_idx
  ON financial_accounts(scope_id);

CREATE TABLE IF NOT EXISTS financial_account_person_relations (
  id BIGSERIAL PRIMARY KEY,
  financial_account_id BIGINT NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('OWNER', 'AUTHORIZED_USER')),
  provenance TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (financial_account_id, person_id, relation_type)
);

CREATE TABLE IF NOT EXISTS payment_instruments (
  id BIGSERIAL PRIMARY KEY,
  financial_account_id BIGINT NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  instrument_type TEXT NOT NULL CHECK (instrument_type IN ('CARD', 'VIRTUAL_CARD', 'OTHER')),
  provider TEXT,
  display_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_account_references (
  id BIGSERIAL PRIMARY KEY,
  financial_account_id BIGINT NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  reference_kind TEXT NOT NULL CHECK (reference_kind IN ('MASKED_CARD', 'MASKED_ACCOUNT', 'OTHER')),
  reference_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bank_account_references_lookup_idx
  ON bank_account_references(provider, reference_kind, reference_value);

CREATE TABLE IF NOT EXISTS bank_transaction_account_resolution (
  bank_transaction_id BIGINT PRIMARY KEY REFERENCES bank_transactions(id) ON DELETE CASCADE,
  financial_account_id BIGINT REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('EXACT', 'MANUAL', 'RECONCILED', 'UNKNOWN')),
  provenance TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (resolution_state = 'UNKNOWN' AND financial_account_id IS NULL)
    OR (resolution_state IN ('EXACT', 'MANUAL', 'RECONCILED') AND financial_account_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS bank_transaction_account_resolution_account_idx
  ON bank_transaction_account_resolution(financial_account_id);

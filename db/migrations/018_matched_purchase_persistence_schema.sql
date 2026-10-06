-- Matched purchase persistence foundation. Runtime writers are intentionally
-- out of scope; this migration only establishes future persistence contracts.

ALTER TABLE financial_accounts
  ADD CONSTRAINT financial_accounts_scope_id_unique UNIQUE (scope_id, id),
  ADD CONSTRAINT financial_accounts_scope_id_currency_unique UNIQUE (scope_id, id, currency);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_scope_id_unique UNIQUE (scope_id, id);

CREATE TABLE bank_receipt_matches (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  bank_transaction_id BIGINT NOT NULL UNIQUE REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  receipt_id BIGINT NOT NULL UNIQUE REFERENCES receipts(id) ON DELETE RESTRICT,
  financial_account_id BIGINT NOT NULL,
  matcher_version TEXT NOT NULL CHECK (length(btrim(matcher_version)) > 0),
  match_key CHAR(64) NOT NULL UNIQUE CHECK (match_key ~ '^[0-9a-f]{64}$'),
  bank_ledger_key CHAR(64) NOT NULL CHECK (bank_ledger_key ~ '^[0-9a-f]{64}$'),
  bank_candidate_key CHAR(64) NOT NULL CHECK (bank_candidate_key ~ '^[0-9a-f]{64}$'),
  bank_journal_key CHAR(64) NOT NULL CHECK (bank_journal_key ~ '^[0-9a-f]{64}$'),
  receipt_candidate_key CHAR(64) NOT NULL CHECK (receipt_candidate_key ~ '^[0-9a-f]{64}$'),
  receipt_normalization_version TEXT NOT NULL CHECK (length(btrim(receipt_normalization_version)) > 0),
  receipt_normalized_content_sha256 CHAR(64) NOT NULL CHECK (receipt_normalized_content_sha256 ~ '^[0-9a-f]{64}$'),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  bank_occurred_at TIMESTAMPTZ NOT NULL,
  receipt_date_time TIMESTAMPTZ NOT NULL,
  time_delta_seconds NUMERIC(20,6) NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type = 'MATCHED_PURCHASE'),
  reason_code TEXT NOT NULL CHECK (length(btrim(reason_code)) > 0),
  ownership_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, id),
  FOREIGN KEY (scope_id, financial_account_id, currency)
    REFERENCES financial_accounts(scope_id, id, currency)
    ON DELETE RESTRICT
);

CREATE INDEX bank_receipt_matches_scope_idx
  ON bank_receipt_matches(scope_id, bank_occurred_at);

CREATE TABLE business_event_bank_evidence (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  business_event_id BIGINT NOT NULL,
  bank_receipt_match_id BIGINT NOT NULL,
  enrichment_key CHAR(64) NOT NULL CHECK (enrichment_key ~ '^[0-9a-f]{64}$'),
  evidence_role TEXT NOT NULL CHECK (evidence_role = 'BANK_PURCHASE_MATCH'),
  rule_version TEXT NOT NULL CHECK (length(btrim(rule_version)) > 0),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, bank_receipt_match_id),
  UNIQUE (scope_id, business_event_id, bank_receipt_match_id),
  FOREIGN KEY (scope_id, business_event_id)
    REFERENCES business_events(scope_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, bank_receipt_match_id)
    REFERENCES bank_receipt_matches(scope_id, id)
    ON DELETE RESTRICT
);

ALTER TABLE ledger_accounts
  ADD COLUMN financial_account_id BIGINT,
  ADD COLUMN account_currency CHAR(3),
  ADD CONSTRAINT ledger_accounts_mapping_shape_check CHECK (
    (financial_account_id IS NULL AND account_currency IS NULL)
    OR (financial_account_id IS NOT NULL
      AND account_currency IS NOT NULL
      AND account_type = 'ASSET'
      AND account_currency ~ '^[A-Z]{3}$')
  ),
  ADD CONSTRAINT ledger_accounts_financial_account_fk
    FOREIGN KEY (scope_id, financial_account_id, account_currency)
    REFERENCES financial_accounts(scope_id, id, currency)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX ledger_accounts_financial_account_unique
  ON ledger_accounts(scope_id, financial_account_id)
  WHERE financial_account_id IS NOT NULL;

ALTER TABLE ledger_source_links
  ADD COLUMN bank_receipt_match_id BIGINT REFERENCES bank_receipt_matches(id) ON DELETE RESTRICT,
  ADD COLUMN bank_transaction_id BIGINT REFERENCES bank_transactions(id) ON DELETE RESTRICT;

ALTER TABLE ledger_source_links
  ADD CONSTRAINT ledger_source_links_bank_pair_check
  CHECK (bank_receipt_match_id IS NULL OR bank_transaction_id IS NOT NULL);

CREATE INDEX ledger_source_links_bank_match_idx
  ON ledger_source_links(bank_receipt_match_id)
  WHERE bank_receipt_match_id IS NOT NULL;

CREATE INDEX ledger_source_links_bank_transaction_idx
  ON ledger_source_links(bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

CREATE TABLE ledger_entry_supersessions (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  superseded_ledger_entry_id BIGINT NOT NULL,
  replacement_ledger_entry_id BIGINT NOT NULL,
  business_event_id BIGINT NOT NULL,
  enrichment_key CHAR(64) NOT NULL CHECK (enrichment_key ~ '^[0-9a-f]{64}$'),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK (length(btrim(reason_code)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (superseded_ledger_entry_id <> replacement_ledger_entry_id),
  UNIQUE (scope_id, superseded_ledger_entry_id),
  UNIQUE (scope_id, replacement_ledger_entry_id),
  FOREIGN KEY (scope_id, superseded_ledger_entry_id)
    REFERENCES ledger_entries(scope_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, replacement_ledger_entry_id)
    REFERENCES ledger_entries(scope_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, business_event_id)
    REFERENCES business_events(scope_id, id)
    ON DELETE RESTRICT
);

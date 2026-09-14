CREATE TABLE IF NOT EXISTS ledger_accounts (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  account_code TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET', 'CONTROL', 'RECEIVABLE')),
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, account_code),
  UNIQUE (scope_id, id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  source_event_id BIGINT NOT NULL,
  currency TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL,
  semantic_key CHAR(64) NOT NULL,
  derivation_rule TEXT NOT NULL,
  derivation_version TEXT NOT NULL,
  derivation_status TEXT NOT NULL CHECK (derivation_status IN ('READY', 'PROVISIONAL', 'BLOCKED')),
  certification_status TEXT NOT NULL CHECK (certification_status IN ('BUSINESS_CONFIRMED', 'FUNDING_UNRECONCILED', 'CERTIFIED', 'BLOCKED')),
  origin TEXT NOT NULL CHECK (origin IN ('SYSTEM_DERIVED', 'MANUAL', 'EXTERNAL_CONFIRMED')),
  reason_code TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, semantic_key, derivation_rule, derivation_version, origin),
  FOREIGN KEY (scope_id, source_event_id) REFERENCES business_events(scope_id, id)
);

CREATE INDEX IF NOT EXISTS ledger_entries_scope_status_idx
  ON ledger_entries(scope_id, derivation_status, certification_status);

CREATE TABLE IF NOT EXISTS ledger_postings (
  id BIGSERIAL PRIMARY KEY,
  ledger_entry_id BIGINT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL,
  currency TEXT NOT NULL,
  debit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  source_allocation_id BIGINT,
  source_receipt_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES ledger_accounts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_postings_semantic_idx
  ON ledger_postings(ledger_entry_id, account_id, debit, credit, COALESCE(source_allocation_id, 0), COALESCE(source_receipt_id, 0));

CREATE TABLE IF NOT EXISTS ledger_source_links (
  id BIGSERIAL PRIMARY KEY,
  ledger_entry_id BIGINT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  business_event_id BIGINT NOT NULL,
  graph_evidence_id BIGINT,
  graph_allocation_id BIGINT,
  receipt_id BIGINT,
  normalization_version TEXT,
  link_role TEXT NOT NULL,
  semantic_key CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (business_event_id) REFERENCES business_events(id),
  FOREIGN KEY (graph_evidence_id) REFERENCES business_event_evidence(id),
  FOREIGN KEY (graph_allocation_id) REFERENCES business_event_allocations(id),
  FOREIGN KEY (receipt_id) REFERENCES receipts(id)
);

CREATE INDEX IF NOT EXISTS ledger_source_links_entry_idx
  ON ledger_source_links(ledger_entry_id);
CREATE INDEX IF NOT EXISTS ledger_source_links_receipt_idx
  ON ledger_source_links(receipt_id);

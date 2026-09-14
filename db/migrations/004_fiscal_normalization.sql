CREATE TABLE IF NOT EXISTS receipt_fiscal_facts (
  receipt_id BIGINT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  normalization_version TEXT NOT NULL,
  source_content_sha256 CHAR(64) NOT NULL,
  normalized_content_sha256 CHAR(64) NOT NULL,
  normalization_status TEXT NOT NULL CHECK (normalization_status IN ('READY', 'BLOCKED', 'UNSUPPORTED')),
  ffd_version_code TEXT,
  ffd_version TEXT,
  fiscal_operation_type SMALLINT CHECK (fiscal_operation_type IN (1, 2, 3, 4)),
  household_cash_direction TEXT CHECK (household_cash_direction IN ('IN', 'OUT')),
  cash_total_sum NUMERIC(14, 2),
  cash_total_state TEXT NOT NULL CHECK (cash_total_state IN ('PRESENT_VALUE', 'EXPLICIT_ZERO', 'FIELD_MISSING', 'FIELD_NOT_SUPPORTED', 'FIELD_INVALID')),
  ecash_total_sum NUMERIC(14, 2),
  ecash_total_state TEXT NOT NULL CHECK (ecash_total_state IN ('PRESENT_VALUE', 'EXPLICIT_ZERO', 'FIELD_MISSING', 'FIELD_NOT_SUPPORTED', 'FIELD_INVALID')),
  prepaid_sum NUMERIC(14, 2),
  prepaid_state TEXT NOT NULL CHECK (prepaid_state IN ('PRESENT_VALUE', 'EXPLICIT_ZERO', 'FIELD_MISSING', 'FIELD_NOT_SUPPORTED', 'FIELD_INVALID')),
  credit_sum NUMERIC(14, 2),
  credit_state TEXT NOT NULL CHECK (credit_state IN ('PRESENT_VALUE', 'EXPLICIT_ZERO', 'FIELD_MISSING', 'FIELD_NOT_SUPPORTED', 'FIELD_INVALID')),
  provision_sum NUMERIC(14, 2),
  provision_state TEXT NOT NULL CHECK (provision_state IN ('PRESENT_VALUE', 'EXPLICIT_ZERO', 'FIELD_MISSING', 'FIELD_NOT_SUPPORTED', 'FIELD_INVALID')),
  payment_components_status TEXT NOT NULL CHECK (payment_components_status IN ('RECONCILED', 'INCOMPLETE', 'UNSUPPORTED', 'MISMATCH')),
  payment_stage TEXT NOT NULL CHECK (payment_stage IN ('PREPAYMENT_ONLY', 'ADVANCE_ONLY', 'SETTLEMENT_ONLY', 'CREDIT_ONLY', 'MIXED', 'UNKNOWN')),
  correction_status TEXT NOT NULL CHECK (correction_status IN ('NORMAL', 'CORRECTION', 'UNKNOWN', 'UNSUPPORTED')),
  normalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (receipt_id, normalization_version)
);

CREATE TABLE IF NOT EXISTS receipt_item_fiscal_facts (
  receipt_item_id BIGINT NOT NULL REFERENCES receipt_items(id) ON DELETE CASCADE,
  normalization_version TEXT NOT NULL,
  payment_type_code SMALLINT CHECK (payment_type_code BETWEEN 1 AND 7),
  payment_type_semantic TEXT,
  product_type_code INTEGER,
  provider_inn TEXT,
  gtin TEXT,
  raw_product_code TEXT,
  normalized_content_sha256 CHAR(64) NOT NULL,
  normalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (receipt_item_id, normalization_version)
);

CREATE TABLE IF NOT EXISTS normalization_issues (
  id BIGSERIAL PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  receipt_item_id BIGINT REFERENCES receipt_items(id) ON DELETE CASCADE,
  normalization_version TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS normalization_issues_receipt_version_idx
  ON normalization_issues (receipt_id, normalization_version);

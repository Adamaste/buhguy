-- Explicit, one-pair-at-a-time evidence for reviewed historical reconciliation.
-- This table stores evidence metadata only. It must never contain statement
-- rows, notification text, account numbers, or other raw data.
CREATE TABLE manual_bank_reconciliation_review_evidence (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  bank_transaction_id BIGINT NOT NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  receipt_id BIGINT REFERENCES receipts(id) ON DELETE RESTRICT,
  financial_account_id BIGINT NOT NULL,
  review_kind TEXT NOT NULL CHECK (review_kind IN ('ACCOUNT_RESOLUTION', 'RECEIPT_BANK_MATCH')),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('BANK_STATEMENT', 'BANK_API_TRANSACTION_DETAIL')),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_reference_sha256 CHAR(64) NOT NULL CHECK (evidence_reference_sha256 ~ '^[0-9a-f]{64}$'),
  reviewer_code TEXT NOT NULL CHECK (reviewer_code ~ '^(op|test)-[0-9a-f]{16}$'),
  cohort_cutoff TIMESTAMPTZ,
  match_key CHAR(64) CHECK (match_key IS NULL OR match_key ~ '^[0-9a-f]{64}$'),
  review_key CHAR(64) NOT NULL UNIQUE CHECK (review_key ~ '^[0-9a-f]{64}$'),
  model_version TEXT NOT NULL CHECK (model_version = 'manual-bank-reconciliation-review-v1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (scope_id, financial_account_id)
    REFERENCES financial_accounts(scope_id, id) ON DELETE RESTRICT,
  CHECK (
    (review_kind = 'ACCOUNT_RESOLUTION'
      AND receipt_id IS NULL AND cohort_cutoff IS NULL AND match_key IS NULL)
    OR
    (review_kind = 'RECEIPT_BANK_MATCH'
      AND receipt_id IS NOT NULL AND cohort_cutoff IS NOT NULL AND match_key IS NOT NULL)
  )
);

CREATE UNIQUE INDEX manual_bank_review_account_once
  ON manual_bank_reconciliation_review_evidence(scope_id, bank_transaction_id)
  WHERE review_kind = 'ACCOUNT_RESOLUTION';

CREATE UNIQUE INDEX manual_bank_review_pair_once
  ON manual_bank_reconciliation_review_evidence(scope_id, bank_transaction_id, receipt_id)
  WHERE review_kind = 'RECEIPT_BANK_MATCH';

CREATE INDEX manual_bank_review_transaction_idx
  ON manual_bank_reconciliation_review_evidence(scope_id, bank_transaction_id, created_at);

CREATE FUNCTION reject_manual_bank_reconciliation_review_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'manual bank reconciliation review evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER manual_bank_reconciliation_review_append_only
  BEFORE UPDATE OR DELETE ON manual_bank_reconciliation_review_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_manual_bank_reconciliation_review_mutation();

-- The application role must not be able to manufacture operator evidence.
REVOKE ALL ON manual_bank_reconciliation_review_evidence FROM PUBLIC;
REVOKE ALL ON SEQUENCE manual_bank_reconciliation_review_evidence_id_seq FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reject_manual_bank_reconciliation_review_mutation() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'REVOKE ALL ON public.manual_bank_reconciliation_review_evidence FROM receipt_collector';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.manual_bank_reconciliation_review_evidence_id_seq FROM receipt_collector';
  END IF;
END $$;

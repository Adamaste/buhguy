-- Direct, proof-qualified bank purchases share the existing business-event and
-- ledger model. Existing matched-purchase evidence rows keep their old shape.
ALTER TABLE business_event_bank_evidence
  ALTER COLUMN bank_receipt_match_id DROP NOT NULL,
  ADD COLUMN bank_transaction_id BIGINT REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN financial_account_id BIGINT,
  ADD COLUMN evidence_snapshot JSONB,
  ADD COLUMN evidence_sha256 CHAR(64);

ALTER TABLE business_event_bank_evidence
  ADD CONSTRAINT business_event_bank_evidence_scope_account_fk
    FOREIGN KEY (scope_id, financial_account_id)
    REFERENCES financial_accounts(scope_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT business_event_bank_evidence_evidence_role_check,
  ADD CONSTRAINT business_event_bank_evidence_evidence_role_check
    CHECK (evidence_role IN ('BANK_PURCHASE_MATCH', 'BANK_ONLY_PURCHASE')),
  ADD CONSTRAINT business_event_bank_evidence_shape_check CHECK (
    (evidence_role = 'BANK_PURCHASE_MATCH'
      AND bank_receipt_match_id IS NOT NULL
      AND bank_transaction_id IS NULL
      AND financial_account_id IS NULL
      AND evidence_snapshot IS NULL
      AND evidence_sha256 IS NULL)
    OR
    (evidence_role = 'BANK_ONLY_PURCHASE'
      AND bank_receipt_match_id IS NULL
      AND bank_transaction_id IS NOT NULL
      AND financial_account_id IS NOT NULL
      AND evidence_snapshot IS NOT NULL
      AND evidence_sha256 IS NOT NULL
      AND evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND rule_version = 'bank-only-purchase-v1')
  );

CREATE UNIQUE INDEX business_event_bank_evidence_bank_only_transaction_unique
  ON business_event_bank_evidence(scope_id, bank_transaction_id)
  WHERE evidence_role = 'BANK_ONLY_PURCHASE';

CREATE UNIQUE INDEX business_event_bank_evidence_bank_only_event_unique
  ON business_event_bank_evidence(scope_id, business_event_id)
  WHERE evidence_role = 'BANK_ONLY_PURCHASE';

CREATE FUNCTION reject_bank_only_purchase_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.evidence_role = 'BANK_ONLY_PURCHASE'
    OR (TG_OP = 'UPDATE' AND NEW.evidence_role = 'BANK_ONLY_PURCHASE') THEN
    RAISE EXCEPTION 'bank-only purchase evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER business_event_bank_evidence_bank_only_append_only
  BEFORE UPDATE OR DELETE ON business_event_bank_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_bank_only_purchase_evidence_mutation();

-- Only the existing ingestion runtime receives access to the new evidence
-- columns; this adds no UPDATE, DELETE, or broader table privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (id, scope_id, business_event_id, bank_receipt_match_id, bank_transaction_id, financial_account_id, enrichment_key, evidence_role, rule_version, semantic_key, evidence_snapshot, evidence_sha256, created_at) ON public.business_event_bank_evidence TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, business_event_id, bank_receipt_match_id, bank_transaction_id, financial_account_id, enrichment_key, evidence_role, rule_version, semantic_key, evidence_snapshot, evidence_sha256) ON public.business_event_bank_evidence TO receipt_collector';
  END IF;
END $$;

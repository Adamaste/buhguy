-- Keep a proven bank payment as funding evidence on the prepayment event.
-- This does not create a separate purchase or ledger outflow.
ALTER TABLE business_event_bank_evidence
  DROP CONSTRAINT business_event_bank_evidence_evidence_role_check,
  ADD CONSTRAINT business_event_bank_evidence_evidence_role_check
    CHECK (evidence_role IN ('BANK_PURCHASE_MATCH', 'BANK_ONLY_PURCHASE', 'PREPAYMENT_BANK_FUNDING')),
  DROP CONSTRAINT business_event_bank_evidence_shape_check,
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
    OR
    (evidence_role = 'PREPAYMENT_BANK_FUNDING'
      AND bank_receipt_match_id IS NULL
      AND bank_transaction_id IS NOT NULL
      AND financial_account_id IS NOT NULL
      AND evidence_snapshot IS NOT NULL
      AND evidence_sha256 IS NOT NULL
      AND evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND rule_version = 'prepayment-bank-funding-v1')
  );

CREATE UNIQUE INDEX business_event_bank_evidence_prepayment_bank_unique
  ON business_event_bank_evidence(scope_id, bank_transaction_id)
  WHERE evidence_role = 'PREPAYMENT_BANK_FUNDING';

CREATE UNIQUE INDEX business_event_bank_evidence_prepayment_event_unique
  ON business_event_bank_evidence(scope_id, business_event_id)
  WHERE evidence_role = 'PREPAYMENT_BANK_FUNDING';

CREATE UNIQUE INDEX ledger_source_links_prepayment_bank_unique
  ON ledger_source_links(bank_transaction_id)
  WHERE link_role = 'PREPAYMENT_BANK_FUNDING';

CREATE UNIQUE INDEX ledger_source_links_prepayment_event_unique
  ON ledger_source_links(business_event_id)
  WHERE link_role = 'PREPAYMENT_BANK_FUNDING';

CREATE OR REPLACE FUNCTION reject_bank_only_purchase_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.evidence_role IN ('BANK_ONLY_PURCHASE', 'PREPAYMENT_BANK_FUNDING')
    OR (TG_OP = 'UPDATE' AND NEW.evidence_role IN ('BANK_ONLY_PURCHASE', 'PREPAYMENT_BANK_FUNDING')) THEN
    RAISE EXCEPTION 'bank purchase funding evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- The lifecycle writer uses the existing runtime role and adds only the
-- columns needed to enforce the prepayment cutoff and persist its evidence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    -- The graph repository uses column-scoped conflict updates only to fill
    -- descriptive metadata; it must not gain table-wide UPDATE privileges.
    EXECUTE 'GRANT SELECT (rule_code, rule_version, description), UPDATE (description) ON public.business_graph_rules TO receipt_collector';
    EXECUTE 'GRANT SELECT (description), UPDATE (description) ON public.business_events TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, semantic_key), INSERT (scope_id, source_event_id, target_event_id, relation_type, resolution_status, origin, graph_model_version, rule_code, rule_version, semantic_key, explanation) ON public.business_event_edges TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, semantic_key), INSERT (scope_id, target_event_id, source_receipt_id, source_receipt_item_id, normalization_version, allocated_quantity, allocated_amount, currency, allocation_role, resolution_status, origin, graph_model_version, rule_code, rule_version, semantic_key, explanation) ON public.business_event_allocations TO receipt_collector';
    EXECUTE 'GRANT INSERT (receipt_item_id) ON public.business_event_evidence TO receipt_collector';
    EXECUTE 'GRANT UPDATE (description, derivation_status, certification_status, reason_code) ON public.ledger_entries TO receipt_collector';
    EXECUTE 'GRANT INSERT (source_allocation_id) ON public.ledger_postings TO receipt_collector';
    EXECUTE 'GRANT SELECT (fns_id, seller_inn, operation_type) ON public.receipts TO receipt_collector';
    EXECUTE 'GRANT SELECT (observed_at) ON public.receipt_source_observations TO receipt_collector';
    EXECUTE 'GRANT SELECT (name, quantity, price, item_sum, position) ON public.receipt_items TO receipt_collector';
    EXECUTE 'GRANT SELECT (provider_inn, gtin, raw_product_code) ON public.receipt_item_fiscal_facts TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, business_event_id, bank_receipt_match_id, bank_transaction_id, financial_account_id, enrichment_key, evidence_role, rule_version, semantic_key, evidence_snapshot, evidence_sha256, created_at) ON public.business_event_bank_evidence TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, business_event_id, bank_receipt_match_id, bank_transaction_id, financial_account_id, enrichment_key, evidence_role, rule_version, semantic_key, evidence_snapshot, evidence_sha256) ON public.business_event_bank_evidence TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.business_event_edges_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.business_event_allocations_id_seq TO receipt_collector';
  END IF;
END $$;

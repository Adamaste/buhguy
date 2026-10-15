-- Least-privilege DML for the matched-purchase writer. Row serialization is
-- coordinated with transaction advisory locks; this migration grants no UPDATE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (id, scope_key) ON public.accounting_scopes TO receipt_collector';

    EXECUTE 'GRANT SELECT (id, scope_id, bank_transaction_id, receipt_id, financial_account_id, matcher_version, match_key, bank_ledger_key, bank_candidate_key, bank_journal_key, receipt_candidate_key, receipt_normalization_version, receipt_normalized_content_sha256, amount, currency, bank_occurred_at, receipt_date_time, time_delta_seconds, relationship_type, reason_code, ownership_provenance) ON public.bank_receipt_matches TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, bank_transaction_id, receipt_id, financial_account_id, matcher_version, match_key, bank_ledger_key, bank_candidate_key, bank_journal_key, receipt_candidate_key, receipt_normalization_version, receipt_normalized_content_sha256, amount, currency, bank_occurred_at, receipt_date_time, time_delta_seconds, relationship_type, reason_code, ownership_provenance) ON public.bank_receipt_matches TO receipt_collector';

    EXECUTE 'GRANT INSERT (rule_code, rule_version, description) ON public.business_graph_rules TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, event_type, resolution_status, origin, graph_model_version, rule_code, rule_version, semantic_key, amount, currency) ON public.business_events TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, event_type, resolution_status, origin, graph_model_version, rule_code, rule_version, semantic_key, amount, currency, description) ON public.business_events TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, event_id, receipt_id, normalization_version, evidence_role, origin, graph_model_version, rule_code, rule_version, semantic_key) ON public.business_event_evidence TO receipt_collector';
    EXECUTE 'GRANT INSERT (event_id, receipt_id, normalization_version, evidence_role, origin, graph_model_version, rule_code, rule_version, semantic_key) ON public.business_event_evidence TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, business_event_id, bank_receipt_match_id, enrichment_key, evidence_role, rule_version, semantic_key) ON public.business_event_bank_evidence TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, business_event_id, bank_receipt_match_id, enrichment_key, evidence_role, rule_version, semantic_key) ON public.business_event_bank_evidence TO receipt_collector';

    EXECUTE 'GRANT SELECT (id, scope_id, account_code, account_type, financial_account_id, account_currency) ON public.ledger_accounts TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, account_code, account_type, description, financial_account_id, account_currency) ON public.ledger_accounts TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, source_event_id, currency, event_at, semantic_key, derivation_rule, derivation_version, derivation_status, certification_status, origin, reason_code, description) ON public.ledger_entries TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, source_event_id, currency, event_at, semantic_key, derivation_rule, derivation_version, derivation_status, certification_status, origin, reason_code, description) ON public.ledger_entries TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, ledger_entry_id, account_id, currency, debit, credit, source_allocation_id, source_receipt_id) ON public.ledger_postings TO receipt_collector';
    EXECUTE 'GRANT INSERT (ledger_entry_id, account_id, currency, debit, credit, source_receipt_id) ON public.ledger_postings TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, ledger_entry_id, business_event_id, graph_evidence_id, graph_allocation_id, receipt_id, normalization_version, link_role, semantic_key, bank_receipt_match_id, bank_transaction_id) ON public.ledger_source_links TO receipt_collector';
    EXECUTE 'GRANT INSERT (ledger_entry_id, business_event_id, graph_evidence_id, receipt_id, normalization_version, link_role, semantic_key, bank_receipt_match_id, bank_transaction_id) ON public.ledger_source_links TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, superseded_ledger_entry_id, replacement_ledger_entry_id, business_event_id, enrichment_key, semantic_key, reason_code) ON public.ledger_entry_supersessions TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, superseded_ledger_entry_id, replacement_ledger_entry_id, business_event_id, enrichment_key, semantic_key, reason_code) ON public.ledger_entry_supersessions TO receipt_collector';

    EXECUTE 'GRANT SELECT (id, scope_id, model_version, source_state_key, period_from, period_to, status, finished_at) ON public.reconciliation_runs TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, model_version, source_state_key, period_from, period_to, status, finished_at) ON public.reconciliation_runs TO receipt_collector';
    EXECUTE 'GRANT SELECT (run_id, scope_id, subject_type, subject_id, metric_code, dimension, status, amount, currency, event_at, reason_code, rule_code, rule_version, ledger_entry_id, business_event_id, graph_evidence_id, semantic_key, source_state_key) ON public.certification_facts TO receipt_collector';
    EXECUTE 'GRANT INSERT (run_id, scope_id, subject_type, subject_id, metric_code, dimension, status, amount, currency, event_at, reason_code, rule_code, rule_version, ledger_entry_id, business_event_id, graph_evidence_id, semantic_key, source_state_key) ON public.certification_facts TO receipt_collector';
    EXECUTE 'GRANT SELECT (run_id, metric_code, status, amount, currency, count_items, reason_code, semantic_key) ON public.reconciliation_results TO receipt_collector';
    EXECUTE 'GRANT INSERT (run_id, metric_code, status, amount, currency, count_items, reason_code, semantic_key) ON public.reconciliation_results TO receipt_collector';

    EXECUTE 'GRANT USAGE ON SEQUENCE public.bank_receipt_matches_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.business_events_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.business_event_evidence_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.business_event_bank_evidence_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.ledger_accounts_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.ledger_entries_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.ledger_postings_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.ledger_source_links_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.ledger_entry_supersessions_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.reconciliation_runs_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.certification_facts_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.reconciliation_results_id_seq TO receipt_collector';
  END IF;
END $$;

-- Minimal column-level reads needed to match newly ingested purchases against
-- receipts using their confirmed account resolution and binding provenance.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (financial_account_id) ON public.payment_instruments TO receipt_collector';
    EXECUTE 'GRANT SELECT (amount, currency, occurred_at, event_type, direction, normalization_status, evidence_quality) ON public.bank_transactions TO receipt_collector';
    EXECUTE 'GRANT SELECT (bank_transaction_id, financial_account_id, resolution_state, provenance) ON public.bank_transaction_account_resolution TO receipt_collector';
    EXECUTE 'GRANT SELECT (provenance) ON public.bank_source_provider_account_bindings TO receipt_collector';
    EXECUTE 'GRANT SELECT (currency) ON public.financial_accounts TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, bank_transaction_id, receipt_id, match_key) ON public.bank_receipt_matches TO receipt_collector';
  END IF;
END $$;

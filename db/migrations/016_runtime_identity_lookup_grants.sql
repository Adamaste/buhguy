-- Least-privilege lookup surface for automatic identity resolution during ingestion.
-- Keep fresh disposable databases migratable even when the runtime role has not
-- been created yet; production and the restricted-role test grant below when
-- receipt_collector exists.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (id, scope_id) ON public.financial_accounts TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id) ON public.payment_instruments TO receipt_collector';
    EXECUTE 'GRANT SELECT (provider, reference_kind, reference_value, financial_account_id, payment_instrument_id) ON public.bank_account_references TO receipt_collector';
    EXECUTE 'GRANT SELECT (bank_source_id, person_id, relation_type) ON public.bank_source_person TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id) ON public.persons TO receipt_collector';
    EXECUTE 'GRANT INSERT ON public.bank_transaction_payment_instrument_resolution TO receipt_collector';
  END IF;
END $$;

-- Minimal runtime reads needed to prove newly ingested purchases against the
-- normalized event and independently confirmed source/provider account binding.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (financial_account_id) ON public.payment_instruments TO receipt_collector';
    EXECUTE 'GRANT SELECT (event_type, direction, normalization_status, evidence_quality) ON public.bank_transactions TO receipt_collector';
  END IF;
END $$;

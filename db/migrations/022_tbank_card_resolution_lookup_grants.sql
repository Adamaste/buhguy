-- Allow the ingestion role to validate only the card and account attributes
-- required for exact, same-scope T-Bank account resolution.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (provider, instrument_type, active) ON public.payment_instruments TO receipt_collector';
    EXECUTE 'GRANT SELECT (active) ON public.financial_accounts TO receipt_collector';
  END IF;
END $$;

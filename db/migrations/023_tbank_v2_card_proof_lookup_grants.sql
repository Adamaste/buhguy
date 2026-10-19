-- Permit the runtime to read only the persisted payment-instrument identity
-- resolution needed for card-specific T-Bank V2 matching.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (bank_transaction_id, payment_instrument_id, resolution_state, provenance) ON public.bank_transaction_payment_instrument_resolution TO receipt_collector';
  END IF;
END $$;

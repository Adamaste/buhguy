-- Apply as a database administrator after reviewing the read-only privilege check.
-- This is the least-privilege DML surface used by the bank ingestion HTTP service.

GRANT USAGE ON SCHEMA public TO receipt_collector;

GRANT SELECT ON public.bank_sources TO receipt_collector;
GRANT SELECT ON public.bank_device_credentials TO receipt_collector;
GRANT UPDATE (last_used_at) ON public.bank_device_credentials TO receipt_collector;
GRANT SELECT, INSERT ON public.bank_event_observations TO receipt_collector;
GRANT INSERT ON public.bank_transactions TO receipt_collector;
GRANT SELECT (id, observation_id, account_reference, account_reference_kind) ON public.bank_transactions TO receipt_collector;
GRANT SELECT (amount, currency, occurred_at, event_type, direction, normalization_status, evidence_quality) ON public.bank_transactions TO receipt_collector;
GRANT INSERT ON public.bank_transaction_account_resolution TO receipt_collector;
GRANT SELECT (bank_transaction_id, financial_account_id, resolution_state, provenance) ON public.bank_transaction_account_resolution TO receipt_collector;
GRANT SELECT (id, scope_id) ON public.financial_accounts TO receipt_collector;
GRANT SELECT (currency) ON public.financial_accounts TO receipt_collector;
GRANT SELECT (id, scope_id) ON public.payment_instruments TO receipt_collector;
GRANT SELECT (financial_account_id) ON public.payment_instruments TO receipt_collector;
GRANT SELECT (provider, reference_kind, reference_value, financial_account_id, payment_instrument_id)
  ON public.bank_account_references TO receipt_collector;
GRANT SELECT (bank_source_id, person_id, relation_type) ON public.bank_source_person TO receipt_collector;
GRANT SELECT (id, scope_id) ON public.persons TO receipt_collector;
GRANT INSERT ON public.bank_transaction_payment_instrument_resolution TO receipt_collector;
GRANT SELECT (bank_source_id, provider, financial_account_id, active)
  ON public.bank_source_provider_account_bindings TO receipt_collector;
GRANT SELECT (provenance) ON public.bank_source_provider_account_bindings TO receipt_collector;
GRANT SELECT (id, scope_id, bank_transaction_id, receipt_id, match_key)
  ON public.bank_receipt_matches TO receipt_collector;

GRANT USAGE ON SEQUENCE public.bank_event_observations_id_seq TO receipt_collector;
GRANT USAGE ON SEQUENCE public.bank_transactions_id_seq TO receipt_collector;

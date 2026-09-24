-- Apply as a database administrator after reviewing the read-only privilege check.
-- This is the least-privilege DML surface used by the bank ingestion HTTP service.

GRANT USAGE ON SCHEMA public TO receipt_collector;

GRANT SELECT ON public.bank_sources TO receipt_collector;
GRANT SELECT ON public.bank_device_credentials TO receipt_collector;
GRANT UPDATE (last_used_at) ON public.bank_device_credentials TO receipt_collector;
GRANT SELECT, INSERT ON public.bank_event_observations TO receipt_collector;
GRANT INSERT ON public.bank_transactions TO receipt_collector;

GRANT USAGE ON SEQUENCE public.bank_event_observations_id_seq TO receipt_collector;
GRANT USAGE ON SEQUENCE public.bank_transactions_id_seq TO receipt_collector;

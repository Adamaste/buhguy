GRANT SELECT, INSERT, UPDATE ON public.persons TO receipt_collector;
GRANT USAGE, SELECT ON SEQUENCE public.persons_id_seq TO receipt_collector;
GRANT SELECT, INSERT, UPDATE ON public.fns_sources TO receipt_collector;
GRANT USAGE, SELECT ON SEQUENCE public.fns_sources_id_seq TO receipt_collector;
GRANT SELECT, INSERT ON public.fns_source_person TO receipt_collector;
GRANT SELECT, INSERT ON public.receipt_source_observations TO receipt_collector;
GRANT USAGE, SELECT ON SEQUENCE public.receipt_source_observations_id_seq TO receipt_collector;
GRANT SELECT, INSERT, UPDATE ON public.fns_source_sync_state TO receipt_collector;

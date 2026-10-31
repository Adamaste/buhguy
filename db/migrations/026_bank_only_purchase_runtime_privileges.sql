-- Narrow runtime permissions used by bank-only persistence and Ledger V1.
-- Avoid table-wide privileges; the ledger writer remains unable to UPDATE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (merchant) ON public.bank_transactions TO receipt_collector';
    EXECUTE 'GRANT SELECT (created_at) ON public.business_events TO receipt_collector';
    EXECUTE 'GRANT SELECT (scope_id, source_event_id, target_event_id, relation_type) ON public.business_event_edges TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, target_event_id, source_receipt_id, allocated_amount, resolution_status) ON public.business_event_allocations TO receipt_collector';
    EXECUTE 'GRANT INSERT (graph_allocation_id) ON public.ledger_source_links TO receipt_collector';
  END IF;
END $$;

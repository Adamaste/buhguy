SELECT 'schema_head' AS metric, COALESCE(max(filename), '')::text AS value FROM schema_migrations;
SELECT 'receipts' AS metric, count(*)::text AS value FROM receipts
UNION ALL SELECT 'receipt_items', count(*)::text FROM receipt_items
UNION ALL SELECT 'receipt_raw', count(*)::text FROM receipt_raw
UNION ALL SELECT 'duplicate_fns_id', count(*)::text FROM (SELECT fns_id FROM receipts GROUP BY fns_id HAVING count(*) > 1) q
UNION ALL SELECT 'duplicate_canonical_tuple', count(*)::text FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL AND fiscal_document_number IS NOT NULL AND fiscal_sign IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1) q
UNION ALL SELECT 'normalization_issues', count(*)::text FROM normalization_issues
UNION ALL SELECT 'business_events', count(*)::text FROM business_events
UNION ALL SELECT 'business_event_evidence', count(*)::text FROM business_event_evidence
UNION ALL SELECT 'business_event_edges', count(*)::text FROM business_event_edges
UNION ALL SELECT 'business_event_allocations', count(*)::text FROM business_event_allocations
UNION ALL SELECT 'ledger_entries', count(*)::text FROM ledger_entries
UNION ALL SELECT 'ledger_postings', count(*)::text FROM ledger_postings
UNION ALL SELECT 'ledger_source_links', count(*)::text FROM ledger_source_links
UNION ALL SELECT 'ledger_balance_violations', count(*)::text FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING sum(debit - credit) <> 0) q
UNION ALL SELECT 'certification_facts', count(*)::text FROM certification_facts
UNION ALL SELECT 'reconciliation_runs', count(*)::text FROM reconciliation_runs
UNION ALL SELECT 'reconciliation_results', count(*)::text FROM reconciliation_results
UNION ALL SELECT 'analytics_purchases', count(*)::text FROM analytics_purchases;
SELECT 'sync_last_state' AS metric, COALESCE(account_key,'')||'|'||COALESCE(last_sync_finished_at::text,'')||'|'||COALESCE(last_error,'') AS value FROM sync_state ORDER BY account_key;

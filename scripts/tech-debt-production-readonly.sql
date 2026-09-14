SELECT 'source' AS section,
  (SELECT count(*) FROM receipts) AS receipts,
  (SELECT count(*) FROM receipt_items) AS receipt_items,
  (SELECT count(*) FROM receipt_raw) AS receipt_raw,
  (SELECT count(*) FROM receipt_fiscal_facts) AS fiscal_facts,
  (SELECT count(*) FROM receipt_item_fiscal_facts) AS item_fiscal_facts;
SELECT 'graph_ledger' AS section,
  (SELECT count(*) FROM business_events) AS business_events,
  (SELECT count(*) FROM business_event_evidence) AS evidence,
  (SELECT count(*) FROM business_event_edges) AS edges,
  (SELECT count(*) FROM business_event_allocations) AS allocations,
  (SELECT count(*) FROM ledger_entries) AS ledger_entries,
  (SELECT count(*) FROM ledger_postings) AS ledger_postings,
  (SELECT count(*) FROM ledger_source_links) AS ledger_links;
SELECT 'certification' AS section,
  (SELECT count(*) FROM certification_facts) AS certification_facts,
  (SELECT count(*) FROM reconciliation_runs) AS runs,
  (SELECT count(*) FROM reconciliation_results) AS results;
SELECT 'duplicates' AS section,
  (SELECT count(*) FROM (SELECT fns_id FROM receipts GROUP BY fns_id HAVING count(*) > 1) q) AS duplicate_fns_id,
  (SELECT count(*) FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts GROUP BY fiscal_drive_number,fiscal_document_number,fiscal_sign HAVING count(*) > 1) q) AS duplicate_canonical;
SELECT 'ledger_balance' AS section, count(*) AS violations
FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING sum(debit) <> sum(credit)) q;

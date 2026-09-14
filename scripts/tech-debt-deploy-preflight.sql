SELECT 'source' AS section,
  (SELECT count(*)::int FROM receipts) AS receipts,
  (SELECT count(*)::int FROM receipt_items) AS receipt_items,
  (SELECT count(*)::int FROM receipt_raw) AS receipt_raw,
  (SELECT count(*)::int FROM receipt_fiscal_facts) AS fiscal_facts,
  (SELECT count(*)::int FROM receipt_item_fiscal_facts) AS item_fiscal_facts,
  (SELECT count(*)::int FROM normalization_issues) AS normalization_issues;
SELECT 'graph' AS section,
  (SELECT count(*)::int FROM business_events) AS events,
  (SELECT count(*)::int FROM business_event_evidence) AS evidence,
  (SELECT count(*)::int FROM business_event_edges) AS edges,
  (SELECT count(*)::int FROM business_event_allocations) AS allocations;
SELECT 'ledger' AS section,
  (SELECT count(*)::int FROM ledger_entries) AS entries,
  (SELECT count(*)::int FROM ledger_postings) AS postings,
  (SELECT count(*)::int FROM ledger_source_links) AS source_links,
  (SELECT count(*)::int FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING sum(debit)<>sum(credit)) q) AS balance_violations;
SELECT 'certification' AS section,
  (SELECT count(*)::int FROM certification_facts) AS facts,
  (SELECT count(*)::int FROM reconciliation_runs) AS runs,
  (SELECT count(*)::int FROM reconciliation_results) AS results;
SELECT 'analytics' AS section, (SELECT count(*)::int FROM analytics_purchases) AS analytics_purchases;
SELECT 'duplicates' AS section,
  (SELECT count(*)::int FROM (SELECT fns_id FROM receipts GROUP BY fns_id HAVING count(*)>1) q) AS duplicate_fns_id,
  (SELECT count(*)::int FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts GROUP BY fiscal_drive_number,fiscal_document_number,fiscal_sign HAVING count(*)>1) q) AS duplicate_canonical;

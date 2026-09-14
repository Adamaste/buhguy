\i /tmp/tech-debt-deploy-preflight.sql
SELECT id, date_time, total_sum, operation_type, fns_id
FROM receipts
WHERE id IN (54,62)
ORDER BY id;
SELECT r.id, r.total_sum, r.operation_type, le.derivation_status, le.derivation_rule,
       count(p.id)::int AS postings
FROM receipts r
LEFT JOIN business_event_evidence ev ON ev.receipt_id=r.id
LEFT JOIN ledger_entries le ON le.source_event_id=ev.event_id
LEFT JOIN ledger_postings p ON p.ledger_entry_id=le.id
WHERE r.id IN (54,62)
GROUP BY r.id,r.total_sum,r.operation_type,le.derivation_status,le.derivation_rule
ORDER BY r.id;

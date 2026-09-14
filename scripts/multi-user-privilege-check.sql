SELECT c.relname,
  has_table_privilege('receipt_collector', c.oid, 'SELECT') AS can_select,
  has_table_privilege('receipt_collector', c.oid, 'INSERT') AS can_insert,
  has_table_privilege('receipt_collector', c.oid, 'UPDATE') AS can_update
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=current_schema()
  AND c.relname IN ('persons','fns_sources','fns_source_person','receipt_source_observations','fns_source_sync_state')
ORDER BY c.relname;

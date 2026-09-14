SELECT c.relname, c.relkind, r.rolname AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_roles r ON r.oid=c.relowner
WHERE n.nspname=current_schema()
  AND c.relname IN ('persons','persons_id_seq','fns_sources','fns_sources_id_seq','fns_source_person','receipt_source_observations','receipt_source_observations_id_seq','fns_source_sync_state')
ORDER BY c.relname;
SELECT c.relname,
  has_table_privilege('receipt_collector', c.oid, 'SELECT') AS can_select,
  has_table_privilege('receipt_collector', c.oid, 'INSERT') AS can_insert,
  has_table_privilege('receipt_collector', c.oid, 'UPDATE') AS can_update,
  has_table_privilege('receipt_collector', c.oid, 'DELETE') AS can_delete
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=current_schema()
  AND c.relname IN ('persons','fns_sources','fns_source_person','receipt_source_observations','fns_source_sync_state')
ORDER BY c.relname;
SELECT has_table_privilege('receipt_collector', 'accounting_scopes', 'SELECT'),
       has_table_privilege('receipt_collector', 'accounting_scopes', 'INSERT'),
       has_table_privilege('receipt_collector', 'accounting_scopes', 'UPDATE');
SELECT c.relname,
  has_sequence_privilege('receipt_collector', c.oid, 'USAGE') AS can_usage,
  has_sequence_privilege('receipt_collector', c.oid, 'SELECT') AS can_select
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=current_schema() AND c.relkind='S'
  AND c.relname IN ('persons_id_seq','fns_sources_id_seq','receipt_source_observations_id_seq')
ORDER BY c.relname;

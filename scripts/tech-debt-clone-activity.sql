SELECT pid, usename, wait_event_type, wait_event, state, query
FROM pg_stat_activity
WHERE datname = 'finance_receipt_collector_techdebt_clone_20260907'
  AND pid <> pg_backend_pid();

SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'finance_receipt_collector_techdebt_clone_20260907'
  AND pid <> pg_backend_pid();

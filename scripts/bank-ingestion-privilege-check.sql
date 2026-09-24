-- Read-only verification for the bank ingestion runtime role.

SELECT current_user AS checked_role,
  has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage;

SELECT object_name, privilege_name, has_table_privilege(current_user, object_name, privilege_name) AS granted
FROM (VALUES
  ('public.bank_sources'::text, 'SELECT'::text),
  ('public.bank_device_credentials'::text, 'SELECT'::text),
  ('public.bank_device_credentials'::text, 'UPDATE'::text),
  ('public.bank_event_observations'::text, 'SELECT'::text),
  ('public.bank_event_observations'::text, 'INSERT'::text),
  ('public.bank_transactions'::text, 'INSERT'::text)
) AS required(object_name, privilege_name)
ORDER BY object_name, privilege_name;

SELECT object_name, privilege_name, has_sequence_privilege(current_user, object_name, privilege_name) AS granted
FROM (VALUES
  ('public.bank_event_observations_id_seq'::text, 'USAGE'::text),
  ('public.bank_event_observations_id_seq'::text, 'SELECT'::text),
  ('public.bank_transactions_id_seq'::text, 'USAGE'::text),
  ('public.bank_transactions_id_seq'::text, 'SELECT'::text)
) AS required(object_name, privilege_name)
ORDER BY object_name, privilege_name;

SELECT object_name, privilege_name, has_table_privilege(current_user, object_name, privilege_name) AS granted
FROM (VALUES
  ('public.bank_sources'::text, 'INSERT'::text),
  ('public.bank_sources'::text, 'UPDATE'::text),
  ('public.bank_sources'::text, 'DELETE'::text),
  ('public.bank_device_credentials'::text, 'INSERT'::text),
  ('public.bank_device_credentials'::text, 'DELETE'::text),
  ('public.bank_event_observations'::text, 'UPDATE'::text),
  ('public.bank_event_observations'::text, 'DELETE'::text),
  ('public.bank_transactions'::text, 'UPDATE'::text),
  ('public.bank_transactions'::text, 'DELETE'::text)
) AS forbidden(object_name, privilege_name)
ORDER BY object_name, privilege_name;

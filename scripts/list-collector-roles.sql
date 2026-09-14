SELECT rolname FROM pg_roles WHERE rolname ILIKE '%receipt%' OR rolname ILIKE '%collector%' ORDER BY rolname;

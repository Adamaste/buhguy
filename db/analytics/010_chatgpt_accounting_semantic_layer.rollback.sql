REVOKE ALL ON ALL TABLES IN SCHEMA chatgpt_accounting FROM chatgpt_reader;
REVOKE USAGE ON SCHEMA chatgpt_accounting FROM chatgpt_reader;
DROP SCHEMA IF EXISTS chatgpt_accounting CASCADE;

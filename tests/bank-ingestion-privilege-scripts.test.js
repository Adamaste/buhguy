import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('bank ingestion grant script is narrowly scoped to runtime DML', async () => {
  const sql = await readFile(new URL('scripts/apply-bank-ingestion-grants.sql', root), 'utf8');

  assert.match(sql, /GRANT USAGE ON SCHEMA public TO receipt_collector/);
  assert.match(sql, /GRANT SELECT ON public\.bank_sources TO receipt_collector/);
  assert.match(sql, /GRANT SELECT ON public\.bank_device_credentials TO receipt_collector/);
  assert.match(sql, /GRANT UPDATE \(last_used_at\) ON public\.bank_device_credentials TO receipt_collector/);
  assert.doesNotMatch(sql, /GRANT SELECT, UPDATE ON public\.bank_device_credentials/i);
  assert.match(sql, /GRANT SELECT, INSERT ON public\.bank_event_observations TO receipt_collector/);
  assert.match(sql, /GRANT INSERT ON public\.bank_transactions TO receipt_collector/);
  assert.match(sql, /GRANT SELECT \(id, observation_id, account_reference, account_reference_kind\) ON public\.bank_transactions TO receipt_collector/);
  assert.match(sql, /GRANT INSERT ON public\.bank_transaction_account_resolution TO receipt_collector/);
  assert.match(sql, /GRANT INSERT ON public\.bank_transaction_payment_instrument_resolution TO receipt_collector/);
  assert.match(sql, /GRANT INSERT ON public\.bank_balance_observations TO receipt_collector/);
  for (const table of ['financial_accounts', 'payment_instruments', 'bank_account_references', 'bank_source_person', 'persons']) {
    assert.match(sql, new RegExp(`GRANT SELECT \\([^)]*\\)\\s+ON public\\.${table}`));
  }
  assert.doesNotMatch(sql, /GRANT (?:SELECT|UPDATE|DELETE) ON public\.bank_transaction_account_resolution TO receipt_collector/);
  assert.doesNotMatch(sql, /GRANT SELECT ON public\.bank_transactions TO receipt_collector/);
  assert.match(sql, /GRANT USAGE ON SEQUENCE public\.bank_event_observations_id_seq TO receipt_collector/);
  assert.match(sql, /GRANT USAGE ON SEQUENCE public\.bank_transactions_id_seq TO receipt_collector/);
  assert.doesNotMatch(sql, /GRANT USAGE, SELECT ON SEQUENCE/i);
  assert.doesNotMatch(sql, /GRANT\s+REFERENCES/i);
  assert.doesNotMatch(sql, /GRANT\s+ALL/i);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE)\s+ON\s+public\.(?:bank_sources|bank_source_person)/i);
  assert.doesNotMatch(sql, /(?:CREATE|ALTER|DROP|REVOKE|TRUNCATE)\s+(?:ROLE|USER|TABLE|SCHEMA|SEQUENCE)?/i);
});

test('bank ingestion privilege check covers required and forbidden capabilities', async () => {
  const sql = await readFile(new URL('scripts/bank-ingestion-privilege-check.sql', root), 'utf8');

  assert.match(sql, /SELECT 'receipt_collector' AS checked_role/);
  assert.match(sql, /has_schema_privilege\('receipt_collector', 'public', 'USAGE'\)/);
  assert.doesNotMatch(sql, /has_(?:schema|table|sequence|column)_privilege\(current_user/i);
  for (const objectName of ['bank_sources', 'bank_device_credentials', 'bank_event_observations', 'bank_transactions']) {
    assert.match(sql, new RegExp(`public\\.${objectName}`));
  }
  assert.match(sql, /bank_event_observations_id_seq/);
  assert.match(sql, /bank_transactions_id_seq/);
  assert.match(sql, /has_column_privilege\('receipt_collector', 'public\.bank_device_credentials'/);
  assert.match(sql, /has_column_privilege\('receipt_collector', 'public\.bank_transactions', column_name, privilege_name\)/);
  assert.match(sql, /'last_used_at'/);
  assert.match(sql, /'secret_hash'/);
  assert.match(sql, /'enabled'/);
  assert.match(sql, /'revoked_at'/);
  assert.match(sql, /'DELETE'/);
  assert.match(sql, /'UPDATE'/);
  assert.match(sql, /bank_transaction_payment_instrument_resolution/);
  assert.match(sql, /bank_balance_observations/);
  assert.match(sql, /financial_accounts/);
  assert.match(sql, /payment_instrument_person_relations/);
});

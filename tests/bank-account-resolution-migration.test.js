import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('bank account resolution migration keeps account ownership and resolution explicit', async () => {
  const sql = await readFile(new URL('../db/migrations/013_bank_account_resolution_foundation.sql', import.meta.url), 'utf8');
  for (const table of ['financial_accounts', 'financial_account_person_relations', 'payment_instruments', 'bank_account_references', 'bank_transaction_account_resolution']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /relation_type TEXT NOT NULL CHECK \(relation_type IN \('OWNER', 'AUTHORIZED_USER'\)\)/);
  assert.match(sql, /resolution_state TEXT NOT NULL CHECK \(resolution_state IN \('EXACT', 'MANUAL', 'RECONCILED', 'UNKNOWN'\)\)/);
  assert.match(sql, /resolution_state = 'UNKNOWN' AND financial_account_id IS NULL/);
  assert.match(sql, /bank_account_references_lookup_idx/);
  assert.doesNotMatch(sql, /UNIQUE \(provider, reference_kind, reference_value\)/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS .*ledger/i);
});

test('reference-kind migration preserves historical null compatibility', async () => {
  const sql = await readFile(new URL('../db/migrations/014_bank_transaction_account_reference_kind.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS account_reference_kind TEXT/);
  assert.match(sql, /account_reference_kind IS NULL/);
  assert.match(sql, /account_reference_kind IN \('MASKED_CARD', 'MASKED_ACCOUNT', 'OTHER'\)/);
  assert.match(sql, /MASKED_CARD.*MASKED_ACCOUNT.*OTHER/);
  assert.doesNotMatch(sql, /UPDATE\s+bank_transactions/i);
});

test('payment instrument identity migration allows standalone cards and exact reference targets', async () => {
  const sql = await readFile(new URL('../db/migrations/015_payment_instrument_identity.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS scope_id BIGINT/);
  assert.match(sql, /financial_account_id DROP NOT NULL/);
  assert.match(sql, /payment_instrument_person_relations/);
  assert.match(sql, /payment_instrument_one_owner_idx/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS payment_instrument_id BIGINT/);
  assert.match(sql, /bank_account_references_reference_target_check/);
  assert.match(sql, /reference_kind = 'MASKED_CARD'/);
  assert.match(sql, /reference_kind IN \('MASKED_ACCOUNT', 'OTHER'\)/);
  assert.match(sql, /bank_transaction_payment_instrument_resolution/);
  assert.match(sql, /payment_instrument_id IS NOT NULL/);
});

test('source/provider binding migration is scoped, active-unique, and runtime read-only', async () => {
  const sql = await readFile(new URL('../db/migrations/017_bank_source_provider_account_bindings.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS bank_source_provider_account_bindings/);
  assert.match(sql, /bank_source_id BIGINT NOT NULL REFERENCES bank_sources\(id\)/);
  assert.match(sql, /financial_account_id BIGINT NOT NULL REFERENCES financial_accounts\(id\)/);
  assert.match(sql, /provenance TEXT NOT NULL CHECK \(provenance = 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT'\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS bank_source_provider_active_binding_idx/);
  assert.match(sql, /WHERE active/);
  assert.match(sql, /GRANT SELECT \(bank_source_id, provider, financial_account_id, active\)/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE) ON public\.bank_source_provider_account_bindings/i);
});

test('automatic purchase matching migration grants only required column reads', async () => {
  const sql = await readFile(new URL('../db/migrations/020_runtime_payment_instrument_account_lookup.sql', import.meta.url), 'utf8');
  const expected = [
    /GRANT SELECT \(financial_account_id\) ON public\.payment_instruments TO receipt_collector/,
    /GRANT SELECT \(amount, currency, occurred_at, event_type, direction, normalization_status, evidence_quality\) ON public\.bank_transactions TO receipt_collector/,
    /GRANT SELECT \(bank_transaction_id, financial_account_id, resolution_state, provenance\) ON public\.bank_transaction_account_resolution TO receipt_collector/,
    /GRANT SELECT \(provenance\) ON public\.bank_source_provider_account_bindings TO receipt_collector/,
    /GRANT SELECT \(currency\) ON public\.financial_accounts TO receipt_collector/,
    /GRANT SELECT \(id, scope_id, bank_transaction_id, receipt_id, match_key\) ON public\.bank_receipt_matches TO receipt_collector/,
  ];
  for (const pattern of expected) assert.match(sql, pattern);
  assert.doesNotMatch(sql, /GRANT SELECT\s+ON public\./i);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i);
  assert.doesNotMatch(sql, /GRANT .* ON SEQUENCE/i);
});

test('T-Bank card resolution adds only the minimum runtime lookup privileges', async () => {
  const sql = await readFile(new URL('../db/migrations/022_tbank_card_resolution_lookup_grants.sql', import.meta.url), 'utf8');
  assert.match(sql, /GRANT SELECT \(provider, instrument_type, active\) ON public\.payment_instruments TO receipt_collector/);
  assert.match(sql, /GRANT SELECT \(active\) ON public\.financial_accounts TO receipt_collector/);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector'\)/);
  assert.doesNotMatch(sql, /GRANT SELECT\s+ON public\./i);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i);
  assert.doesNotMatch(sql, /GRANT .* ON SEQUENCE/i);
});

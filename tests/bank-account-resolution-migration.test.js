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
  assert.match(sql, /bank_account_references_exact_target_check/);
  assert.match(sql, /bank_transaction_payment_instrument_resolution/);
  assert.match(sql, /payment_instrument_id IS NOT NULL/);
});

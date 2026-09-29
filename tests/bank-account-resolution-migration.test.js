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
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS .*ledger/i);
});

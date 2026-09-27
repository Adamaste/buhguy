import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('bank transaction event type migration is additive and non-destructive', () => {
  const sql = readFileSync(new URL('../db/migrations/012_bank_transaction_event_type.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'UNKNOWN'/i);
  assert.doesNotMatch(sql, /DROP|TRUNCATE|DELETE/i);
});

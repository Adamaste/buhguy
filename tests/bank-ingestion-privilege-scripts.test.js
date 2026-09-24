import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('bank ingestion grant script is narrowly scoped to runtime DML', async () => {
  const sql = await readFile(new URL('scripts/apply-bank-ingestion-grants.sql', root), 'utf8');

  assert.match(sql, /GRANT USAGE ON SCHEMA public TO receipt_collector/);
  assert.match(sql, /GRANT SELECT ON public\.bank_sources TO receipt_collector/);
  assert.match(sql, /GRANT SELECT, UPDATE ON public\.bank_device_credentials TO receipt_collector/);
  assert.match(sql, /GRANT SELECT, INSERT ON public\.bank_event_observations TO receipt_collector/);
  assert.match(sql, /GRANT INSERT ON public\.bank_transactions TO receipt_collector/);
  assert.match(sql, /GRANT USAGE, SELECT ON SEQUENCE public\.bank_event_observations_id_seq TO receipt_collector/);
  assert.match(sql, /GRANT USAGE, SELECT ON SEQUENCE public\.bank_transactions_id_seq TO receipt_collector/);
  assert.doesNotMatch(sql, /GRANT\s+ALL/i);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE)\s+ON\s+public\.(?:bank_sources|bank_source_person)/i);
  assert.doesNotMatch(sql, /(?:CREATE|ALTER|DROP|REVOKE|TRUNCATE)\s+(?:ROLE|USER|TABLE|SCHEMA|SEQUENCE)?/i);
});

test('bank ingestion privilege check covers required and forbidden capabilities', async () => {
  const sql = await readFile(new URL('scripts/bank-ingestion-privilege-check.sql', root), 'utf8');

  assert.match(sql, /has_schema_privilege\(current_user, 'public', 'USAGE'\)/);
  for (const objectName of ['bank_sources', 'bank_device_credentials', 'bank_event_observations', 'bank_transactions']) {
    assert.match(sql, new RegExp(`public\\.${objectName}`));
  }
  assert.match(sql, /bank_event_observations_id_seq/);
  assert.match(sql, /bank_transactions_id_seq/);
  assert.match(sql, /'DELETE'/);
  assert.match(sql, /'UPDATE'/);
});

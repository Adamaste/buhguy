import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeReceiptDetail } from '../src/normalize.js';
import { syncReceipts } from '../src/sync.js';

for (const operationType of [1, 2, 3, 4]) {
  test(`normalize operationType=${operationType}`, () => {
    assert.equal(normalizeReceiptDetail({ key: 'r', operationType }).operationType, operationType);
  });
}

test('missing and invalid operationType normalize to null without failing ingest', () => {
  for (const value of [undefined, null, 0, 5, 'not-a-number']) {
    assert.equal(normalizeReceiptDetail({ key: String(value), operationType: value }).operationType, null);
  }
});

test('repeat sync preserves operation type and does not create a second receipt', async () => {
  const stored = new Map();
  const repository = {
    async updateSyncState() {},
    async upsertBundle({ normalized }) {
      const created = !stored.has(normalized.id);
      stored.set(normalized.id, normalized);
      return { created };
    },
  };
  const client = {
    async listReceipts() { return { hasMore: false, receipts: [{ id: 'r1' }] }; },
    async getReceiptRaw() { return { key: 'r1', operationType: 2, items: [] }; },
  };

  assert.deepEqual((await syncReceipts({ client, repository })).inserted, 1);
  assert.deepEqual((await syncReceipts({ client, repository })).alreadyExisted, 1);
  assert.equal(stored.get('r1').operationType, 2);
  assert.equal(stored.size, 1);
});

test('operation type migration contains safe constrained backfill', async () => {
  const migration = await readFile(path.join(process.cwd(), 'db', 'migrations', '002_operation_type.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS operation_type SMALLINT NULL/);
  assert.match(migration, /CHECK \(operation_type IN \(1, 2, 3, 4\)\)/);
  assert.match(migration, /raw\.payload->>'operationType'/);
  assert.match(migration, /receipt_raw AS raw/);
  assert.doesNotMatch(migration, /\b(DROP|DELETE)\b/i);
});

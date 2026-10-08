import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_SPENDING_SNAPSHOT_FAILURES,
  CURRENT_SPENDING_SNAPSHOT_MODEL,
  logCurrentSpendingSnapshot,
} from '../src/canonical-spending-current-snapshot.js';
import { readFile } from 'node:fs/promises';

test('current snapshot contract is authoritative, read-only, and fail-closed', async () => {
  const source = await readFile(new URL('../src/canonical-spending-current-snapshot.js', import.meta.url), 'utf8');
  const certification = await readFile(new URL('../src/certification.js', import.meta.url), 'utf8');
  assert.match(source, /certificationSourceStateKey\(/);
  assert.match(source, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /period_from IS NULL AND period_to IS NULL/);
  assert.match(source, /run\.status !== 'READY'/);
  assert.match(source, /rebuildCertification\(client, \{ scopeKey, persist: false, sourceStateKey \}\)/);
  assert.match(source, /snapshotIdentity: 'unbounded certification snapshot; query period is an additional filter'/);
  assert.match(certification, /sourceStateKey: providedSourceStateKey = null/);
  assert.match(certification, /CERTIFICATION_SOURCE_STATE_OVERRIDE/);
  assert.match(certification, /\(persist \|\| replace\) && providedSourceStateKey !== null/);
  assert.match(certification, /providedSourceStateKey \?\? await sourceState\(pool, scope\.id\)/);
  assert.doesNotMatch(source, /ORDER BY id DESC LIMIT 1/);
  assert.doesNotMatch(source, /INSERT INTO|UPDATE\s+|DELETE FROM|TRUNCATE\s+/i);
  assert.doesNotMatch(source, /Number\([^)]*(amount|gross|return|spend|currency)/i);
  assert.match(source, /event_at >= \$4::timestamptz/);
  assert.match(source, /event_at < \$5::timestamptz/);
  assert.deepEqual(CURRENT_SPENDING_SNAPSHOT_FAILURES, {
    NO_CURRENT_CERTIFICATION: 'NO_CURRENT_CERTIFICATION',
    STALE_SNAPSHOT: 'STALE_SNAPSHOT',
    CORRUPT_SNAPSHOT: 'CORRUPT_SNAPSHOT',
    CERTIFICATION_CONFLICT: 'CERTIFICATION_CONFLICT',
  });
  assert.equal(CURRENT_SPENDING_SNAPSHOT_MODEL, 'canonical-spending-current-snapshot-v1');
});

test('snapshot logging contains only safe summary fields', () => {
  const events = [];
  logCurrentSpendingSnapshot({
    ok: true,
    status: 'READY',
    reasonCode: null,
    snapshot: { runId: 7, sourceStateKey: 'a'.repeat(64), currency: 'RUB', currencies: ['RUB'] },
  }, { scopeKey: 'default' }, { info: (event, fields) => events.push({ event, fields }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'canonical_spending_current_snapshot_read_completed');
  assert.deepEqual(Object.keys(events[0].fields).sort(), [
    'currencies', 'currency', 'reasonCode', 'runId', 'scopeKey', 'sourceStateKey', 'status',
  ].sort());
  assert.equal(events[0].fields.sourceStateKey, 'a'.repeat(64));
});

import assert from 'node:assert/strict';
import { createPool, ReceiptRepository } from '../src/database.js';

const pool = createPool({ connectionString: process.env.RESTRICTED_DATABASE_URL, max: 20 });
const repo = new ReceiptRepository(pool);
const sourceA = Number(process.env.LOCK_SOURCE_A ?? 3);
const sourceB = Number(process.env.LOCK_SOURCE_B ?? 4);
const sourceC = Number(process.env.LOCK_SOURCE_C ?? 5);
const raw = (key, suffix) => ({
  key, dateTime: '2026-09-08T12:00:00Z', totalSum: 100, user: 'Clone merchant', userInn: '7700000000', operationType: 1,
  fiscalDriveNumber: `lock-fd-${suffix}`, fiscalDocumentNumber: `lock-doc-${suffix}`, fiscalSign: `lock-sign-${suffix}`,
  items: [{ name: 'Clone item', quantity: 1, price: 100, sum: 100 }],
});
const normalize = (value) => ({ id: value.key, dateTime: value.dateTime, seller: value.user, sellerInn: value.userInn, totalSum: value.totalSum, currency: 'RUB', operationType: value.operationType, items: value.items.map((item) => ({ ...item })) });
const observe = (sourceId, sourceReceiptId, key, suffix) => repo.upsertObservedBundle({ sourceId, sourceReceiptId, normalized: normalize(raw(key, suffix)), raw: raw(key, suffix) });

try {
  const access = (await pool.query(`SELECT has_table_privilege(current_user, 'public.receipt_source_observations', 'SELECT') AS can_select, has_table_privilege(current_user, 'public.receipt_source_observations', 'INSERT') AS can_insert, has_table_privilege(current_user, 'public.receipt_source_observations', 'UPDATE') AS can_update, has_table_privilege(current_user, 'public.receipt_source_observations', 'DELETE') AS can_delete`)).rows[0];
  assert.deepEqual(access, { can_select: true, can_insert: true, can_update: false, can_delete: false });

  const first = await observe(sourceA, 'same-ref', '__locktest_a_20260908', 'a');
  const second = await observe(sourceA, 'same-ref', '__locktest_a_20260908', 'a');
  assert.equal(first.observationCreated, true);
  assert.equal(second.observationCreated, false);
  const concurrentSame = await Promise.all(Array.from({ length: 20 }, () => observe(sourceA, 'same-ref', '__locktest_a_20260908', 'a')));
  assert.equal(concurrentSame.filter((row) => row.observationCreated).length, 0);

  await observe(sourceA, 'conflict-ref', '__locktest_b_20260908', 'b');
  await assert.rejects(() => observe(sourceA, 'conflict-ref', '__locktest_a_20260908', 'a'), { code: 'FNS_SOURCE_OBSERVATION_CONFLICT' });
  await assert.rejects(() => observe(sourceA, 'conflict-ref', '__locktest_new_20260908', 'new'), { code: 'FNS_SOURCE_OBSERVATION_CONFLICT' });
  const concurrentConflict = await Promise.allSettled(Array.from({ length: 20 }, () => observe(sourceA, 'conflict-ref', '__locktest_c_20260908', 'c')));
  assert.equal(concurrentConflict.filter((result) => result.status === 'rejected' && result.reason.code === 'FNS_SOURCE_OBSERVATION_CONFLICT').length, 20);

  const differentSources = await Promise.all([observe(sourceB, 'same-canonical-b', '__locktest_a_20260908', 'a'), observe(sourceC, 'same-canonical-c', '__locktest_a_20260908', 'a')]);
  assert.equal(differentSources.length, 2);
  const unrelated = await Promise.all(Array.from({ length: 20 }, (_, index) => observe(sourceB, `unrelated-${index}`, '__locktest_b_20260908', 'b')));
  assert.equal(unrelated.length, 20);

  const counts = (await pool.query('SELECT count(*) FILTER (WHERE fns_source_id=$1)::int AS source_a, count(*) FILTER (WHERE fns_source_id = ANY($2::bigint[]))::int AS source_bc, count(DISTINCT receipt_id) FILTER (WHERE fns_source_id = ANY($2::bigint[]))::int AS receipts FROM receipt_source_observations', [sourceA, [sourceB, sourceC]])).rows[0];
  console.log(JSON.stringify({ pass: true, acl: access, sequential_idempotency: 'PASS', concurrent_same_reference: 'PASS', sequential_conflict: 'PASS', concurrent_conflict: 'PASS', different_sources_same_receipt: 'PASS', unrelated_concurrency: 'PASS', counts }));
} finally {
  await pool.end();
}

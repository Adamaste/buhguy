import assert from 'node:assert/strict';
import { createPool, ReceiptRepository } from '../src/database.js';

const dbName = process.env.CLONE_DB ?? 'finance_receipt_collector_multiuser_clone_20260908';
const admin = createPool({ host: '/var/run/postgresql', database: dbName, user: 'postgres', max: 20 });
const roleName = `observation_lock_test_${process.pid}`;
const rolePool = {
  async connect() {
    const client = await admin.connect();
    await client.query(`SET ROLE ${roleName}`);
    return client;
  },
  query(...args) { return admin.query(...args); },
};

const raw = (key, suffix) => ({
  key, dateTime: '2026-09-08T12:00:00Z', totalSum: 100, user: 'Clone merchant', userInn: '7700000000', operationType: 1,
  fiscalDriveNumber: `lock-fd-${suffix}`, fiscalDocumentNumber: `lock-doc-${suffix}`, fiscalSign: `lock-sign-${suffix}`,
  items: [{ name: 'Clone item', quantity: 1, price: 100, sum: 100 }],
});
const normalize = (value) => ({ id: value.key, dateTime: value.dateTime, seller: value.user, sellerInn: value.userInn, totalSum: value.totalSum, currency: 'RUB', operationType: value.operationType, items: value.items.map((item) => ({ ...item })) });
const bundle = (value) => ({ normalized: normalize(value), raw: value });
const repo = new ReceiptRepository(rolePool);

let sources = [];
let receipts = [];
try {
  await admin.query(`CREATE ROLE ${roleName} NOLOGIN`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE ON public.receipts, public.receipt_items, public.receipt_raw TO ${roleName}`);
  await admin.query(`GRANT USAGE, SELECT ON SEQUENCE public.receipts_id_seq, public.receipt_items_id_seq TO ${roleName}`);
  await admin.query(`GRANT SELECT, INSERT ON public.receipt_source_observations TO ${roleName}`);
  await admin.query(`GRANT USAGE, SELECT ON SEQUENCE public.receipt_source_observations_id_seq TO ${roleName}`);

  const access = (await admin.query(`SELECT has_table_privilege('${roleName}', 'public.receipt_source_observations', 'SELECT') AS can_select, has_table_privilege('${roleName}', 'public.receipt_source_observations', 'INSERT') AS can_insert, has_table_privilege('${roleName}', 'public.receipt_source_observations', 'UPDATE') AS can_update, has_table_privilege('${roleName}', 'public.receipt_source_observations', 'DELETE') AS can_delete`)).rows[0];
  assert.deepEqual(access, { can_select: true, can_insert: true, can_update: false, can_delete: false });

  const scope = (await admin.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
  for (const key of ['lock-a', 'lock-b', 'lock-c']) {
    const row = (await admin.query('INSERT INTO fns_sources(scope_id,source_key,session_ref) VALUES($1,$2,$3) RETURNING id', [scope.id, `${key}-${process.pid}`, `test:${key}`])).rows[0];
    sources.push(row.id);
  }
  for (const value of [raw('lock-a-receipt', 'a'), raw('lock-b-receipt', 'b'), raw('lock-c-receipt', 'c')]) {
    const saved = await new ReceiptRepository(admin).upsertBundle(bundle(value));
    receipts.push(saved.id);
  }

  const same = () => repo.upsertObservedBundle({ sourceId: sources[0], sourceReceiptId: 'same-ref', normalized: normalize(raw('lock-a-receipt', 'a')), raw: raw('lock-a-receipt', 'a') });
  const first = await same();
  const second = await same();
  assert.equal(first.observationCreated, true);
  assert.equal(second.observationCreated, false);
  const concurrentSame = await Promise.all(Array.from({ length: 20 }, same));
  assert.equal(concurrentSame.filter((row) => row.observationCreated).length, 0);

  const conflicting = (key, suffix) => repo.upsertObservedBundle({ sourceId: sources[0], sourceReceiptId: 'conflict-ref', normalized: normalize(raw(key, suffix)), raw: raw(key, suffix) });
  await conflicting('lock-a-receipt', 'a');
  await assert.rejects(() => conflicting('lock-b-receipt', 'b'), { code: 'FNS_SOURCE_OBSERVATION_CONFLICT' });
  await assert.rejects(() => conflicting('lock-new-receipt', 'new'), { code: 'FNS_SOURCE_OBSERVATION_CONFLICT' });
  const concurrentConflict = await Promise.allSettled(Array.from({ length: 20 }, () => conflicting('lock-c-receipt', 'c')));
  assert.equal(concurrentConflict.filter((result) => result.status === 'rejected' && result.reason.code === 'FNS_SOURCE_OBSERVATION_CONFLICT').length, 20);

  const differentSources = await Promise.all([
    repo.upsertObservedBundle({ sourceId: sources[1], sourceReceiptId: 'same-canonical-b', normalized: normalize(raw('lock-a-receipt', 'a')), raw: raw('lock-a-receipt', 'a') }),
    repo.upsertObservedBundle({ sourceId: sources[2], sourceReceiptId: 'same-canonical-c', normalized: normalize(raw('lock-a-receipt', 'a')), raw: raw('lock-a-receipt', 'a') }),
  ]);
  assert.equal(differentSources.length, 2);
  const unrelated = await Promise.all(Array.from({ length: 20 }, (_, index) => repo.upsertObservedBundle({ sourceId: sources[1], sourceReceiptId: `unrelated-${index}`, normalized: normalize(raw('lock-b-receipt', 'b')), raw: raw('lock-b-receipt', 'b') })));
  assert.equal(unrelated.length, 20);

  const counts = (await admin.query('SELECT (SELECT count(*) FROM receipt_source_observations WHERE fns_source_id=ANY($1::bigint[]))::int AS observations, (SELECT count(*) FROM receipts WHERE id=ANY($2::bigint[]))::int AS receipts', [sources, receipts])).rows[0];
  console.log(JSON.stringify({ pass: true, acl: access, sequential_idempotency: 'PASS', concurrent_same_reference: 'PASS', sequential_conflict: 'PASS', concurrent_conflict: 'PASS', different_sources_same_receipt: 'PASS', unrelated_concurrency: 'PASS', counts }));
} finally {
  await admin.query('DELETE FROM receipt_source_observations WHERE fns_source_id=ANY($1::bigint[])', [sources]).catch(() => {});
  await admin.query('DELETE FROM receipt_items WHERE receipt_id=ANY($1::bigint[])', [receipts]).catch(() => {});
  await admin.query('DELETE FROM receipt_raw WHERE receipt_id=ANY($1::bigint[])', [receipts]).catch(() => {});
  await admin.query('DELETE FROM receipts WHERE id=ANY($1::bigint[])', [receipts]).catch(() => {});
  await admin.query('DELETE FROM fns_sources WHERE id=ANY($1::bigint[])', [sources]).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {});
  await admin.end();
}

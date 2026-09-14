import assert from 'node:assert/strict';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { syncReceipts } from '../src/sync.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for the disposable clone');

const pool = createPool({ connectionString, max: 8 });
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const repository = new ReceiptRepository(pool);
  const source = await repository.ensureSource({ sourceKey: 'clone-source-2', sessionRef: 'filesystem:clone/source-2.json', personKey: 'clone-person-2' });
  const unavailable = new Set(Array.from({ length: 141 }, (_, index) => `unavailable-${index}`));
  const ids = Array.from({ length: 518 }, (_, index) => unavailable.has(`unavailable-${index}`) ? `unavailable-${index}` : `resolved-${index}`);
  let detailCalls = 0;
  const client = {
    async listReceipts() { return { hasMore: false, receipts: ids.map((id) => ({ id })) }; },
    async getReceiptRaw(id) {
      detailCalls += 1;
      if (unavailable.has(id)) throw Object.assign(new Error('synthetic detail unavailable'), { status: 422, code: 'CLONE_DETAIL_UNAVAILABLE' });
      const index = Number(id.split('-')[1]);
      return { key: id, dateTime: '2026-01-01T00:00:00Z', user: 'Clone seller', userInn: '7700000000', totalSum: 10, operationType: 1, fiscalDriveNumber: `fd-${id}`, fiscalDocumentNumber: `doc-${id}`, fiscalSign: `sign-${id}`, items: [{ name: 'Clone item', quantity: 1, price: 10, sum: 10 }], index };
    },
  };
  const first = await syncReceipts({ client, repository, sourceContext: { sourceId: source.id }, detailErrorClassifier: (error) => error.status === 422 && error.code === 'CLONE_DETAIL_UNAVAILABLE', logger: { info() {}, warn() {}, error() {} } });
  assert.equal(first.fetched, 518);
  assert.equal(first.resolved, 377);
  assert.equal(first.detailUnavailable, 141);
  assert.equal(first.errors, 0);
  assert.equal((await pool.query('SELECT count(*) FROM receipts')).rows[0].count, '377');
  assert.equal((await pool.query('SELECT count(*) FROM receipt_source_observations')).rows[0].count, '377');
  const callsAfterFirst = detailCalls;
  const second = await syncReceipts({ client, repository, sourceContext: { sourceId: source.id }, detailErrorClassifier: (error) => error.status === 422 && error.code === 'CLONE_DETAIL_UNAVAILABLE', logger: { info() {}, warn() {}, error() {} } });
  assert.equal(second.fetched, 518);
  assert.equal(second.resolved, 377);
  assert.equal(second.retryPending, 141);
  assert.equal(second.errors, 0);
  assert.equal(detailCalls, callsAfterFirst);
  console.log(JSON.stringify({ first: { fetched: first.fetched, resolved: first.resolved, detailUnavailable: first.detailUnavailable, errors: first.errors }, second: { fetched: second.fetched, resolved: second.resolved, retryPending: second.retryPending, errors: second.errors }, receipts: 377, observations: 377, detailCalls: callsAfterFirst }));
} finally {
  await pool.end();
}

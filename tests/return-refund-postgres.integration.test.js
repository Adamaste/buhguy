import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { backfillNormalization } from '../src/fiscal-normalization.js';
import { BusinessEventGraphRepository, GRAPH_MODEL_VERSION, MANUAL, validateBusinessEventGraph } from '../src/business-event-graph.js';
import { dryRunPrepaymentSettlements, persistPrepaymentSettlementMatches } from '../src/prepayment-settlement-matcher.js';
import { dryRunReturnRefundMatches, persistReturnRefundMatches, rebuildReturnRefundMatches } from '../src/return-refund-matcher.js';
import { assertDisposableLocalTestDatabase } from '../scripts/assert-disposable-local-test-database.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString) assertDisposableLocalTestDatabase(connectionString);
if (!connectionString) {
  test('RETURN_REFUND_V1 PostgreSQL integration environment is required', { skip: 'TEST_DATABASE_URL is not set' }, () => {});
} else {
  let pool;
  const raw = (key, overrides = {}) => ({
    key, dateTime: '2026-08-19T10:00:00Z', totalSum: 100, user: 'Sanitized seller', userInn: '7700000000', operationType: 1,
    fiscalDriveNumber: `drive-${key}`, fiscalDocumentNumber: `doc-${key}`, fiscalSign: `sign-${key}`, fiscalDocumentFormatVer: '4',
    cashTotalSum: 100, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0,
    items: [{ name: 'Sanitized Widget', quantity: 1, price: 100, sum: 100, paymentType: 4, productType: 4, providerInn: '7700000000' }], ...overrides,
  });
  const bundle = (value) => ({ normalized: { id: value.key, dateTime: value.dateTime, seller: value.user, sellerInn: value.userInn, totalSum: value.totalSum, currency: 'RUB', operationType: value.operationType, cashTotalSum: value.cashTotalSum, ecashTotalSum: value.ecashTotalSum, prepaidSum: value.prepaidSum, creditSum: value.creditSum, provisionSum: value.provisionSum, items: value.items.map((item) => ({ ...item, itemSum: item.sum })) }, raw: value });
  async function reset() { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(pool); }
  async function seed(values) { const repo = new ReceiptRepository(pool); for (const value of values) await repo.upsertBundle(bundle(value)); await backfillNormalization(pool); }
  before(async () => { pool = createPool({ connectionString, max: 10 }); await reset(); });
  after(async () => { await pool.end(); });

  test('exact full return persists RETURN edge and is idempotent', async () => {
    await reset();
    await seed([raw('sale', { dateTime: '2026-08-19T10:00:00Z' }), raw('return', { dateTime: '2026-08-20T10:00:00Z', operationType: 2 })]);
    const dry = await dryRunReturnRefundMatches(pool);
    assert.equal(dry.summary.confirmed, 1);
    const first = await persistReturnRefundMatches(pool, { result: dry });
    assert.deepEqual(first.created, { purchases: 1, returns: 1, refunds: 0, evidenceLinks: 2, edges: 1, allocations: 1 });
    const second = await persistReturnRefundMatches(pool);
    assert.deepEqual(second.created, { purchases: 0, returns: 0, refunds: 0, evidenceLinks: 0, edges: 0, allocations: 0 });
    assert.equal((await pool.query("SELECT count(*) FROM business_event_edges WHERE relation_type='RETURNS' AND resolution_status='CONFIRMED'")).rows[0].count, '1');
    assert.equal((await validateBusinessEventGraph(pool)).ok, true);
  });

  test('ambiguous return does not mutate graph', async () => {
    await reset();
    await seed([raw('sale-a'), raw('sale-b', { dateTime: '2026-08-19T11:00:00Z' }), raw('return', { dateTime: '2026-08-20T10:00:00Z', operationType: 2 })]);
    const dry = await dryRunReturnRefundMatches(pool);
    assert.equal(dry.summary.ambiguous, 1);
    const result = await persistReturnRefundMatches(pool, { result: dry });
    assert.equal(result.created.returns, 0);
    assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '0');
  });

  test('rollback removes partial RETURN graph writes', async () => {
    await reset();
    await seed([raw('sale'), raw('return', { dateTime: '2026-08-20T10:00:00Z', operationType: 2 })]);
    const dry = await dryRunReturnRefundMatches(pool);
    await assert.rejects(() => persistReturnRefundMatches(pool, { result: dry, failAfter: 'return' }), /injected return matcher failure/);
    assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '0');
    assert.equal((await pool.query('SELECT count(*) FROM business_event_edges')).rows[0].count, '0');
  });

  test('concurrent runs, rebuild and manual preservation are safe', async () => {
    await reset();
    await seed([raw('sale'), raw('return', { dateTime: '2026-08-20T10:00:00Z', operationType: 2 })]);
    const dry = await dryRunReturnRefundMatches(pool);
    const [first, second] = await Promise.all([persistReturnRefundMatches(pool, { result: dry }), persistReturnRefundMatches(pool, { result: dry })]);
    assert.equal(first.created.returns + second.created.returns, 1);
    const graph = new BusinessEventGraphRepository(pool);
    await graph.createEvent({ scopeKey: 'default', eventType: 'PAYMENT', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_TEST', ruleVersion: 'v1', semanticKey: 'manual-payment', amount: '1.00', currency: 'RUB' });
    const rebuilt = await rebuildReturnRefundMatches(pool);
    assert.equal(rebuilt.created.returns, 1);
    assert.equal((await pool.query("SELECT count(*) FROM business_events WHERE origin='MANUAL'")).rows[0].count, '1');
    assert.equal((await validateBusinessEventGraph(pool)).ok, true);
  });

  test('return before sale converges after later sale evidence', async () => {
    await reset();
    await seed([raw('return', { dateTime: '2026-08-20T10:00:00Z', operationType: 2 })]);
    assert.equal((await dryRunReturnRefundMatches(pool)).summary.confirmed, 0);
    await seed([raw('sale', { dateTime: '2026-08-19T10:00:00Z' })]);
    assert.equal((await dryRunReturnRefundMatches(pool)).summary.confirmed, 1);
  });

  test('prepayment settlement return targets existing PURCHASE lifecycle', async () => {
    await reset();
    const pre = raw('pre', { dateTime: '2026-08-19T10:00:00Z', cashTotalSum: 0, ecashTotalSum: 100, prepaidSum: 0, items: [{ name: 'Sanitized Widget', quantity: 1, price: 100, sum: 100, paymentType: 1, productType: 4, providerInn: '7700000000' }] });
    const settlement = raw('settle', { dateTime: '2026-08-20T10:00:00Z', cashTotalSum: 0, ecashTotalSum: 0, prepaidSum: 100, items: [{ name: 'Sanitized Widget', quantity: 1, price: 100, sum: 100, paymentType: 4, productType: 4, providerInn: '7700000000' }] });
    const ret = raw('return', { dateTime: '2026-08-21T10:00:00Z', operationType: 2 });
    await seed([pre, settlement, ret]);
    await persistPrepaymentSettlementMatches(pool);
    const before = Number((await pool.query("SELECT count(*) FROM business_events WHERE event_type='PURCHASE'")).rows[0].count);
    const result = await persistReturnRefundMatches(pool);
    assert.equal(result.created.purchases, 0);
    assert.equal(Number((await pool.query("SELECT count(*) FROM business_events WHERE event_type='PURCHASE'")).rows[0].count), before);
    assert.equal((await validateBusinessEventGraph(pool)).ok, true);
  });
}

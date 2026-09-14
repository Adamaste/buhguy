import { createPool } from '../src/database.js';
import { BusinessEventGraphRepository, MANUAL, GRAPH_MODEL_VERSION, validateBusinessEventGraph } from '../src/business-event-graph.js';
import { persistPrepaymentSettlementMatches, PREPAYMENT_SETTLEMENT_RULE, MATCHER_VERSION } from '../src/prepayment-settlement-matcher.js';

const pool = createPool({ connectionString: process.env.TEST_DATABASE_URL, max: 30 });
const counts = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM receipts) receipts,
  (SELECT count(*)::int FROM receipt_items) receipt_items,
  (SELECT count(*)::int FROM receipt_raw) receipt_raw,
  (SELECT count(*)::int FROM receipt_fiscal_facts) receipt_fiscal_facts,
  (SELECT count(*)::int FROM receipt_item_fiscal_facts) receipt_item_fiscal_facts,
  (SELECT count(*)::int FROM business_events) business_events,
  (SELECT count(*)::int FROM business_event_evidence) evidence_links,
  (SELECT count(*)::int FROM business_event_edges) edges,
  (SELECT count(*)::int FROM business_event_allocations) allocations`)).rows[0];

try {
  const before = await counts();
  const writeOptions = { pairKeys: ['62:54'] };
  const first = await persistPrepaymentSettlementMatches(pool, writeOptions);
  const afterFirst = await counts();
  const validator = await validateBusinessEventGraph(pool);
  const ambiguous = new Set(first.settlements.filter((row) => row.status === 'AMBIGUOUS').map((row) => Number(row.settlementReceiptId)));
  const confirmed = new Set(first.confirmedPairs.map((row) => Number(row.settlementReceiptId)));
  const overlap = [...ambiguous].filter((id) => confirmed.has(id));
  const second = await persistPrepaymentSettlementMatches(pool, writeOptions);
  const afterSecond = await counts();
  const graph = new BusinessEventGraphRepository(pool);
  const manual = await graph.createEvent({ scopeKey: 'default', eventType: 'PURCHASE', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_TEST', ruleVersion: 'v1', semanticKey: 'manual-preserved', amount: 1, currency: 'RUB' });
  const rebuild = await graph.rebuildSystemDerived({ scopeKey: 'default', graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: PREPAYMENT_SETTLEMENT_RULE, ruleVersion: MATCHER_VERSION });
  const manualAfterRebuild = await graph.inspectEvent(manual.id);
  const afterRebuild = await persistPrepaymentSettlementMatches(pool, writeOptions);
  const afterRerun = await counts();
  const beforeRollback = await counts();
  let rollbackError = null;
  try { await persistPrepaymentSettlementMatches(pool, { ...writeOptions, scopeKey: 'rollback-scope', failAfter: 'evidence' }); } catch (error) { rollbackError = error.message; }
  const afterRollback = await counts();
  const concurrent = await Promise.all(Array.from({ length: 25 }, () => persistPrepaymentSettlementMatches(pool, { ...writeOptions, result: first })));
  const afterConcurrent = await counts();
  const xiaomi = first.confirmedPairs.find((row) => Number(row.prepaymentReceiptId) === 62 && Number(row.settlementReceiptId) === 54) ?? null;
  console.log(JSON.stringify({
    before,
    first: { summary: first.summary, created: first.created, confirmedPairs: first.confirmedPairs.length, xiaomi: xiaomi ? { prepaymentReceiptId: xiaomi.prepaymentReceiptId, settlementReceiptId: xiaomi.settlementReceiptId, purchaseValue: xiaomi.purchaseValue } : null, ambiguousConfirmedOverlap: overlap.length },
    afterFirst, validator, secondCreated: second.created, afterSecond,
    manualPreserved: Boolean(manualAfterRebuild), rebuild, afterRebuildCreated: afterRebuild.created, afterRerun,
    rollback: { error: rollbackError, unchanged: JSON.stringify(beforeRollback) === JSON.stringify(afterRollback), after: afterRollback },
    concurrent: { workers: concurrent.length, createdPurchases: concurrent.reduce((total, row) => total + row.created.purchases, 0), unchanged: JSON.stringify(afterRerun) === JSON.stringify(afterConcurrent), after: afterConcurrent },
  }, null, 2));
} finally {
  await pool.end();
}

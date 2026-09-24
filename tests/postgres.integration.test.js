import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { backfillNormalization, normalizeAndStoreReceipt, rebuildNormalization } from '../src/fiscal-normalization.js';
import { FiscalContentConflictError, FiscalIdentityConflictError } from '../src/fiscal-errors.js';
import { syncReceipts } from '../src/sync.js';
import { BusinessEventGraphRepository, EXTERNAL_CONFIRMED, GRAPH_MODEL_VERSION, MANUAL, SYSTEM_DERIVED, validateBusinessEventGraph } from '../src/business-event-graph.js';
import { dryRunPrepaymentSettlements, persistPrepaymentSettlementMatches, reconsiderPrepaymentSettlement } from '../src/prepayment-settlement-matcher.js';
import { fiscalContentFingerprint } from '../src/fiscal-evidence.js';
import { decodePostgresJsonEvidence } from '../src/postgres-json-evidence.js';
import { decodePostgresTextEvidence } from '../src/postgres-text-evidence.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  test('PostgreSQL integration environment is required', { skip: 'TEST_DATABASE_URL is not set; use npm run test:integration' }, () => {});
} else {
  let pool;

  const rawFixture = (id, suffix = id, overrides = {}) => ({
    key: id, dateTime: '2026-08-19T12:00:00Z', totalSum: 32380, user: 'Sanitized Xiaomi Merchant', userInn: '7700000000', operationType: 1,
    fiscalDriveNumber: `fd-${suffix}`, fiscalDocumentNumber: `doc-${suffix}`, fiscalSign: `sign-${suffix}`,
    items: [{ name: 'Xiaomi + insurance (sanitized)', quantity: 1, price: 32380, sum: 32380 }], ...overrides,
  });
  const normalized = (raw) => ({ id: raw.key, dateTime: raw.dateTime, seller: raw.user, sellerInn: raw.userInn, totalSum: raw.totalSum, currency: 'RUB', operationType: raw.operationType, cashTotalSum: raw.cashTotalSum, ecashTotalSum: raw.ecashTotalSum, prepaidSum: raw.prepaidSum, creditSum: raw.creditSum, provisionSum: raw.provisionSum, items: raw.items.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price, sum: item.sum, paymentType: item.paymentType, productType: item.productType, providerInn: item.providerInn })) });
  const bundle = (raw) => ({ normalized: normalized(raw), raw });

  async function reset() {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  }

  async function counts() {
    const result = await pool.query('SELECT (SELECT count(*) FROM receipts) receipts, (SELECT count(*) FROM receipt_items) items, (SELECT count(*) FROM receipt_raw) raw');
    return result.rows[0];
  }

  before(async () => { pool = createPool({ connectionString, max: 10 }); await reset(); });
  after(async () => { await pool.end(); });

  test('fresh migration creates schema and canonical index', async () => {
    await reset();
    const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='receipts_canonical_fiscal_identity_unique'");
    assert.equal(index.rowCount, 1);
    assert.match(index.rows[0].indexdef, /UNIQUE INDEX/);
    assert.match(index.rows[0].indexdef, /fiscal_drive_number/);
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('receipt_fiscal_facts','receipt_item_fiscal_facts','normalization_issues') ORDER BY tablename");
    assert.deepEqual(tables.rows.map((row) => row.tablename), ['normalization_issues', 'receipt_fiscal_facts', 'receipt_item_fiscal_facts']);
    const graphTables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('accounting_scopes','business_event_types','business_event_relations','business_graph_rules','business_graph_runs','business_events','business_event_evidence','business_event_edges','business_event_allocations') ORDER BY tablename");
    assert.deepEqual(graphTables.rows.map((row) => row.tablename), ['accounting_scopes', 'business_event_allocations', 'business_event_edges', 'business_event_evidence', 'business_event_relations', 'business_event_types', 'business_events', 'business_graph_rules', 'business_graph_runs']);
    assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '0');
  });

  async function seedGraphEvidence() {
    const repo = new ReceiptRepository(pool);
    const first = rawFixture('graph-receipt-a', 'graph-a', { fiscalDocumentFormatVer: '4', cashTotalSum: 32380, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Sanitized item', quantity: 3, price: 1000, sum: 3000, paymentType: 4, productType: 4, providerInn: '7700000000' }] });
    const second = rawFixture('graph-receipt-b', 'graph-b', { fiscalDocumentFormatVer: '4', totalSum: 32380, cashTotalSum: 0, ecashTotalSum: 0, prepaidSum: 32380, creditSum: 0, provisionSum: 0, items: [{ name: 'Sanitized item', quantity: 1, price: 32380, sum: 32380, paymentType: 4, productType: 4, providerInn: '7700000000' }] });
    const savedA = await repo.upsertBundle(bundle(first));
    const savedB = await repo.upsertBundle(bundle(second));
    await backfillNormalization(pool);
    const item = await pool.query('SELECT id FROM receipt_items WHERE receipt_id=$1 ORDER BY position LIMIT 1', [savedA.id]);
    return { savedA, savedB, itemA: item.rows[0].id };
  }

  test('graph events, many-to-many evidence, edges and allocations are idempotent', async () => {
    await reset();
    const { savedA, savedB, itemA } = await seedGraphEvidence();
    const graph = new BusinessEventGraphRepository(pool);
    const purchase = await graph.createEvent({ scopeKey: 'household-a', eventType: 'PURCHASE', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1', semanticKey: 'purchase-x', amount: 32380, currency: 'RUB' });
    const replay = await graph.createEvent({ scopeKey: 'household-a', eventType: 'PURCHASE', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1', semanticKey: 'purchase-x', amount: 32380, currency: 'RUB' });
    assert.equal(purchase.created, true);
    assert.equal(replay.created, false);
    const evidenceA = await graph.createEvidenceLink({ eventId: purchase.id, receiptId: savedA.id, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'PURCHASE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1' });
    const evidenceB = await graph.createEvidenceLink({ eventId: purchase.id, receiptId: savedB.id, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'FULFILLMENT_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1' });
    await graph.createEvidenceLink({ eventId: purchase.id, receiptItemId: itemA, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'PURCHASE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1' });
    assert.notEqual(evidenceA.id, evidenceB.id);
    const prepayment = await graph.createEvent({ scopeKey: 'household-a', eventType: 'PREPAYMENT', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1', semanticKey: 'prepayment-x', amount: 32380, currency: 'RUB' });
    const edge = await graph.createEdge({ scopeKey: 'household-a', sourceEventId: prepayment.id, targetEventId: purchase.id, relationType: 'PREPAYMENT_FOR', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1' });
    const edgeReplay = await graph.createEdge({ scopeKey: 'household-a', sourceEventId: prepayment.id, targetEventId: purchase.id, relationType: 'PREPAYMENT_FOR', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1' });
    assert.equal(edge.created, true);
    assert.equal(edgeReplay.created, false);
    const allocation = await graph.createAllocation({ scopeKey: 'household-a', targetEventId: purchase.id, sourceReceiptItemId: itemA, normalizationVersion: 'fiscal-normalizer-v1', allocatedQuantity: 1, allocatedAmount: 1000, currency: 'RUB', allocationRole: 'PURCHASE_COMPONENT', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_GRAPH', ruleVersion: 'v1' });
    assert.equal(allocation.created, true);
    const inspected = await graph.inspectEvent(purchase.id);
    assert.equal(inspected.evidence.length, 3);
    assert.equal(inspected.edges.length, 1);
    assert.equal(inspected.allocations.length, 1);
  });

  test('Xiaomi golden graph is explicit, distinct and rebuildable without auto-matching', async () => {
    await reset();
    const { savedA, savedB } = await seedGraphEvidence();
    const graph = new BusinessEventGraphRepository(pool);
    const purchase = await graph.createEvent({ scopeKey: 'household-a', eventType: 'PURCHASE', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1', semanticKey: 'xiaomi-purchase', amount: 32380, currency: 'RUB' });
    const prepayment = await graph.createEvent({ scopeKey: 'household-a', eventType: 'PREPAYMENT', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1', semanticKey: 'xiaomi-prepayment', amount: 32380, currency: 'RUB' });
    const fulfillment = await graph.createEvent({ scopeKey: 'household-a', eventType: 'FULFILLMENT', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1', semanticKey: 'xiaomi-fulfillment', amount: 32380, currency: 'RUB' });
    await graph.createEvidenceLink({ eventId: prepayment.id, receiptId: savedA.id, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'PREPAYMENT_EVIDENCE', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1' });
    await graph.createEvidenceLink({ eventId: fulfillment.id, receiptId: savedB.id, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'FULFILLMENT_EVIDENCE', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1' });
    await graph.createEdge({ scopeKey: 'household-a', sourceEventId: prepayment.id, targetEventId: purchase.id, relationType: 'PREPAYMENT_FOR', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1' });
    await graph.createEdge({ scopeKey: 'household-a', sourceEventId: fulfillment.id, targetEventId: purchase.id, relationType: 'FULFILLS', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1' });
    assert.equal((await pool.query('SELECT count(*) FROM receipts')).rows[0].count, '2');
    assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '3');
    assert.equal((await graph.createEvent({ scopeKey: 'household-a', eventType: 'PURCHASE', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1', semanticKey: 'xiaomi-purchase', amount: 32380, currency: 'RUB' })).created, false);
  });

  test('ambiguity, identical-looking purchases, partial return and scope isolation are representable', async () => {
    await reset();
    const { savedA, itemA } = await seedGraphEvidence();
    const graph = new BusinessEventGraphRepository(pool);
    const makePurchase = (scopeKey, semanticKey) => graph.createEvent({ scopeKey, eventType: 'PURCHASE', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1', semanticKey, amount: 1000, currency: 'RUB', description: 'same seller and same item, distinct fiscal document' });
    const [purchaseA, purchaseB] = await Promise.all([makePurchase('scope-a', 'purchase-a'), makePurchase('scope-a', 'purchase-b')]);
    assert.notEqual(purchaseA.id, purchaseB.id);
    const returnEvent = await graph.createEvent({ scopeKey: 'scope-a', eventType: 'RETURN', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1', semanticKey: 'return-r', amount: 1000, currency: 'RUB' });
    await graph.createEdge({ scopeKey: 'scope-a', sourceEventId: returnEvent.id, targetEventId: purchaseA.id, relationType: 'RETURNS', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1' });
    await graph.createEdge({ scopeKey: 'scope-a', sourceEventId: returnEvent.id, targetEventId: purchaseB.id, relationType: 'RETURNS', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1' });
    const refund = await graph.createEvent({ scopeKey: 'scope-a', eventType: 'REFUND', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1', semanticKey: 'refund-f', amount: 1000, currency: 'RUB' });
    await graph.createEdge({ scopeKey: 'scope-a', sourceEventId: refund.id, targetEventId: returnEvent.id, relationType: 'REFUNDS', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1' });
    await graph.createAllocation({ scopeKey: 'scope-a', targetEventId: returnEvent.id, sourceReceiptItemId: itemA, normalizationVersion: 'fiscal-normalizer-v1', allocatedQuantity: 1, allocatedAmount: 1000, currency: 'RUB', allocationRole: 'RETURN_COMPONENT', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1' });
    const advance = await graph.createEvent({ scopeKey: 'scope-a', eventType: 'ADVANCE', resolutionStatus: 'AMBIGUOUS', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1', semanticKey: 'advance-with-unknown-service', amount: 1000, currency: 'RUB', description: 'Service identity unresolved; evidence retained without invented service id' });
    await graph.createEvidenceLink({ eventId: advance.id, receiptItemId: itemA, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'ADVANCE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1' });
    const scopeB = await makePurchase('scope-b', 'purchase-b');
    await assert.rejects(() => graph.createEdge({ scopeKey: 'scope-a', sourceEventId: scopeB.id, targetEventId: purchaseA.id, relationType: 'PAYMENT_FOR', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'FIXTURE_RULE', ruleVersion: 'v1' }), /Cross-scope/);
    const edgeStatuses = await pool.query("SELECT count(*) FROM business_event_edges WHERE resolution_status='CANDIDATE'");
    assert.equal(edgeStatuses.rows[0].count, '3');
    assert.equal((await pool.query("SELECT count(*) FROM business_events WHERE event_type IN ('RETURN','REFUND')")).rows[0].count, '2');
    assert.equal((await pool.query('SELECT count(*) FROM receipts WHERE id=$1', [savedA.id])).rows[0].count, '1');
  });

  test('graph transaction rollback, concurrency, cross-version and rebuild preserve manual assertions', async () => {
    await reset();
    const { savedA } = await seedGraphEvidence();
    const graph = new BusinessEventGraphRepository(pool);
    await assert.rejects(() => graph.withTransaction(async (tx) => { const event = await tx.createEvent({ scopeKey: 'scope-a', eventType: 'PAYMENT', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'TX_RULE', ruleVersion: 'v1', semanticKey: 'rollback-event', amount: 1, currency: 'RUB' }); await tx.createEvidenceLink({ eventId: event.id, receiptId: savedA.id, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'PAYMENT_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'TX_RULE', ruleVersion: 'v1' }); throw new Error('injected graph failure'); }), /injected graph failure/);
    assert.equal((await pool.query("SELECT count(*) FROM business_events WHERE semantic_key=$1", [await import('../src/fiscal-evidence.js').then(({ fiscalContentFingerprint }) => fiscalContentFingerprint({ providedSemanticKey: 'rollback-event', kind: 'event', scopeKey: 'scope-a', eventType: 'PAYMENT', graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'TX_RULE', ruleVersion: 'v1', origin: SYSTEM_DERIVED, resolutionStatus: 'CANDIDATE' }))])).rows[0].count, '0');
    const same = { scopeKey: 'scope-a', eventType: 'PAYMENT', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'RACE_RULE', ruleVersion: 'v1', semanticKey: 'same-race', amount: 1, currency: 'RUB' };
    const races = await Promise.all(Array.from({ length: 20 }, () => graph.createEvent(same)));
    assert.equal(races.filter((row) => row.created).length, 1);
    const v1 = await graph.createEvent({ ...same, semanticKey: 'cross-version', ruleCode: 'VERSION_RULE', ruleVersion: 'v1' });
    const v2 = await graph.createEvent({ ...same, semanticKey: 'cross-version', ruleCode: 'VERSION_RULE', ruleVersion: 'v2' });
    assert.notEqual(v1.id, v2.id);
    const manual = await graph.createEvent({ scopeKey: 'scope-a', eventType: 'PURCHASE', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'MANUAL_ASSERTION', ruleVersion: 'v1', semanticKey: 'keep-manual', amount: 1, currency: 'RUB' });
    const derived = await graph.createEvent({ scopeKey: 'scope-a', eventType: 'PURCHASE', resolutionStatus: 'CANDIDATE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'REBUILD_RULE', ruleVersion: 'v1', semanticKey: 'remove-derived', amount: 1, currency: 'RUB' });
    await graph.createEvidenceLink({ eventId: derived.id, receiptId: savedA.id, normalizationVersion: 'fiscal-normalizer-v1', evidenceRole: 'PURCHASE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'REBUILD_RULE', ruleVersion: 'v1' });
    const rebuild = await graph.rebuildSystemDerived({ scopeKey: 'scope-a', graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'REBUILD_RULE', ruleVersion: 'v1' });
    assert.equal(rebuild.deletedEvents, 1);
    assert.ok(await graph.inspectEvent(manual.id));
    assert.equal(await graph.inspectEvent(derived.id), null);
  });

  test('graph validator is clean and detects confirmed over-allocation while ignoring candidate overlap', async () => {
    await reset();
    const { itemA } = await seedGraphEvidence();
    const graph = new BusinessEventGraphRepository(pool);
    const event = await graph.createEvent({ scopeKey: 'scope-a', eventType: 'PURCHASE', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'VALIDATOR_RULE', ruleVersion: 'v1', semanticKey: 'validator-target', amount: 1, currency: 'RUB' });
    const clean = await validateBusinessEventGraph(pool);
    assert.equal(clean.ok, true);
    await graph.createAllocation({ scopeKey: 'scope-a', targetEventId: event.id, sourceReceiptItemId: itemA, normalizationVersion: 'fiscal-normalizer-v1', allocatedQuantity: 1, allocatedAmount: 3001, currency: 'RUB', allocationRole: 'CONFIRMED_COMPONENT', resolutionStatus: 'CONFIRMED', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: 'VALIDATOR_RULE', ruleVersion: 'v1' });
    const result = await validateBusinessEventGraph(pool);
    assert.equal(result.ok, false);
    assert.equal(Number(result.checks.confirmed_item_overallocation), 1);
  });

  test('PREPAYMENT_SETTLEMENT_V1 runs against disposable normalized PostgreSQL facts without writes', async () => {
    await reset();
    const prepayment = rawFixture('matcher-prepayment', 'matcher-prepayment', { fiscalDocumentFormatVer: '4', dateTime: '2026-08-19T10:00:00Z', totalSum: 32380, cashTotalSum: 0, ecashTotalSum: 32380, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Xiaomi phone + insurance', quantity: 1, price: 32380, sum: 32380, paymentType: 1, productType: 1, providerInn: '7700000000' }] });
    const settlement = rawFixture('matcher-settlement', 'matcher-settlement', { fiscalDocumentFormatVer: '4', dateTime: '2026-08-22T10:00:00Z', totalSum: 32380, cashTotalSum: 0, ecashTotalSum: 0, prepaidSum: 32380, creditSum: 0, provisionSum: 0, items: [{ name: 'Xiaomi phone + insurance', quantity: 1, price: 32380, sum: 32380, paymentType: 4, productType: 1, providerInn: '7700000000' }] });
    const repo = new ReceiptRepository(pool);
    await repo.upsertBundle(bundle(prepayment));
    await repo.upsertBundle(bundle(settlement));
    await backfillNormalization(pool);
    const before = await counts();
    const first = await dryRunPrepaymentSettlements(pool);
    assert.equal(first.summary.settlementsExamined, 1);
    assert.equal(first.summary.strictMatches, 1);
    assert.equal(first.candidates[0].prepaymentFnsId, 'matcher-prepayment');
    assert.equal(first.candidates[0].settlementFnsId, 'matcher-settlement');
    assert.equal(first.candidates[0].purchaseValue, '32380.00');
    assert.equal(first.candidates[0].predicates.every((item) => item.matched), true);
    const [second, concurrent] = await Promise.all([dryRunPrepaymentSettlements(pool), dryRunPrepaymentSettlements(pool)]);
    assert.deepEqual(second, first);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(await counts(), before);
    assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '0');
  });

  test('PREPAYMENT_SETTLEMENT_V1 writes one idempotent lifecycle and rolls back atomically', async () => {
    await reset();
    const repo = new ReceiptRepository(pool);
    const prepayment = rawFixture('writer-prepayment', 'writer-prepayment', { fiscalDocumentFormatVer: '4', dateTime: '2026-08-19T10:00:00Z', totalSum: 32380, cashTotalSum: 0, ecashTotalSum: 32380, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Xiaomi phone + insurance', quantity: 1, price: 32380, sum: 32380, paymentType: 1, productType: 1, providerInn: '7700000000' }] });
    const settlement = rawFixture('writer-settlement', 'writer-settlement', { fiscalDocumentFormatVer: '4', dateTime: '2026-08-22T10:00:00Z', totalSum: 32380, cashTotalSum: 0, ecashTotalSum: 0, prepaidSum: 32380, creditSum: 0, provisionSum: 0, items: [{ name: 'Xiaomi phone + insurance', quantity: 1, price: 32380, sum: 32380, paymentType: 4, productType: 1, providerInn: '7700000000' }] });
    await repo.upsertBundle(bundle(prepayment));
    await repo.upsertBundle(bundle(settlement));
    await backfillNormalization(pool);
    const first = await persistPrepaymentSettlementMatches(pool);
    assert.equal(first.created.purchases, 1);
    assert.equal(first.created.lifecycleEvents, 2);
    assert.equal(first.created.evidenceLinks, 2);
    assert.equal(first.created.edges, 2);
    assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '3');
    assert.equal((await persistPrepaymentSettlementMatches(pool)).created.purchases, 0);
    assert.deepEqual((await pool.query('SELECT event_type,resolution_status,origin FROM business_events ORDER BY event_type')).rows, [
      { event_type: 'FULFILLMENT', resolution_status: 'CONFIRMED', origin: 'SYSTEM_DERIVED' },
      { event_type: 'PREPAYMENT', resolution_status: 'CONFIRMED', origin: 'SYSTEM_DERIVED' },
      { event_type: 'PURCHASE', resolution_status: 'CONFIRMED', origin: 'SYSTEM_DERIVED' },
    ]);
    await assert.rejects(() => persistPrepaymentSettlementMatches(pool, { failAfter: 'evidence' }), /injected matcher failure/);
    assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '3');
    assert.equal((await pool.query('SELECT count(*) FROM business_event_evidence')).rows[0].count, '2');
  });

  test('PREPAYMENT_SETTLEMENT_V1 incremental flow supports prepayment-first and settlement-first order', async () => {
    await reset();
    const repo = new ReceiptRepository(pool);
    const prepayment = rawFixture('incremental-prepayment', 'incremental-prepayment', { fiscalDocumentFormatVer: '4', dateTime: '2026-08-19T10:00:00Z', totalSum: 32380, cashTotalSum: 0, ecashTotalSum: 32380, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Xiaomi phone + insurance', quantity: 1, price: 32380, sum: 32380, paymentType: 1, productType: 1, providerInn: '7700000000' }] });
    const settlement = rawFixture('incremental-settlement', 'incremental-settlement', { fiscalDocumentFormatVer: '4', dateTime: '2026-08-22T10:00:00Z', totalSum: 32380, cashTotalSum: 0, ecashTotalSum: 0, prepaidSum: 32380, creditSum: 0, provisionSum: 0, items: [{ name: 'Xiaomi phone + insurance', quantity: 1, price: 32380, sum: 32380, paymentType: 4, productType: 1, providerInn: '7700000000' }] });
    const savedPrepayment = await repo.upsertBundle(bundle(prepayment));
    await backfillNormalization(pool);
    const first = await reconsiderPrepaymentSettlement(pool, savedPrepayment.id, { persist: true });
    assert.equal(first.triggerStatus, 'RECONSIDERED');
    assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '0');
    const savedSettlement = await repo.upsertBundle(bundle(settlement));
    await backfillNormalization(pool);
    const second = await reconsiderPrepaymentSettlement(pool, savedSettlement.id, { persist: true });
    assert.equal(second.triggerStatus, 'CONFIRMED');
    assert.equal(second.created.purchases, 1);
    assert.equal((await pool.query("SELECT count(*) FROM business_events WHERE event_type='PURCHASE'")).rows[0].count, '1');
    const reverse = await reset();
    void reverse;
    const reverseSettlement = await repo.upsertBundle(bundle({ ...settlement, key: 'incremental-settlement-first' }));
    await backfillNormalization(pool);
    await reconsiderPrepaymentSettlement(pool, reverseSettlement.id, { persist: true });
    const reversePrepayment = await repo.upsertBundle(bundle({ ...prepayment, key: 'incremental-prepayment-later' }));
    await backfillNormalization(pool);
    const reverseResult = await reconsiderPrepaymentSettlement(pool, reversePrepayment.id, { persist: true });
    assert.equal(reverseResult.created.purchases, 1);
    assert.equal((await pool.query("SELECT count(*) FROM business_events WHERE event_type='PURCHASE'")).rows[0].count, '1');
  });

  test('normalization backfill and rebuild are idempotent and preserve source', async () => {
    await reset();
    const payload = rawFixture('norm-a', 'norm-a', { fiscalDocumentFormatVer: '4', cashTotalSum: 32380, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Item', quantity: 1, price: 32380, sum: 32380, paymentType: 4, productType: 4, providerInn: '7700000000', productCodeNew: { code: { gtin: '00000000000000', rawProductCode: 'raw' } } }] });
    const repo = new ReceiptRepository(pool);
    const saved = await repo.upsertBundle(bundle(payload));
    const sourceBefore = await pool.query('SELECT payload FROM receipt_raw WHERE receipt_id=$1', [saved.id]);
    const first = await backfillNormalization(pool);
    assert.equal(first.ready, 1);
    const stored = await pool.query('SELECT normalization_status,payment_stage,source_content_sha256 FROM receipt_fiscal_facts WHERE receipt_id=$1', [saved.id]);
    assert.deepEqual(stored.rows[0], { normalization_status: 'READY', payment_stage: 'SETTLEMENT_ONLY', source_content_sha256: stored.rows[0].source_content_sha256 });
    const second = await backfillNormalization(pool);
    assert.equal(second.normalized, 1);
    const rebuilt = await rebuildNormalization(pool);
    assert.equal(rebuilt.ready, 1);
    const sourceAfter = await pool.query('SELECT payload FROM receipt_raw WHERE receipt_id=$1', [saved.id]);
    assert.deepEqual(sourceAfter.rows[0].payload, sourceBefore.rows[0].payload);
    const facts = await pool.query('SELECT count(*) AS facts FROM receipt_fiscal_facts; SELECT count(*) AS items FROM receipt_item_fiscal_facts; SELECT count(*) AS issues FROM normalization_issues');
    assert.equal(facts[0].rows[0].facts, '1');
    assert.equal(facts[1].rows[0].items, '1');
    assert.equal(facts[2].rows[0].issues, '0');
  });

  test('PostgreSQL-safe raw product code normalization is reversible and idempotent', async () => {
    await reset();
    const raw = rawFixture('text-unicode-normalization', 'text-unicode-normalization', {
      fiscalDocumentFormatVer: '4',
      cashTotalSum: 32380,
      ecashTotalSum: 0,
      prepaidSum: 0,
      creditSum: 0,
      provisionSum: 0,
      items: [{
        name: 'NUL product code',
        quantity: 1,
        price: 32380,
        sum: 32380,
        paymentType: 4,
        productType: 4,
        productCodeNew: { code: { rawProductCode: 'A\u0000B' } },
      }],
    });
    const repo = new ReceiptRepository(pool);
    const saved = await repo.upsertBundle(bundle(raw));

    const first = await normalizeAndStoreReceipt(pool, saved.id);
    assert.equal(first.facts.normalizationStatus, 'READY');
    const firstStored = await pool.query('SELECT raw_product_code, normalized_content_sha256 FROM receipt_item_fiscal_facts WHERE receipt_item_id=(SELECT id FROM receipt_items WHERE receipt_id=$1)', [saved.id]);
    assert.equal(firstStored.rowCount, 1);
    assert.notEqual(firstStored.rows[0].raw_product_code, 'A\u0000B');
    assert.equal(decodePostgresTextEvidence(firstStored.rows[0].raw_product_code), 'A\u0000B');
    assert.equal(first.facts.normalizedContentSha256, fiscalContentFingerprint(first.semantic));

    const second = await normalizeAndStoreReceipt(pool, saved.id);
    const secondStored = await pool.query('SELECT raw_product_code, normalized_content_sha256 FROM receipt_item_fiscal_facts WHERE receipt_item_id=(SELECT id FROM receipt_items WHERE receipt_id=$1)', [saved.id]);
    assert.deepEqual(secondStored.rows[0], firstStored.rows[0]);
    assert.equal(second.facts.normalizedContentSha256, first.facts.normalizedContentSha256);
  });

  test('normalizer failure preserves committed source evidence and is reported', async () => {
    await reset();
    const raw = rawFixture('normalizer-failure', 'normalizer-failure');
    const result = await syncReceipts({
      client: {
        async listReceipts() { return { receipts: [{ id: raw.key }], hasMore: false }; },
        async getReceiptRaw() { return raw; },
      },
      repository: new ReceiptRepository(pool),
      normalizer: async () => { throw new Error('injected normalizer failure'); },
      logger: { info() {}, error() {} },
    });
    assert.equal(result.inserted, 1);
    assert.equal(result.errors, 0);
    assert.equal(result.normalization_failed_count, 1);
    assert.deepEqual(await counts(), { receipts: '1', items: '1', raw: '1' });
    const source = await pool.query("SELECT payload->>'key' AS key FROM receipt_raw WHERE receipt_id=(SELECT id FROM receipts WHERE fns_id=$1)", [raw.key]);
    assert.equal(source.rows[0].key, raw.key);
  });

  test('unsupported and mismatched poison receipts do not starve later normalization', async () => {
    await reset();
    const receipts = [
      rawFixture('poison-unsupported', 'poison-unsupported', { fiscalDocumentFormatVer: '99', cashTotalSum: 32380, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Item', quantity: 1, price: 32380, sum: 32380, paymentType: 4 }] }),
      rawFixture('healthy-b', 'healthy-b', { fiscalDocumentFormatVer: '4', cashTotalSum: 32380, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Item', quantity: 1, price: 32380, sum: 32380, paymentType: 4 }] }),
      rawFixture('poison-mismatch', 'poison-mismatch', { fiscalDocumentFormatVer: '4', cashTotalSum: 1, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Item', quantity: 1, price: 32380, sum: 32380, paymentType: 4 }] }),
    ];
    const result = await syncReceipts({
      client: { async listReceipts() { return { receipts: receipts.map((item) => ({ id: item.key })), hasMore: false }; }, async getReceiptRaw(id) { return receipts.find((item) => item.key === id); } },
      repository: new ReceiptRepository(pool),
      normalizer: (receiptId) => normalizeAndStoreReceipt(pool, receiptId),
      logger: { info() {}, error() {} },
    });
    assert.equal(result.source_ingest_success_count, 3);
    assert.equal(result.normalization_ready_count, 1);
    assert.equal(result.normalization_blocked_count, 1);
    assert.equal(result.normalization_unsupported_count, 1);
    assert.equal(result.normalization_failed_count, 0);
    const statuses = await pool.query('SELECT r.fns_id, f.normalization_status, count(i.id)::int AS issues FROM receipts r JOIN receipt_fiscal_facts f ON f.receipt_id=r.id LEFT JOIN normalization_issues i ON i.receipt_id=r.id GROUP BY r.fns_id,f.normalization_status ORDER BY r.fns_id');
    assert.deepEqual(statuses.rows, [
      { fns_id: 'healthy-b', normalization_status: 'READY', issues: 0 },
      { fns_id: 'poison-mismatch', normalization_status: 'BLOCKED', issues: 1 },
      { fns_id: 'poison-unsupported', normalization_status: 'UNSUPPORTED', issues: 1 },
    ]);
  });

  test('restart can ingest next receipt while prior normalization remains retryable', async () => {
    await reset();
    const poison = rawFixture('restart-poison', 'restart-poison', { fiscalDocumentFormatVer: '99' });
    const first = await syncReceipts({
      client: { async listReceipts() { return { receipts: [{ id: poison.key }], hasMore: false }; }, async getReceiptRaw() { return poison; } },
      repository: new ReceiptRepository(pool),
      normalizer: (receiptId) => normalizeAndStoreReceipt(pool, receiptId),
      logger: { info() {}, error() {} },
    });
    assert.equal(first.source_ingest_success_count, 1);
    assert.equal(first.normalization_unsupported_count, 1);
    const next = rawFixture('restart-next', 'restart-next', { fiscalDocumentFormatVer: '4', cashTotalSum: 32380, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [{ name: 'Item', quantity: 1, price: 32380, sum: 32380, paymentType: 4 }] });
    const second = await syncReceipts({
      client: { async listReceipts() { return { receipts: [{ id: next.key }], hasMore: false }; }, async getReceiptRaw() { return next; } },
      repository: new ReceiptRepository(pool),
      normalizer: (receiptId) => normalizeAndStoreReceipt(pool, receiptId),
      logger: { info() {}, error() {} },
    });
    assert.equal(second.source_ingest_success_count, 1);
    assert.equal(second.normalization_ready_count, 1);
    const countsAfterRestart = await counts();
    assert.deepEqual(countsAfterRestart, { receipts: '2', items: '2', raw: '2' });
  });

  test('upgrade 002 to 003 preserves valid receipt/items/raw counts', async () => {
    await reset();
    const before = await counts();
    const repo = new ReceiptRepository(pool);
    await repo.upsertBundle(bundle(rawFixture('upgrade-a')));
    const afterInsert = await counts();
    assert.equal(Number(afterInsert.receipts), Number(before.receipts) + 1);
    assert.equal(Number(afterInsert.items), 1);
    assert.equal(Number(afterInsert.raw), 1);
    const index = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname='receipts_canonical_fiscal_identity_unique'");
    assert.equal(index.rowCount, 1);
  });

  test('dirty duplicate canonical identity migration fails without deleting rows', async () => {
    await reset();
    await pool.query('DROP INDEX receipts_canonical_fiscal_identity_unique');
    await pool.query("DELETE FROM schema_migrations WHERE filename='003_fiscal_identity_hardening.sql'");
    await pool.query("INSERT INTO receipts(fns_id,fiscal_drive_number,fiscal_document_number,fiscal_sign) VALUES ('dirty-a','same-fd','same-doc','same-sign'), ('dirty-b','same-fd','same-doc','same-sign')");
    await assert.rejects(() => migrate(pool), /duplicate fiscal identities exist/);
    const rows = await pool.query("SELECT count(*) FROM receipts WHERE fns_id IN ('dirty-a','dirty-b')");
    assert.equal(Number(rows.rows[0].count), 2);
    const index = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname='receipts_canonical_fiscal_identity_unique'");
    assert.equal(index.rowCount, 0);
  });

  test('database enforces source and canonical uniqueness, but permits null and distinct tuples', async () => {
    await reset();
    await pool.query("INSERT INTO receipts(fns_id,fiscal_drive_number,fiscal_document_number,fiscal_sign) VALUES ('u-a','u-fd','u-doc','u-sign')");
    await assert.rejects(() => pool.query("INSERT INTO receipts(fns_id,fiscal_drive_number,fiscal_document_number,fiscal_sign) VALUES ('u-a','other-fd','other-doc','other-sign')"), /duplicate key/);
    await assert.rejects(() => pool.query("INSERT INTO receipts(fns_id,fiscal_drive_number,fiscal_document_number,fiscal_sign) VALUES ('u-b','u-fd','u-doc','u-sign')"), /duplicate key/);
    await pool.query("INSERT INTO receipts(fns_id) VALUES ('u-null-a'), ('u-null-b')");
    await pool.query("INSERT INTO receipts(fns_id,fiscal_drive_number,fiscal_document_number,fiscal_sign) VALUES ('u-c','other-fd','other-doc','other-sign')");
  });

  test('same-document concurrent ingest is idempotent for 50 races', async () => {
    await reset();
    for (let i = 0; i < 50; i += 1) {
      const raw = rawFixture(`race-${i}`, `race-${i}`);
      const [a, b] = await Promise.all([new ReceiptRepository(pool).upsertBundle(bundle(raw)), new ReceiptRepository(pool).upsertBundle(bundle(raw))]);
      assert.equal([a.created, b.created].filter(Boolean).length, 1);
    }
    assert.deepEqual(await counts(), { receipts: '50', items: '50', raw: '50' });
  });

  test('concurrent distinct documents remain distinct', async () => {
    await reset();
    await Promise.all([new ReceiptRepository(pool).upsertBundle(bundle(rawFixture('distinct-a', 'distinct-a'))), new ReceiptRepository(pool).upsertBundle(bundle(rawFixture('distinct-b', 'distinct-b')))]);
    assert.deepEqual(await counts(), { receipts: '2', items: '2', raw: '2' });
  });

  test('identity conflict fails closed without changing existing rows', async () => {
    await reset();
    const repo = new ReceiptRepository(pool);
    await repo.upsertBundle(bundle(rawFixture('conflict-a', 't1')));
    await repo.upsertBundle(bundle(rawFixture('conflict-b', 't2')));
    await assert.rejects(() => repo.upsertBundle(bundle(rawFixture('conflict-a', 't2'))), { code: 'FISCAL_IDENTITY_CONFLICT' });
    assert.deepEqual(await counts(), { receipts: '2', items: '2', raw: '2' });
  });

  test('content conflict preserves original evidence', async () => {
    await reset();
    const repo = new ReceiptRepository(pool);
    const original = rawFixture('content-a', 'content-a');
    await repo.upsertBundle(bundle(original));
    await assert.rejects(() => repo.upsertBundle(bundle({ ...original, totalSum: 1 })), { code: 'FISCAL_CONTENT_CONFLICT' });
    const result = await pool.query("SELECT total_sum, payload->>'totalSum' AS raw_total FROM receipts r JOIN receipt_raw x ON x.receipt_id=r.id WHERE fns_id='content-a'");
    assert.equal(result.rows[0].total_sum, '32380.00');
    assert.equal(result.rows[0].raw_total, '32380');
  });

  test('raw JSON evidence with PostgreSQL-incompatible Unicode is persisted reversibly', async () => {
    await reset();
    const repo = new ReceiptRepository(pool);
    const raw = rawFixture('unicode-jsonb-a', 'unicode-jsonb-a', {
      fiscalDocumentFormatVer: '4',
      items: [{
        name: 'Sanitized item',
        quantity: 1,
        price: 32380,
        sum: 32380,
        paymentType: 4,
        productType: 4,
        productCodeNew: { code: { rawProductCode: 'A\u0000B' } },
      }],
    });
    const literal = rawFixture('unicode-jsonb-literal', 'unicode-jsonb-literal', {
      fiscalDocumentFormatVer: '4',
      items: [{
        name: 'Literal escape text',
        quantity: 1,
        price: 32380,
        sum: 32380,
        paymentType: 4,
        productType: 4,
        productCodeNew: { code: { rawProductCode: 'A\\u0000B' } },
      }],
    });

    const source = await repo.ensureSource({
      sourceKey: 'unicode-jsonb-source',
      sessionRef: 'test:unicode-jsonb-source',
      displayName: 'Unicode JSONB fixture',
    });
    const saved = await repo.upsertObservedBundle({ sourceId: source.id, sourceReceiptId: 'unicode-jsonb-a-source', ...bundle(raw) });
    assert.equal(saved.created, true);
    assert.equal(saved.observationCreated, true);
    assert.deepEqual(await counts(), { receipts: '1', items: '1', raw: '1' });

    const replay = await repo.upsertObservedBundle({ sourceId: source.id, sourceReceiptId: 'unicode-jsonb-a-source', ...bundle(raw) });
    assert.equal(replay.created, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(await counts(), { receipts: '1', items: '1', raw: '1' });

    const stored = await pool.query('SELECT payload FROM receipt_raw WHERE receipt_id=$1', [saved.id]);
    assert.equal(stored.rows[0].payload.items[0].productCodeNew.code.rawProductCode.__receiptCollectorEncodedStringV1, true);
    const decodedStored = decodePostgresJsonEvidence(stored.rows[0].payload);
    assert.equal(decodedStored.items[0].productCodeNew.code.rawProductCode, 'A\u0000B');
    const itemRaw = await pool.query('SELECT raw FROM receipt_items WHERE receipt_id=$1 AND position=0', [saved.id]);
    assert.equal(decodePostgresJsonEvidence(itemRaw.rows[0].raw).productCodeNew.code.rawProductCode, 'A\u0000B');

    const direct = await repo.upsertBundle(bundle(literal));
    assert.equal(direct.created, true);
    const literalStored = await pool.query('SELECT payload FROM receipt_raw WHERE receipt_id=$1', [direct.id]);
    assert.equal(literalStored.rows[0].payload.items[0].productCodeNew.code.rawProductCode, 'A\\u0000B');
    assert.notEqual(fiscalContentFingerprint(raw), fiscalContentFingerprint(literal));
    assert.equal(fiscalContentFingerprint(decodedStored), fiscalContentFingerprint(raw));
  });

  test('sync continues after PostgreSQL-incompatible Unicode raw evidence', async () => {
    await reset();
    const repo = new ReceiptRepository(pool);
    const source = await repo.ensureSource({
      sourceKey: 'unicode-jsonb-sync-source',
      sessionRef: 'test:unicode-jsonb-sync-source',
      displayName: 'Unicode JSONB sync fixture',
    });
    const bad = rawFixture('unicode-sync-bad', 'unicode-sync-bad', {
      fiscalDocumentFormatVer: '4',
      items: [{
        name: 'Sanitized item',
        quantity: 1,
        price: 32380,
        sum: 32380,
        paymentType: 4,
        productType: 4,
        productCodeNew: { code: { rawProductCode: 'A\u0000B' } },
      }],
    });
    const healthy = rawFixture('unicode-sync-healthy', 'unicode-sync-healthy', {
      fiscalDocumentFormatVer: '4',
      items: [{ name: 'Healthy item', quantity: 1, price: 32380, sum: 32380, paymentType: 4, productType: 4 }],
    });
    const receipts = [bad, healthy];

    const result = await syncReceipts({
      client: {
        async listReceipts() { return { receipts: receipts.map((item) => ({ id: item.key })), hasMore: false }; },
        async getReceiptRaw(id) { return receipts.find((item) => item.key === id); },
      },
      repository: repo,
      sourceContext: { sourceId: source.id },
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.fetched, 2);
    assert.equal(result.inserted, 2);
    assert.equal(result.errors, 0);
    assert.equal(result.resolved, 2);
    assert.equal(result.unclassified, 0);
    assert.deepEqual(await counts(), { receipts: '2', items: '2', raw: '2' });
  });

  test('transient metadata replay is harmless and Xiaomi two-document regression stays two', async () => {
    await reset();
    const repo = new ReceiptRepository(pool);
    const prepayment = rawFixture('xiaomi-62', 'xiaomi-t1', { requestNumber: 'one' });
    const settlement = rawFixture('xiaomi-54', 'xiaomi-t2', { dateTime: '2026-08-22T12:00:00Z', requestNumber: 'two' });
    await repo.upsertBundle(bundle(prepayment));
    await repo.upsertBundle(bundle(settlement));
    const replay = await repo.upsertBundle(bundle({ ...prepayment, requestNumber: 'three', receivedAt: 'later' }));
    assert.equal(replay.replayed, true);
    assert.deepEqual(await counts(), { receipts: '2', items: '2', raw: '2' });
  });

  test('faults after receipt, items and raw all roll back', async () => {
    for (const stage of ['after_receipt_insert', 'after_items', 'after_raw']) {
      await reset();
      const raw = rawFixture(`rollback-${stage}`, `rollback-${stage}`);
      const repo = new ReceiptRepository(pool, { faultInjector: async (actual) => { if (actual === stage) throw new Error(`injected ${stage}`); } });
      await assert.rejects(() => repo.upsertBundle(bundle(raw)), new RegExp(`injected ${stage}`));
      assert.deepEqual(await counts(), { receipts: '0', items: '0', raw: '0' });
    }
  });
}

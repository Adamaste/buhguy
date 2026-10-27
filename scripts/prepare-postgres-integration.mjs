import fs from 'node:fs/promises';
import pg from 'pg';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { backfillNormalization } from '../src/fiscal-normalization.js';
import { BusinessEventGraphRepository, GRAPH_MODEL_VERSION, SYSTEM_DERIVED } from '../src/business-event-graph.js';
import { rebuildLedger } from '../src/ledger.js';
import { rebuildCertification } from '../src/certification.js';
import { STANDALONE_PURCHASE_VERSION } from '../src/standalone-purchase.js';
import { assertDisposableLocalTestDatabase } from './assert-disposable-local-test-database.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required');
const databaseName = assertDisposableLocalTestDatabase(connectionString);

const pool = createPool({ connectionString, max: 10 });
const raw = {
  key: 'synthetic-integration-receipt',
  dateTime: '2026-08-19T12:00:00Z',
  totalSum: 32380,
  user: 'Synthetic Merchant',
  userInn: '7700000000',
  operationType: 1,
  fiscalDriveNumber: 'synthetic-drive',
  fiscalDocumentNumber: 'synthetic-document',
  fiscalSign: 'synthetic-sign',
  fiscalDocumentFormatVer: '4',
  cashTotalSum: 0,
  ecashTotalSum: 32380,
  prepaidSum: 0,
  creditSum: 0,
  provisionSum: 0,
  items: [{ name: 'Synthetic Widget', quantity: 1, price: 32380, sum: 32380, paymentType: 4, productType: 4, providerInn: '7700000000' }],
};

try {
  const runtimeRole = await pool.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='receipt_collector'");
  if (!runtimeRole.rowCount) await pool.query('CREATE ROLE receipt_collector NOLOGIN');
  else if (runtimeRole.rows[0].rolcanlogin) throw new Error('Disposable test role receipt_collector unexpectedly allows login');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query('GRANT USAGE ON SCHEMA public TO receipt_collector');
  await migrate(pool);
  for (const file of ['db/analytics/008_analytics_v1.sql', 'db/analytics/009_purchase_details_v1.sql']) {
    await pool.query(await fs.readFile(file, 'utf8'));
  }
  const normalized = {
    id: raw.key,
    dateTime: raw.dateTime,
    seller: raw.user,
    sellerInn: raw.userInn,
    totalSum: raw.totalSum,
    currency: 'RUB',
    operationType: raw.operationType,
    cashTotalSum: raw.cashTotalSum,
    ecashTotalSum: raw.ecashTotalSum,
    prepaidSum: raw.prepaidSum,
    creditSum: raw.creditSum,
    provisionSum: raw.provisionSum,
    items: raw.items.map((item) => ({ ...item, providerInn: item.providerInn })),
  };
  const receipt = await new ReceiptRepository(pool).upsertBundle({ normalized, raw });
  await backfillNormalization(pool);
  const graph = new BusinessEventGraphRepository(pool);
  const event = await graph.createEvent({
    scopeKey: 'default',
    eventType: 'PURCHASE',
    resolutionStatus: 'CONFIRMED',
    origin: SYSTEM_DERIVED,
    graphModelVersion: GRAPH_MODEL_VERSION,
    ruleCode: 'STANDALONE_PURCHASE_V1',
    ruleVersion: STANDALONE_PURCHASE_VERSION,
    semanticKey: 'synthetic-integration-purchase',
    amount: 32380,
    currency: 'RUB',
  });
  await graph.createEvidenceLink({
    eventId: event.id,
    receiptId: receipt.id,
    normalizationVersion: 'fiscal-normalizer-v1',
    evidenceRole: 'PURCHASE_EVIDENCE',
    origin: SYSTEM_DERIVED,
    graphModelVersion: GRAPH_MODEL_VERSION,
    ruleCode: 'STANDALONE_PURCHASE_V1',
    ruleVersion: STANDALONE_PURCHASE_VERSION,
  });
  await rebuildLedger(pool, { eventIds: [event.id] });
  await rebuildCertification(pool, { persist: true, replace: true });
  const counts = (await pool.query(`SELECT
    (SELECT count(*) FROM receipts) AS receipts,
    (SELECT count(*) FROM receipt_items) AS items,
    (SELECT count(*) FROM ledger_entries) AS ledger_entries,
    (SELECT count(*) FROM certification_facts) AS certification_facts`)).rows[0];
  if (Number(counts.receipts) !== 1 || Number(counts.items) !== 1 || Number(counts.ledger_entries) < 1 || Number(counts.certification_facts) < 1) throw new Error('Synthetic integration fixture was not created completely');
  console.log(`POSTGRES_FIXTURE_READY=${databaseName}`);
} finally {
  await pool.end();
}

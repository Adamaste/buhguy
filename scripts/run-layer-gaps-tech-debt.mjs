import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appRoot = process.env.APP_ROOT ?? process.cwd();
const load = (file) => import(pathToFileURL(path.join(appRoot, 'src', file)).href);
const coverageRoot = process.env.COVERAGE_ROOT ?? appRoot;
const loadCoverage = (file) => import(pathToFileURL(path.join(coverageRoot, 'src', file)).href);
const { createPool } = await load('database.js');
const { accountingCoverageReport, loadCoverageRows } = await loadCoverage('accounting-coverage.js');
const { validateBusinessEventGraph } = await load('business-event-graph.js');
const { rebuildLedger } = await load('ledger.js');
const { certificationReport } = await load('certification.js');

const ids = [72, 83, 335];
const outputDir = process.env.OUTPUT_DIR ?? 'artifacts/layer-gaps-tech-debt';
const pool = process.env.DB_NAME
  ? createPool({ host: process.env.PGHOST ?? '/var/run/postgresql', user: process.env.PGUSER ?? 'postgres', database: process.env.DB_NAME })
  : createPool();

async function main() {
  const report = await accountingCoverageReport(pool, { scopeKey: 'default' });
  const rows = await loadCoverageRows(pool, { scopeKey: 'default' });
  const selected = rows.filter((row) => ids.includes(Number(row.id)));
  const graph = await validateBusinessEventGraph(pool);
  const ledger = await rebuildLedger(pool, { scopeKey: 'default', dryRun: true });
  const certification = await certificationReport(pool, { scopeKey: 'default' });
  const counts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM receipt_items) AS receipt_items,
    (SELECT count(*)::int FROM receipt_raw) AS receipt_raw,
    (SELECT count(*)::int FROM receipt_fiscal_facts) AS receipt_fiscal_facts,
    (SELECT count(*)::int FROM business_events) AS business_events,
    (SELECT count(*)::int FROM ledger_entries) AS ledger_entries,
    (SELECT count(*)::int FROM certification_facts) AS certification_facts,
    (SELECT count(*)::int FROM analytics_purchases) AS analytics_purchases`)).rows[0];
  const details = selected.map((row) => ({
    receiptId: Number(row.id), dateTime: row.dateTime, operationType: row.operationType === null ? null : Number(row.operationType),
    totalSum: row.totalSum, normalizationStatus: row.normalizationStatus, fiscalOperationType: row.fiscalOperationType,
    paymentStage: row.paymentStage, paymentComponentsStatus: row.paymentComponentsStatus,
    events: row.related.events.map((event) => ({ eventId: Number(event.eventId), eventType: event.eventType, resolutionStatus: event.resolutionStatus, ruleCode: event.ruleCode, ruleVersion: event.ruleVersion, ledgerEntryId: event.ledgerEntryId === null ? null : Number(event.ledgerEntryId), derivationStatus: event.derivationStatus, ledgerReason: event.ledgerReason })),
    certificationFacts: row.related.certificationFacts.map((fact) => ({ businessEventId: Number(fact.businessEventId), metricCode: fact.metricCode, status: fact.status, reasonCode: fact.reasonCode })),
  }));
  const result = { model: 'layer-gaps-tech-debt-v1', ids, counts, coverage: { totals: report.totals, gate: report.gate, layerChecks: report.layerChecks, receiptOutcomes: report.receiptOutcomes.filter((row) => ids.includes(Number(row.receiptId))) }, details, graphValidator: graph, ledgerDryRun: ledger, certification: { metrics: certification.metrics, results: certification.results.filter((row) => ['BLOCKED_EXPOSURE', 'CONFIRMED_ACQUISITION_VALUE', 'CONFIRMED_RETURN_VALUE'].includes(row.metricCode)) } };
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}/forensic.json`, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try { await main(); } finally { await pool.end(); }

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const coverageModule = await import(process.env.COVERAGE_MODULE_PATH ?? '../src/accounting-coverage.js');
const { buildCoverageReport, compareCoverageReports, loadCoverageRows } = coverageModule;

const pgModule = process.env.PG_MODULE_PATH ? await import(process.env.PG_MODULE_PATH) : await import('pg');
const { Pool } = pgModule.default ?? pgModule;
const databaseUrl = process.env.COVERAGE_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql:///finance_receipt_collector_purchase_details_clone_20260907T173158Z';
const outputDir = process.env.COVERAGE_OUTPUT_DIR;
const august = { from: '2026-08-01T00:00:00+03:00', to: '2026-09-01T00:00:00+03:00' };

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const snapshotEvidence = (await pool.query(`SELECT
      (SELECT count(*)::text FROM receipts) AS receipts,
      (SELECT count(*)::text FROM receipt_items) AS items,
      (SELECT count(*)::text FROM receipt_raw) AS raw,
      (SELECT max(received_at)::text FROM receipts) AS max_received_at,
      (SELECT max(raw_updated_at)::text FROM receipts) AS max_raw_updated_at`)).rows[0];
  const sourceStateKey = crypto.createHash('sha256').update(JSON.stringify(snapshotEvidence)).digest('hex');
  const allRows = await loadCoverageRows(pool, { scopeKey: 'default' });
  const allTime = buildCoverageReport(allRows, { scopeKey: 'default', sourceStateKey });
  const augustRows = await loadCoverageRows(pool, { scopeKey: 'default', ...august });
  const augustReport = buildCoverageReport(augustRows, { scopeKey: 'default', sourceStateKey, ...august });
  const sameSnapshot = compareCoverageReports(allTime, allTime);
  const omittedRows = allRows.map((row) => row.operationType === 1 && row.paymentStage === 'SETTLEMENT_ONLY'
    ? { ...row, related: { events: [], certifiedAcquisitionEventIds: [], analyticsReceipt: false } }
    : row);
  const historicalOmission = buildCoverageReport(omittedRows, { scopeKey: 'default', sourceStateKey });
  const result = {
    model: allTime.model,
    sourceStateKey,
    allTime: { totals: allTime.totals, gate: allTime.gate, outcomes: allTime.outcomes, matrix: allTime.matrix, layerChecks: allTime.layerChecks },
    august: { totals: augustReport.totals, gate: augustReport.gate, outcomes: augustReport.outcomes, matrix: augustReport.matrix, layerChecks: augustReport.layerChecks },
    sameSnapshotCompare: { status: sameSnapshot.status, reasonCodes: sameSnapshot.reasonCodes, transitions: sameSnapshot.transitions },
    historicalOmission: { totals: historicalOmission.totals, gate: historicalOmission.gate, outcomes: historicalOmission.outcomes },
  };
  if (outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(outputDir, 'all-time.json'), `${JSON.stringify(allTime, null, 2)}\n`),
      fs.writeFile(path.join(outputDir, 'august-2026.json'), `${JSON.stringify(augustReport, null, 2)}\n`),
      fs.writeFile(path.join(outputDir, 'same-snapshot-compare.json'), `${JSON.stringify(sameSnapshot, null, 2)}\n`),
      fs.writeFile(path.join(outputDir, 'historical-omission.json'), `${JSON.stringify(historicalOmission, null, 2)}\n`),
      fs.writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`),
    ]);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = allTime.gate.status === 'PASS' && augustReport.gate.status === 'PASS' && sameSnapshot.status === 'PASS' && historicalOmission.gate.status === 'FAIL' ? 0 : 2;
} finally {
  await pool.end();
}

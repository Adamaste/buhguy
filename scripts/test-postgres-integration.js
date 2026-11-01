import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { assertDisposableLocalTestDatabase } from './assert-disposable-local-test-database.js';

const allTestFiles = readdirSync('tests')
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => `tests/${file}`);
const migrationTest = 'tests/postgres.integration.test.js';
const integrationFiles = [
  'tests/analytics-postgres.integration.test.js',
  'tests/certification-postgres.integration.test.js',
  'tests/ledger-postgres.integration.test.js',
  'tests/purchase-details-analytics-postgres.integration.test.js',
  'tests/bank-ingestion-postgres.integration.test.js',
  'tests/bank-device-auth-postgres.integration.test.js',
  'tests/bank-account-resolution-postgres.integration.test.js',
  'tests/historical-bank-account-resolution-postgres.integration.test.js',
  'tests/chatgpt-accounting-semantic-layer-postgres.integration.test.js',
  'tests/bank-cash-flow-projection-postgres.integration.test.js',
  'tests/balanced-bank-journal-projection-postgres.integration.test.js',
  'tests/payment-instrument-identity-postgres.integration.test.js',
  'tests/matched-purchase-persistence-schema-postgres.integration.test.js',
  'tests/active-ledger-semantics-postgres.integration.test.js',
  'tests/matched-purchase-persistence-postgres.integration.test.js',
  'tests/matched-purchase-orchestration-postgres.integration.test.js',
  'tests/bank-receipt-provisional-candidates-postgres.integration.test.js',
  'tests/matched-purchase-reconciliation-postgres.integration.test.js',
  'tests/fns-receipt-currency-postgres.integration.test.js',
  'tests/runtime-schema-postgres.integration.test.js',
  'tests/return-refund-postgres.integration.test.js',
  'tests/canonical-spending-analytics-postgres.integration.test.js',
  'tests/canonical-spending-current-snapshot-postgres.integration.test.js',
  'tests/canonical-spending-read-api-postgres.integration.test.js',
  'tests/certification-materialization-postgres.integration.test.js',
  'tests/certification-freshness-postgres.integration.test.js',
  'tests/migration-production-safety-postgres.integration.test.js',
  'tests/migrate-prod-bank-only-025-postgres.integration.test.js',
  'tests/manual-troika-topup-history-postgres.integration.test.js',
  'tests/bank-only-purchase-postgres.integration.test.js',
];
const run = (files, env = process.env) => spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env }).status ?? 1;
const runFixture = (env) => spawnSync(process.execPath, ['scripts/prepare-postgres-integration.mjs'], { stdio: 'inherit', env }).status ?? 1;
const runWithRuntimeRole = async (connectionString, baseEnv, callback) => {
  const admin = new pg.Pool({ connectionString, max: 1 });
  let created = false;
  try {
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='receipt_collector'");
    if (existing.rowCount) {
      console.error('Shared cluster role receipt_collector exists; use a fresh isolated PostgreSQL cluster.');
      return 1;
    }
    await admin.query('CREATE ROLE receipt_collector NOLOGIN');
    created = true;
    return await callback({ ...baseEnv, TEST_POSTGRES_RECEIPT_COLLECTOR_ROLE: 'true' });
  } finally {
    try {
      if (created) {
        await admin.query('DROP OWNED BY receipt_collector');
        await admin.query('DROP ROLE receipt_collector');
      }
    } finally {
      await admin.end();
    }
  }
};
const runIntegrationFiles = async (baseEnv) => {
  for (const file of integrationFiles) {
    const needsRuntimeRole = file === 'tests/bank-only-purchase-postgres.integration.test.js';
    const exitCode = needsRuntimeRole
      ? await runWithRuntimeRole(baseEnv.TEST_DATABASE_URL, baseEnv, async (env) => {
        if (runFixture(env) !== 0) return 1;
        return run([file], env);
      })
      : runFixture(baseEnv) === 0 ? run([file], baseEnv) : 1;
    if (exitCode !== 0) return 1;
  }
  return 0;
};
if (process.env.TEST_DATABASE_URL) {
  assertDisposableLocalTestDatabase(process.env.TEST_DATABASE_URL);
  if (run([migrationTest]) !== 0) process.exit(1);
  process.exit(await runIntegrationFiles(process.env));
}

try { execFileSync('docker', ['version'], { stdio: 'ignore' }); } catch {
  console.error('Docker is unavailable and TEST_DATABASE_URL is not set; PostgreSQL integration tests were not run.');
  process.exit(2);
}

const name = `finance-receipt-test-${process.pid}`;
const port = 54000 + (process.pid % 1000);
const password = crypto.randomBytes(24).toString('base64url');
const database = `finance_receipt_collector_test_${process.pid}_${Date.now()}`;
let containerStarted = false;
let exitCode = 0;
try {
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${database}`, '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine'], { stdio: 'ignore' });
  containerStarted = true;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { execFileSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', database], { stdio: 'ignore' }); break; } catch { if (attempt === 59) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  const env = { ...process.env, TEST_DATABASE_URL: `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}` };
  if (run([migrationTest], env) !== 0) exitCode = 1;
  if (exitCode === 0) exitCode = await runIntegrationFiles(env);
} finally {
  if (containerStarted) { try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch {} }
}
process.exitCode = exitCode;


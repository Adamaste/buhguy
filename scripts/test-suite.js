import { spawnSync } from 'node:child_process';

const unitFiles = [
  'tests/client.test.js',
  'tests/cli.test.js',
  'tests/fiscal-evidence.test.js',
  'tests/fiscal-normalization.test.js',
  'tests/postgres-text-evidence.test.js',
  'tests/fns-detail-errors.test.js',
  'tests/logger.test.js',
  'tests/normalize.test.js',
  'tests/operation-type.test.js',
  'tests/source-identity.test.js',
  'tests/session-store.test.js',
  'tests/sync.test.js',
  'tests/business-event-graph.test.js',
  'tests/prepayment-settlement-matcher.test.js',
  'tests/return-refund-research.test.js',
  'tests/return-refund-matcher.test.js',
  'tests/ledger.test.js',
  'tests/certification.test.js',
  'tests/analytics.test.js',
  'tests/purchase-details-analytics.test.js',
  'tests/accounting-coverage.test.js',
  'tests/standalone-purchase.test.js',
  'tests/multi-user-fns.test.js',
  'tests/fns-user-onboarding.test.js',
  'tests/accounting-pipeline.test.js',
  'tests/bank-ingestion.test.js',
  'tests/bank-device-auth.test.js',
  'tests/bank-source-provisioning.test.js',
  'tests/bank-ingestion-http.test.js',
  'tests/bank-device-runtime.test.js',
  'tests/bank-ingestion-privilege-scripts.test.js',
  'tests/runtime-schema.test.js',
  'tests/android-bank-envelope.test.js',
  'tests/chatgpt-accounting-semantic-layer.test.js',
];

const postgresFiles = [
  'tests/ledger-postgres.integration.test.js',
  'tests/certification-postgres.integration.test.js',
  'tests/analytics-postgres.integration.test.js',
  'tests/purchase-details-analytics-postgres.integration.test.js',
  'tests/bank-ingestion-postgres.integration.test.js',
  'tests/bank-device-auth-postgres.integration.test.js',
];

const run = (files, env = process.env) => spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { stdio: 'inherit', env },
).status ?? 1;

if (!process.env.TEST_DATABASE_URL) {
  process.exit(run([...unitFiles, ...postgresFiles]));
}

if (run(unitFiles) !== 0) process.exit(1);

for (const file of postgresFiles) {
  if (spawnSync(process.execPath, ['scripts/prepare-postgres-integration.mjs'], { stdio: 'inherit', env: process.env }).status !== 0) process.exit(1);
  if (run([file]) !== 0) process.exit(1);
}

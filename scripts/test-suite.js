import { spawnSync } from 'node:child_process';
import { assertDisposableLocalTestDatabase } from './assert-disposable-local-test-database.js';

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
  'tests/manual-troika-topup-expense.test.js',
  'tests/migrate-prod-troika-024.test.js',
  'tests/migrate-prod-bank-only-025.test.js',
  'tests/disposable-local-test-database.test.js',
  'tests/multi-user-fns.test.js',
  'tests/fns-user-onboarding.test.js',
  'tests/accounting-pipeline.test.js',
  'tests/bank-ingestion.test.js',
  'tests/bank-only-purchase.test.js',
  'tests/bank-account-resolution.test.js',
  'tests/historical-bank-account-resolution.test.js',
  'tests/bank-account-resolution-migration.test.js',
  'tests/migration-wrapper.test.js',
  'tests/bank-provider-fixtures.test.js',
  'tests/bank-business-event-candidate-projection.test.js',
  'tests/bank-internal-transfer-matching.test.js',
  'tests/bank-ledger-projection.test.js',
  'tests/bank-receipt-matching.test.js',
  'tests/matched-purchase-enrichment-projection.test.js',
  'tests/matched-purchase-orchestration.test.js',
  'tests/matched-purchase-reconciliation.test.js',
  'tests/matched-purchase-preview-read-only-runner.test.js',
  'tests/fns-receipt-currency.test.js',
  'tests/yandex-bank-normalization.test.js',
  'tests/alfa-bank-normalization.test.js',
  'tests/alfa-lifecycle-canonicalization.test.js',
  'tests/sber-bank-normalization.test.js',
  'tests/bank-event-type-migration.test.js',
  'tests/bank-device-auth.test.js',
  'tests/bank-source-provisioning.test.js',
  'tests/bank-ingestion-http.test.js',
  'tests/bank-device-runtime.test.js',
  'tests/bank-ingestion-privilege-scripts.test.js',
  'tests/runtime-schema.test.js',
  'tests/android-bank-envelope.test.js',
  'tests/chatgpt-accounting-semantic-layer.test.js',
  'tests/canonical-spending-analytics.test.js',
  'tests/canonical-spending-current-snapshot.test.js',
  'tests/canonical-spending-read-api.test.js',
  'tests/canonical-spending-read-service.test.js',
  'tests/certification-materialization.test.js',
  'tests/certification-freshness.test.js',
  'tests/sync-runtime-snapshot.test.js',
  'tests/release-manifest-readonly-helper.test.js',
  'tests/runtime-release.test.js',
  'tests/runtime-paths.test.js',
];

const postgresFiles = [
  'tests/active-ledger-semantics-postgres.integration.test.js',
  'tests/ledger-postgres.integration.test.js',
  'tests/certification-postgres.integration.test.js',
  'tests/analytics-postgres.integration.test.js',
  'tests/purchase-details-analytics-postgres.integration.test.js',
  'tests/bank-ingestion-postgres.integration.test.js',
  'tests/bank-device-auth-postgres.integration.test.js',
  'tests/bank-account-resolution-postgres.integration.test.js',
  'tests/historical-bank-account-resolution-postgres.integration.test.js',
  'tests/chatgpt-accounting-semantic-layer-postgres.integration.test.js',
  'tests/matched-purchase-persistence-schema-postgres.integration.test.js',
  'tests/matched-purchase-persistence-postgres.integration.test.js',
  'tests/matched-purchase-orchestration-postgres.integration.test.js',
  'tests/fns-receipt-currency-postgres.integration.test.js',
  'tests/canonical-spending-analytics-postgres.integration.test.js',
  'tests/canonical-spending-current-snapshot-postgres.integration.test.js',
  'tests/certification-materialization-postgres.integration.test.js',
  'tests/manual-troika-topup-expense-postgres.integration.test.js',
  'tests/migrate-prod-bank-only-025-postgres.integration.test.js',
  'tests/bank-only-purchase-postgres.integration.test.js',
];

const run = (files, env = process.env) => spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { stdio: 'inherit', env },
).status ?? 1;

if (process.argv.includes('--unit-only')) process.exit(run(unitFiles));

if (!process.env.TEST_DATABASE_URL) {
  process.exit(run([...unitFiles, ...postgresFiles]));
}

assertDisposableLocalTestDatabase(process.env.TEST_DATABASE_URL);

if (run(unitFiles) !== 0) process.exit(1);

for (const file of postgresFiles) {
  if (spawnSync(process.execPath, ['scripts/prepare-postgres-integration.mjs'], { stdio: 'inherit', env: process.env }).status !== 0) process.exit(1);
  if (run([file]) !== 0) process.exit(1);
}

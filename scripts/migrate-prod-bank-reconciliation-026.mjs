import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, migrate } from '../src/database.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const BANK_RECONCILIATION_MIGRATION_026 = '026_manual_bank_reconciliation_review_evidence.sql';
export const BANK_RECONCILIATION_MIGRATION_026_SHA256 = '9310b47dc144fd50ecf9445dc74dcfd5e5f1cced42d4e3ff2158372e16b5d540';

export async function migrateBankReconciliation026(pool, migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')) {
  let migrationBytes;
  try {
    migrationBytes = await readFile(path.join(migrationsDir, BANK_RECONCILIATION_MIGRATION_026));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
    const error = new Error(`Approved migration ${BANK_RECONCILIATION_MIGRATION_026} is unavailable`);
    error.code = 'MIGRATION_FILE_MISSING';
    throw error;
  }
  const canonicalMigrationBytes = Buffer.from(migrationBytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  const actualSha256 = createHash('sha256').update(canonicalMigrationBytes).digest('hex');
  if (actualSha256 !== BANK_RECONCILIATION_MIGRATION_026_SHA256) {
    const error = new Error(`Checksum mismatch for approved migration ${BANK_RECONCILIATION_MIGRATION_026}`);
    error.code = 'MIGRATION_CHECKSUM_MISMATCH';
    throw error;
  }
  return migrate(pool, migrationsDir, {
    requireSinglePendingMigration: BANK_RECONCILIATION_MIGRATION_026,
    lockTimeoutMs: Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 5000),
    statementTimeoutMs: Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS ?? 120000),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool({ connectionTimeoutMillis: Number(process.env.MIGRATION_CONNECTION_TIMEOUT_MS ?? 10000) });
  try {
    const result = await migrateBankReconciliation026(pool);
    process.stdout.write(result.applied.length ? `Applied ${BANK_RECONCILIATION_MIGRATION_026}\n` : `${BANK_RECONCILIATION_MIGRATION_026} is already applied\n`);
  } finally {
    await pool.end();
  }
}

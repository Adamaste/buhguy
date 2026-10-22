import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, migrate } from '../src/database.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const BANK_ONLY_MIGRATION_025 = '025_bank_only_purchase_ledger.sql';
export const BANK_ONLY_MIGRATION_025_SHA256 = 'ce6a4ae4f385c8d5cb38df27734cf20ab72e3dd79a7328b20ab96684426cc890';

export async function migrateBankOnly025(pool, migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')) {
  let migrationBytes;
  try {
    migrationBytes = await readFile(path.join(migrationsDir, BANK_ONLY_MIGRATION_025));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
    const error = new Error(`Approved migration ${BANK_ONLY_MIGRATION_025} is unavailable`);
    error.code = 'MIGRATION_FILE_MISSING';
    throw error;
  }
  const actualSha256 = createHash('sha256').update(migrationBytes).digest('hex');
  if (actualSha256 !== BANK_ONLY_MIGRATION_025_SHA256) {
    const error = new Error(`Checksum mismatch for approved migration ${BANK_ONLY_MIGRATION_025}`);
    error.code = 'MIGRATION_CHECKSUM_MISMATCH';
    throw error;
  }

  return migrate(pool, migrationsDir, {
    requireSinglePendingMigration: BANK_ONLY_MIGRATION_025,
    lockTimeoutMs: Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 5000),
    statementTimeoutMs: Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS ?? 120000),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool({ connectionTimeoutMillis: Number(process.env.MIGRATION_CONNECTION_TIMEOUT_MS ?? 10000) });
  try {
    const result = await migrateBankOnly025(pool);
    process.stdout.write(result.applied.length ? `Applied ${BANK_ONLY_MIGRATION_025}\n` : `${BANK_ONLY_MIGRATION_025} is already applied\n`);
  } finally {
    await pool.end();
  }
}

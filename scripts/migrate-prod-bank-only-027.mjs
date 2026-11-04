import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { createPool, migrate } from '../src/database.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const BANK_ONLY_MIGRATION_027 = '027_bank_only_purchase_runtime_privileges.sql';
export const BANK_ONLY_MIGRATION_027_SHA256 = '605d1e663444ecee5fbe8cf8d09b67e13d89b7016a776a1815e54672f586eac1';

export async function migrateBankOnly027(pool, migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')) {
  let migrationBytes;
  try {
    migrationBytes = await readFile(path.join(migrationsDir, BANK_ONLY_MIGRATION_027));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
    const error = new Error(`Approved migration ${BANK_ONLY_MIGRATION_027} is unavailable`);
    error.code = 'MIGRATION_FILE_MISSING';
    throw error;
  }
  const actualSha256 = createHash('sha256').update(migrationBytes).digest('hex');
  if (actualSha256 !== BANK_ONLY_MIGRATION_027_SHA256) {
    const error = new Error(`Checksum mismatch for approved migration ${BANK_ONLY_MIGRATION_027}`);
    error.code = 'MIGRATION_CHECKSUM_MISMATCH';
    throw error;
  }

  const stagedMigrations = await mkdtemp(path.join(os.tmpdir(), 'buhguy-migrate-027-'));
  try {
    const files = (await readdir(migrationsDir))
      .filter((filename) => filename.endsWith('.sql') && filename <= BANK_ONLY_MIGRATION_027)
      .sort();
    for (const filename of files) await copyFile(path.join(migrationsDir, filename), path.join(stagedMigrations, filename));
    return await migrate(pool, stagedMigrations, {
      requireSinglePendingMigration: BANK_ONLY_MIGRATION_027,
      lockTimeoutMs: Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 5000),
      statementTimeoutMs: Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS ?? 120000),
    });
  } finally {
    await rm(stagedMigrations, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool({ connectionTimeoutMillis: Number(process.env.MIGRATION_CONNECTION_TIMEOUT_MS ?? 10000) });
  try {
    const result = await migrateBankOnly027(pool);
    process.stdout.write(result.applied.length ? `Applied ${BANK_ONLY_MIGRATION_027}\n` : `${BANK_ONLY_MIGRATION_027} is already applied\n`);
  } finally {
    await pool.end();
  }
}

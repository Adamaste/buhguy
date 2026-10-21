import { createPool, migrate } from '../src/database.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const TROIKA_MIGRATION_024 = '024_manual_troika_topup_expenses.sql';

export async function migrateTroika024(pool, migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')) {
  return migrate(pool, migrationsDir, {
    requireSinglePendingMigration: TROIKA_MIGRATION_024,
    lockTimeoutMs: Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 5000),
    statementTimeoutMs: Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS ?? 120000),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool({ connectionTimeoutMillis: Number(process.env.MIGRATION_CONNECTION_TIMEOUT_MS ?? 10000) });
  try {
    const result = await migrateTroika024(pool);
    process.stdout.write(result.applied.length ? `Applied ${TROIKA_MIGRATION_024}\n` : `${TROIKA_MIGRATION_024} is already applied\n`);
  } finally {
    await pool.end();
  }
}

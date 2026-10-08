import { createPool, migrate } from '../src/database.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pool = createPool({ connectionTimeoutMillis: Number(process.env.MIGRATION_CONNECTION_TIMEOUT_MS ?? 10000) });
try {
  await migrate(pool, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), {
    requireSinglePendingMigration: '019_canonical_spending_analytics_foundation.sql',
    lockTimeoutMs: Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 5000),
    statementTimeoutMs: Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS ?? 120000),
  });
} finally {
  await pool.end();
}


import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, runBoundedTransaction } from '../src/database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = createPool({ connectionTimeoutMillis: Number(process.env.ANALYTICS_CONNECTION_TIMEOUT_MS ?? 10000) });
try {
  const sql = await fs.readFile(path.join(root, 'db', 'analytics', '011_canonical_spending_analytics_v1.sql'), 'utf8');
  await runBoundedTransaction(pool, (client) => client.query(sql), {
    lockTimeoutMs: Number(process.env.ANALYTICS_LOCK_TIMEOUT_MS ?? 5000),
    statementTimeoutMs: Number(process.env.ANALYTICS_STATEMENT_TIMEOUT_MS ?? 120000),
  });
} finally {
  await pool.end();
}


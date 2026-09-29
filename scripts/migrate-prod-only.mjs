import { createPool, migrate } from '../src/database.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pool = createPool();
try {
  await migrate(pool, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'));
} finally {
  await pool.end();
}

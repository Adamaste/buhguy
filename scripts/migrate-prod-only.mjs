import { createPool, migrate } from './src/database.js';

const pool = createPool();
try {
  await migrate(pool);
} finally {
  await pool.end();
}

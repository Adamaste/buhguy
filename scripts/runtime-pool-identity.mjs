import { createPool } from '../src/database.js';

const pool = createPool();
try {
  const result = await pool.query(`SELECT current_user, current_database(),
    has_table_privilege(current_user, 'public.receipt_source_observations', 'SELECT') AS observation_select,
    has_table_privilege(current_user, 'public.receipt_source_observations', 'INSERT') AS observation_insert`);
  console.log(JSON.stringify(result.rows[0]));
} finally {
  await pool.end();
}

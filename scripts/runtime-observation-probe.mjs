import { createPool } from '../src/database.js';

const pool = createPool();
const client = await pool.connect();
try {
    const row = (await client.query("SELECT s.id AS source_id,r.id AS receipt_id,r.fns_id FROM fns_sources s CROSS JOIN receipts r WHERE s.source_key='legacy-default' ORDER BY r.id LIMIT 1")).rows[0];
    await client.query('BEGIN');
    await client.query('SELECT id FROM receipt_source_observations LIMIT 1 FOR UPDATE');
  const result = await client.query('INSERT INTO receipt_source_observations(fns_source_id,receipt_id,source_receipt_id,source_content_sha256) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [row.source_id, row.receipt_id, row.fns_id, '0'.repeat(64)]);
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ ok: true, conflictNoOp: result.rowCount === 0 }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.log(JSON.stringify({ ok: false, errorClass: error.code ?? error.name, errorMessage: error.message }));
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }

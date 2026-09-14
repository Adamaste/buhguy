import { promises as fs } from 'node:fs';
import { Pool } from 'pg';
const manifest = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tx = await pool.connect();
try {
  await tx.query('BEGIN');
  for (const row of manifest.rows) {
    const [drive, document, sign] = row.tuple.split('|');
    const result = await tx.query('UPDATE receipts SET fns_id=$1 WHERE id=$2 AND fns_id=$3 AND fiscal_drive_number=$4 AND fiscal_document_number=$5 AND fiscal_sign=$6', [row.newSourceKey, row.receiptId, row.oldFnsId, drive, document, sign]);
    if (result.rowCount !== 1) throw new Error(`supplemental precondition failed for receipt ${row.receiptId}`);
  }
  await tx.query('COMMIT');
  console.log(JSON.stringify({ updated: manifest.rows.length }));
} catch (error) { await tx.query('ROLLBACK'); console.error(error.message); process.exitCode = 1; } finally { tx.release(); await pool.end(); }

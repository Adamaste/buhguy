import { promises as fs } from 'node:fs';
import { Pool } from 'pg';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('manifest path required');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (manifest.counts.ambiguous !== 0) throw new Error('Pinned manifest contains ambiguous rows');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tx = await pool.connect();
try {
  await tx.query('BEGIN');
  let updated = 0;
  for (const row of manifest.safeRepair) {
    const [drive, document, sign] = row.tuple.split('|');
    const result = await tx.query('UPDATE receipts SET fns_id=$1 WHERE id=$2 AND fns_id=$3 AND fiscal_drive_number=$4 AND fiscal_document_number=$5 AND fiscal_sign=$6', [row.newSourceKey, row.receiptId, row.oldFnsId, drive, document, sign]);
    if (result.rowCount !== 1) throw new Error(`repair precondition failed for receipt ${row.receiptId}`);
    updated += 1;
  }
  if (updated !== manifest.safeRepair.length) throw new Error(`repair count mismatch: ${updated}/${manifest.safeRepair.length}`);
  await tx.query('COMMIT');
  const counts = {
    receipts: Number((await pool.query('SELECT count(*)::int AS count FROM receipts')).rows[0].count),
    items: Number((await pool.query('SELECT count(*)::int AS count FROM receipt_items')).rows[0].count),
    raw: Number((await pool.query('SELECT count(*)::int AS count FROM receipt_raw')).rows[0].count),
    duplicateFns: Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT fns_id FROM receipts WHERE fns_id IS NOT NULL GROUP BY fns_id HAVING count(*)>1) q')).rows[0].count),
    duplicateTuples: Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL AND fiscal_document_number IS NOT NULL AND fiscal_sign IS NOT NULL GROUP BY 1,2,3 HAVING count(*)>1) q')).rows[0].count),
  };
  console.log(JSON.stringify({ updated, counts }));
} catch (error) {
  await tx.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally { tx.release(); await pool.end(); }

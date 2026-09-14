import fs from 'node:fs/promises';
import { createPool } from '../src/database.js';

const sourceId = Number(process.argv[2]);
const manifestPath = process.argv[3];
if (!Number.isInteger(sourceId) || sourceId <= 0 || !manifestPath) throw new Error('Usage: backfill-source-references.mjs <source-id> <manifest.json>');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest)) throw new Error('Manifest must be an array');

const pool = createPool();
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of manifest) {
      if (!entry.sourceReceiptId || !['RESOLVED', 'FNS_DETAIL_UNAVAILABLE'].includes(entry.status)) throw new Error('Invalid source reference manifest entry');
      if (entry.status === 'RESOLVED' && !entry.receiptId) throw new Error('Resolved entry requires receiptId');
      await client.query(`INSERT INTO fns_source_receipt_refs(fns_source_id,source_receipt_id,receipt_id,status,resolved_at)
        VALUES($1,$2,$3,$4,CASE WHEN $4='RESOLVED' THEN NOW() ELSE NULL END)
        ON CONFLICT(fns_source_id,source_receipt_id) DO UPDATE SET
          receipt_id=EXCLUDED.receipt_id,status=EXCLUDED.status,resolved_at=EXCLUDED.resolved_at,updated_at=NOW()`,
      [sourceId, entry.sourceReceiptId, entry.receiptId ?? null, entry.status]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const result = await pool.query('SELECT status,count(*)::int AS count FROM fns_source_receipt_refs WHERE fns_source_id=$1 GROUP BY status ORDER BY status', [sourceId]);
  console.log(JSON.stringify({ sourceId, counts: Object.fromEntries(result.rows.map((row) => [row.status, row.count])) }));
} finally { await pool.end(); }

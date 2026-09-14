import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { FnsClient } from '../src/fns-client.js';
import { SessionStore } from '../src/session-store.js';

const snapshot = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const targets = new Set(['7380440902657847|53254|3209728658', '7380440801186785|201624|2360634761']);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const material = (raw) => ({ sellerInn: raw?.kktOwnerInn ?? raw?.userInn ?? raw?.inn ?? null, dateTime: raw?.dateTime ?? raw?.createdDate ?? raw?.date ?? null, totalSum: raw?.totalSum ?? null, operationType: raw?.operationType ?? null, items: Array.isArray(raw?.items) ? raw.items.map((item) => ({ name: item?.name ?? item?.productName ?? item?.label ?? null, quantity: item?.quantity ?? item?.count ?? item?.amount ?? null, price: item?.price ?? item?.itemPrice ?? item?.sumOfUnit ?? null, sum: item?.sum ?? item?.total ?? item?.amountSum ?? null, paymentType: item?.paymentType ?? null, providerInn: item?.providerInn ?? null, productCode: item?.productCodeNew?.code?.gtin ?? item?.productCode ?? null })) : [] });
const client = new FnsClient({ sessionStore: new SessionStore({ stateDir: process.env.RECEIPT_COLLECTOR_STATE_DIR }), logger: {} });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rows = [];
for (const tuple of targets) {
  const candidates = snapshot.entries.filter((entry) => entry.identityKey === tuple);
  const keys = new Set(candidates.map((entry) => entry.sourceKey));
  if (candidates.length < 1 || keys.size !== 1) throw new Error(`supplemental tuple is not unique in pinned snapshot: ${tuple}; entries=${candidates.length}; distinctKeys=${keys.size}; keyHashes=${[...keys].map((key) => hash(key))}`);
  const entry = candidates[0];
  if (new Set(candidates.map((candidate) => candidate.materialHash)).size !== 1) throw new Error(`supplemental tuple has conflicting duplicate materials: ${tuple}`);
  const raw = await client.getReceiptRaw(entry.sourceKey);
  if (hash(material(raw)) !== entry.materialHash) throw new Error(`supplemental material changed: ${tuple}`);
  const [drive, document, sign] = tuple.split('|');
  const result = await pool.query('SELECT id,fns_id,fiscal_document_number,payload FROM receipts r JOIN receipt_raw rr ON rr.receipt_id=r.id WHERE fiscal_drive_number=$1 AND fiscal_document_number=$2 AND fiscal_sign=$3', [drive, document, sign]);
  if (result.rowCount !== 1) throw new Error(`supplemental DB tuple is not unique: ${tuple}`);
  const db = result.rows[0];
  if (String(db.fns_id) !== String(db.fiscal_document_number)) throw new Error(`supplemental row is not legacy fallback: ${tuple}`);
  if (hash(material(db.payload)) !== entry.materialHash) throw new Error(`supplemental DB material mismatch: ${tuple}`);
  rows.push({ receiptId: db.id, oldFnsId: db.fns_id, newSourceKey: entry.sourceKey, tuple });
}
console.log(JSON.stringify({ verified: rows.length, rows: rows.map((row) => ({ receiptId: row.receiptId, tuple: row.tuple })) }));
await fs.writeFile('/tmp/supplemental-repair-manifest.json', JSON.stringify({ rows }, null, 2), { mode: 0o600 });
await pool.end();

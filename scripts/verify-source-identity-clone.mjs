import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Pool } from 'pg';
import { FnsClient } from '../src/fns-client.js';
import { SessionStore } from '../src/session-store.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql:///finance_receipt_collector_clone_20260907' });
const client = new FnsClient({ sessionStore: new SessionStore(), logger: {} });
const keyHash = (v) => createHash('sha256').update(String(v)).digest('hex');
const material = (raw) => createHash('sha256').update(JSON.stringify({ sellerInn: raw?.userInn ?? raw?.inn ?? null, dateTime: raw?.dateTime ?? null, totalSum: raw?.totalSum ?? null, operationType: raw?.operationType ?? null, items: (raw?.items ?? []).map((x) => ({ name:x?.name, quantity:x?.quantity, price:x?.price, sum:x?.sum, paymentType:x?.paymentType, providerInn:x?.providerInn, code:x?.productCode ?? x?.gtin ?? x?.code })) })).digest('hex');
const identity = (raw) => ({ drive: raw?.fiscalDriveNumber ?? null, document: raw?.fiscalDocumentNumber ?? null, sign: raw?.fiscalSign ?? null });
const key = (i) => i.drive && i.document && i.sign ? `${i.drive}|${i.document}|${i.sign}` : null;
const summaries = [];
for (let offset = 0; ; offset += 50) {
  const page = await client.listReceipts({ limit: 50, offset, orderBy: 'CREATED_DATE:DESC', kktOwner: '' });
  summaries.push(...page.receipts.map((summary) => ({ id: summary.id })));
  if (!page.hasMore || page.receipts.length === 0) break;
}
const docs = [];
for (let offset = 0; offset < summaries.length; offset += 8) {
  const batch = await Promise.all(summaries.slice(offset, offset + 8).map(async (summary) => {
    const raw = await client.getReceiptRaw(summary.id);
    const id = identity(raw);
    return { sourceKeyHash: keyHash(summary.id), sourceKey: summary.id, listId: summary.id, detailId: raw?.key ?? raw?.id ?? null, identity: id, identityKey: key(id), materialHash: material(raw) };
  }));
  docs.push(...batch);
}
const duplicate = (field) => { const m = new Map(); for (const d of docs) { const v=d[field]; if(v) m.set(v,(m.get(v)||0)+1); } return [...m.values()].filter((n)=>n>1).length; };
const duplicateGroups = (field) => {
  const groups = new Map();
  for (const d of docs) {
    const value = d[field];
    if (!value) continue;
    const rows = groups.get(value) ?? [];
    rows.push({ sourceKeyHash: d.sourceKeyHash, identityKey: d.identityKey, materialHash: d.materialHash });
    groups.set(value, rows);
  }
  return [...groups.entries()].filter(([, rows]) => rows.length > 1).map(([value, rows]) => ({ value, rows }));
};
const matched=[]; const unmatched=[];
const dbRows = (await pool.query(`
  SELECT r.id, r.fns_id, r.fiscal_drive_number, r.fiscal_document_number,
         r.fiscal_sign, rr.payload
  FROM receipts r
  LEFT JOIN receipt_raw rr ON rr.receipt_id = r.id
`)).rows;
for (const row of dbRows) {
  const f = docs.find((d) => d.identityKey === [row.fiscal_drive_number,row.fiscal_document_number,row.fiscal_sign].join('|'));
  const dbMaterialHash = row.payload ? material(row.payload) : null;
  (f ? matched : unmatched).push({ receiptId: row.id, identityKey: [row.fiscal_drive_number,row.fiscal_document_number,row.fiscal_sign].join('|'), sourceKeyHash: f?.sourceKeyHash ?? null, materialHash: f?.materialHash ?? null, dbMaterialHash, materialEqual: Boolean(f && dbMaterialHash === f.materialHash) });
}
const used = new Set(matched.map((x)=>x.identityKey));
const fnsOnly = docs.filter((d)=>d.identityKey && !used.has(d.identityKey)).map((d)=>({ sourceKeyHash:d.sourceKeyHash, identityKey:d.identityKey, materialHash:d.materialHash }));
const materialDifferent = matched.filter((x) => !x.materialEqual);
await fs.writeFile('/tmp/source-identity-map-redacted.json', JSON.stringify({ generatedAt:new Date().toISOString(), total:docs.length, duplicateSourceKeys:duplicate('sourceKeyHash'), duplicateTuples:duplicate('identityKey'), dbReceipts:dbRows.length, exactTupleMatches:matched.length, dbWithoutFnsMatch:unmatched.length, fnsWithoutDbMatch:fnsOnly.length, materialEqual:matched.length - materialDifferent.length, materialDifferent:materialDifferent.map(({ receiptId, identityKey, sourceKeyHash, materialHash, dbMaterialHash }) => ({ receiptId, identityKey, sourceKeyHash, materialHash, dbMaterialHash })), unmatchedDb:unmatched, fnsOnly }, null, 2), { mode:0o600 });
console.log(JSON.stringify({ total:docs.length, duplicateSourceKeys:duplicate('sourceKeyHash'), duplicateTuples:duplicate('identityKey'), dbReceipts:dbRows.length, exactTupleMatches:matched.length, dbWithoutFnsMatch:unmatched.length, fnsWithoutDbMatch:fnsOnly.length, materialEqual:matched.length - materialDifferent.length, materialDifferent:materialDifferent.length, duplicateSourceKeyGroups:duplicateGroups('sourceKeyHash'), duplicateTupleGroups:duplicateGroups('identityKey'), dbOnly:unmatched, fnsOnly }));
await pool.end();

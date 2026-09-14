import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { FnsClient } from '../src/fns-client.js';
import { SessionStore } from '../src/session-store.js';
import { fiscalIdentityFromRaw, fiscalIdentityKey } from '../src/fiscal-evidence.js';

const output = process.argv[2];
if (!output) throw new Error('snapshot output path is required');
const client = new FnsClient({ sessionStore: new SessionStore({ stateDir: process.env.RECEIPT_COLLECTOR_STATE_DIR }), logger: {} });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const material = (raw) => ({
  sellerInn: raw?.kktOwnerInn ?? raw?.userInn ?? raw?.inn ?? null,
  dateTime: raw?.dateTime ?? raw?.createdDate ?? raw?.date ?? null,
  totalSum: raw?.totalSum ?? null,
  operationType: raw?.operationType ?? null,
  items: Array.isArray(raw?.items) ? raw.items.map((item) => ({
    name: item?.name ?? item?.productName ?? item?.label ?? null,
    quantity: item?.quantity ?? item?.count ?? item?.amount ?? null,
    price: item?.price ?? item?.itemPrice ?? item?.sumOfUnit ?? null,
    sum: item?.sum ?? item?.total ?? item?.amountSum ?? null,
    paymentType: item?.paymentType ?? null,
    providerInn: item?.providerInn ?? null,
    productCode: item?.productCodeNew?.code?.gtin ?? item?.productCode ?? null,
  })) : [],
});
const summaries = [];
for (let offset = 0; ; offset += 50) {
  const page = await client.listReceipts({ limit: 50, offset, orderBy: 'CREATED_DATE:DESC', kktOwner: '' });
  summaries.push(...page.receipts);
  if (!page.hasMore || page.receipts.length === 0) break;
}
const entries = [];
for (let offset = 0; offset < summaries.length; offset += 8) {
  const batch = await Promise.all(summaries.slice(offset, offset + 8).map(async (summary) => {
    const raw = await client.getReceiptRaw(summary.id);
    const identityKey = fiscalIdentityKey(fiscalIdentityFromRaw(raw));
    return { sourceKey: String(summary.id), identityKey, materialHash: hash(material(raw)) };
  }));
  entries.push(...batch);
}
await fs.writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), request: { kktOwner: '', limit: 50, orderBy: 'CREATED_DATE:DESC' }, total: entries.length, entries }, null, 2), { mode: 0o600 });
const grouped = (field) => {
  const groups = new Map();
  for (const row of entries) { const list = groups.get(row[field]) ?? []; list.push(row); groups.set(row[field], list); }
  return [...groups.values()].filter((rows) => rows.length > 1).map((rows) => ({ count: rows.length, sourceKeys: new Set(rows.map((r) => r.sourceKey)).size, tuples: new Set(rows.map((r) => r.identityKey)).size, materials: new Set(rows.map((r) => r.materialHash)).size }));
};
console.log(JSON.stringify({ total: entries.length, distinctTuples: new Set(entries.map((r) => r.identityKey)).size, distinctSourceKeys: new Set(entries.map((r) => r.sourceKey)).size, duplicateSourceGroups: grouped('sourceKey'), duplicateTupleGroups: grouped('identityKey') }));

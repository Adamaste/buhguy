import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';

const [snapshot1Path, snapshot2Path, outputPath] = process.argv.slice(2);
if (!snapshot1Path || !snapshot2Path || !outputPath) throw new Error('snapshot1 snapshot2 output required');
const s1 = JSON.parse(await fs.readFile(snapshot1Path, 'utf8'));
const s2 = JSON.parse(await fs.readFile(snapshot2Path, 'utf8'));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const material = (raw) => ({ sellerInn: raw?.kktOwnerInn ?? raw?.userInn ?? raw?.inn ?? null, dateTime: raw?.dateTime ?? raw?.createdDate ?? raw?.date ?? null, totalSum: raw?.totalSum ?? null, operationType: raw?.operationType ?? null, items: Array.isArray(raw?.items) ? raw.items.map((item) => ({ name: item?.name ?? item?.productName ?? item?.label ?? null, quantity: item?.quantity ?? item?.count ?? item?.amount ?? null, price: item?.price ?? item?.itemPrice ?? item?.sumOfUnit ?? null, sum: item?.sum ?? item?.total ?? item?.amountSum ?? null, paymentType: item?.paymentType ?? null, providerInn: item?.providerInn ?? null, productCode: item?.productCodeNew?.code?.gtin ?? item?.productCode ?? null })) : [] });
const mapByTuple = (entries) => { const map = new Map(); for (const entry of entries) { const list = map.get(entry.identityKey) ?? []; list.push(entry); map.set(entry.identityKey, list); } return map; };
const map1 = mapByTuple(s1.entries), map2 = mapByTuple(s2.entries);
const allTuples = new Set([...map1.keys(), ...map2.keys()]);
const stable = { tuplesOnlySnapshot1: 0, tuplesOnlySnapshot2: 0, mappingChanged: 0, materialChanged: 0, stableTuples: 0 };
for (const tuple of allTuples) {
  const a = map1.get(tuple) ?? [], b = map2.get(tuple) ?? [];
  if (!a.length) { stable.tuplesOnlySnapshot2 += 1; continue; }
  if (!b.length) { stable.tuplesOnlySnapshot1 += 1; continue; }
  const keysA = [...new Set(a.map((x) => x.sourceKey))].sort();
  const keysB = [...new Set(b.map((x) => x.sourceKey))].sort();
  const matsA = [...new Set(a.map((x) => x.materialHash))].sort();
  const matsB = [...new Set(b.map((x) => x.materialHash))].sort();
  if (JSON.stringify(keysA) !== JSON.stringify(keysB)) stable.mappingChanged += 1;
  if (JSON.stringify(matsA) !== JSON.stringify(matsB)) stable.materialChanged += 1;
  if (JSON.stringify(keysA) === JSON.stringify(keysB) && JSON.stringify(matsA) === JSON.stringify(matsB)) stable.stableTuples += 1;
}
const classify = (rows) => {
  const keys = new Set(rows.map((r) => r.sourceKey));
  const tuples = new Set(rows.map((r) => r.identityKey));
  const materials = new Set(rows.map((r) => r.materialHash));
  if (keys.size === 1 && tuples.size === 1 && materials.size === 1) return 'A_EXACT_DUPLICATE_LIST_ENTRY';
  if (keys.size > 1 && tuples.size === 1 && materials.size === 1) return 'B_SOURCE_ALIASES';
  if (tuples.size === 1 && materials.size > 1) return 'C_TRUE_CONFLICTING_SOURCE_DATA';
  return 'D_OTHER';
};
const duplicateGroups = [...map2.entries()].filter(([, rows]) => rows.length > 1).map(([tuple, rows]) => ({ tuple, classification: classify(rows), count: rows.length, distinctSourceKeys: new Set(rows.map((r) => r.sourceKey)).size, distinctMaterials: new Set(rows.map((r) => r.materialHash)).size }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dbRows = (await pool.query('SELECT r.id,r.fns_id,r.fiscal_drive_number,r.fiscal_document_number,r.fiscal_sign,rr.payload FROM receipts r LEFT JOIN receipt_raw rr ON rr.receipt_id=r.id ORDER BY r.id')).rows;
const dbMaterialHash = (payload) => hash(material(payload));
const currentByTuple = map2;
const safeRepair = [], unresolvedDbOnly = [], ambiguous = [];
for (const row of dbRows) {
  const tuple = [row.fiscal_drive_number, row.fiscal_document_number, row.fiscal_sign].every((v) => v !== null && v !== undefined && String(v) !== '') ? `${row.fiscal_drive_number}|${row.fiscal_document_number}|${row.fiscal_sign}` : null;
  const candidates = tuple ? currentByTuple.get(tuple) ?? [] : [];
  const keys = [...new Set(candidates.map((x) => x.sourceKey))];
  const materials = [...new Set(candidates.map((x) => x.materialHash))];
  const oldLegacy = String(row.fns_id ?? '') === String(row.fiscal_document_number ?? '');
  const materialEqual = candidates.length > 0 && materials.length === 1 && dbMaterialHash(row.payload) === materials[0];
  if (candidates.length > 0 && keys.length === 1 && materials.length === 1 && materialEqual && oldLegacy) safeRepair.push({ receiptId: row.id, oldFnsId: row.fns_id, newSourceKey: keys[0], tuple, materialHash: materials[0] });
  else if (!candidates.length) unresolvedDbOnly.push({ receiptId: row.id, tuple, reason: 'NO_CURRENT_FNS_TUPLE' });
  else ambiguous.push({ receiptId: row.id, tuple, candidateRows: candidates.length, distinctSourceKeys: keys.length, distinctMaterials: materials.length, materialEqual, oldLegacy });
}
const usedTuples = new Set(dbRows.map((row) => [row.fiscal_drive_number,row.fiscal_document_number,row.fiscal_sign].join('|')));
const fnsOnly = [...map2.keys()].filter((tuple) => !usedTuples.has(tuple)).map((tuple) => ({ tuple, count: map2.get(tuple).length, classification: classify(map2.get(tuple)) }));
const tuples1 = new Set(s1.entries.map((entry) => entry.identityKey));
const tuples2 = new Set(s2.entries.map((entry) => entry.identityKey));
const result = { generatedAt: new Date().toISOString(), snapshotStability: stable, tupleSetOnlySnapshot1: [...tuples1].filter((tuple) => !tuples2.has(tuple)), tupleSetOnlySnapshot2: [...tuples2].filter((tuple) => !tuples1.has(tuple)), snapshot1: { total: s1.total }, snapshot2: { total: s2.total }, duplicateGroups, safeRepair, unresolvedDbOnly, fnsOnly, ambiguous, counts: { safeRepairable: safeRepair.length, unresolvedDbOnly: unresolvedDbOnly.length, fnsOnly: fnsOnly.length, ambiguous: ambiguous.length, duplicateGroups: duplicateGroups.length } };
await fs.writeFile(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ snapshotStability: stable, tupleSetOnlySnapshot1: result.tupleSetOnlySnapshot1, tupleSetOnlySnapshot2: result.tupleSetOnlySnapshot2, duplicateGroups: duplicateGroups.map(({ tuple, classification, count, distinctSourceKeys, distinctMaterials }) => ({ tuple, classification, count, distinctSourceKeys, distinctMaterials })), counts: result.counts }));
await pool.end();

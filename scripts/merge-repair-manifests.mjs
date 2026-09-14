import { promises as fs } from 'node:fs';
const [basePath, extraPath, outputPath] = process.argv.slice(2);
const base = JSON.parse(await fs.readFile(basePath, 'utf8'));
const extra = JSON.parse(await fs.readFile(extraPath, 'utf8'));
const rows = [...base.safeRepair, ...extra.rows];
const unique = new Map(rows.map((row) => [String(row.receiptId), row]));
const result = { generatedAt: new Date().toISOString(), counts: { safeRepairable: unique.size, unresolvedDbOnly: Math.max(0, (base.counts.unresolvedDbOnly ?? 0) - extra.rows.length), fnsOnly: base.counts.fnsOnly, ambiguous: base.counts.ambiguous, duplicateGroups: base.counts.duplicateGroups }, safeRepair: [...unique.values()] };
await fs.writeFile(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ safeRepairable: result.counts.safeRepairable, unresolvedDbOnly: result.counts.unresolvedDbOnly }));

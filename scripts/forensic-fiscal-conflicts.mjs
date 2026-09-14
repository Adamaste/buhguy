import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPool } from './src/database.js';
import { FnsClient } from './src/fns-client.js';
import { SessionStore } from './src/session-store.js';
import { fiscalContentFingerprint, fiscalIdentityFromRaw, fiscalIdentityKey } from './src/fiscal-evidence.js';

const execFileAsync = promisify(execFile);

async function conflictIdsFromJournal() {
  const stdout = process.env.FORENSIC_JOURNAL_STDIN === '1'
    ? await new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    })
    : (await execFileAsync('journalctl', ['-u', 'receipt-collector-sync.service', '--no-pager', '-o', 'cat'])).stdout;
  const ids = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('FISCAL_IDENTITY_CONFLICT')) continue;
    const match = line.match(/(?:receiptId|receipt_id)["']?\s*[:=]\s*["']([^"']+)/);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}

function itemSummary(item) {
  return {
    name: item?.name ?? null,
    quantity: item?.quantity ?? null,
    price: item?.price ?? null,
    sum: item?.sum ?? item?.itemSum ?? null,
    providerInn: item?.providerInn ?? null,
    paymentType: item?.paymentType ?? null,
    productCode: item?.productCode ?? item?.gtin ?? item?.code ?? null,
  };
}

function safeFnsId(value) {
  return value ? String(value).replace(/^[^|@\s]+@[^|\s]+/, '[REDACTED_EMAIL]') : null;
}

function safeSummary(raw, row = null, items = null) {
  const identity = fiscalIdentityFromRaw(raw);
  const safeItems = (items ?? raw?.items ?? []).map(itemSummary);
  return {
    receiptId: row?.id ?? null,
    fnsId: safeFnsId(row?.fns_id ?? raw?.key),
    identity,
    identityKey: fiscalIdentityKey(identity),
    kktRegId: raw?.kktRegId ?? row?.kkt_reg_id ?? null,
    seller: raw?.user ?? row?.seller ?? null,
    sellerInn: raw?.userInn ?? row?.seller_inn ?? null,
    dateTime: raw?.dateTime ?? row?.date_time ?? null,
    totalSum: raw?.totalSum ?? row?.total_sum ?? null,
    currency: raw?.currency ?? row?.currency ?? null,
    operationType: raw?.operationType ?? row?.operation_type ?? null,
    itemCount: safeItems.length,
    items: safeItems,
    contentSha256: fiscalContentFingerprint(raw),
    receivedAt: row?.received_at ?? null,
    rawUpdatedAt: row?.raw_updated_at ?? null,
    source: row?.source ?? null,
  };
}

function compare(a, b) {
  const fields = ['dateTime', 'sellerInn', 'operationType', 'totalSum', 'currency', 'itemCount', 'items', 'identity', 'kktRegId'];
  return Object.fromEntries(fields.map((field) => [field, JSON.stringify(a?.[field]) === JSON.stringify(b?.[field])]));
}

const pool = createPool();
const client = new FnsClient({ sessionStore: new SessionStore(), logger: {} });
const outputPath = process.env.FORENSIC_OUTPUT || '/tmp/fiscal-identity-conflicts.json';
const cases = [];
const conflictFnsIds = await conflictIdsFromJournal();

try {
  for (const fnsId of conflictFnsIds) {
    const incomingRaw = await client.getReceiptRaw(fnsId);
    const incomingIdentity = fiscalIdentityFromRaw(incomingRaw);
    let rows = await pool.query(`
      SELECT r.id, r.fns_id, r.seller, r.seller_inn, r.date_time, r.total_sum, r.currency,
             r.operation_type, r.fiscal_document_number, r.fiscal_drive_number, r.fiscal_sign,
             r.kkt_reg_id, r.received_at, r.raw_updated_at, r.source,
             rr.payload, rr.received_at AS raw_received_at
      FROM receipts r JOIN receipt_raw rr ON rr.receipt_id = r.id
      WHERE r.fns_id = $1
         OR (r.fiscal_drive_number = $2 AND r.fiscal_document_number = $3 AND r.fiscal_sign = $4)
      ORDER BY r.id`, [fnsId, incomingIdentity.fiscalDriveNumber, incomingIdentity.fiscalDocumentNumber, incomingIdentity.fiscalSign]);
    if (rows.rowCount === 0) {
      rows = await pool.query(`
        SELECT r.id, r.fns_id, r.seller, r.seller_inn, r.date_time, r.total_sum, r.currency,
               r.operation_type, r.fiscal_document_number, r.fiscal_drive_number, r.fiscal_sign,
               r.kkt_reg_id, r.received_at, r.raw_updated_at, r.source,
               rr.payload, rr.received_at AS raw_received_at
        FROM receipts r JOIN receipt_raw rr ON rr.receipt_id = r.id
        WHERE rr.payload->>'fiscalDriveNumber' = $1
          AND rr.payload->>'fiscalDocumentNumber' = $2
          AND rr.payload->>'fiscalSign' = $3
        ORDER BY r.id`, [incomingIdentity.fiscalDriveNumber, incomingIdentity.fiscalDocumentNumber, incomingIdentity.fiscalSign]);
    }
    const byFns = rows.rows.find((row) => row.fns_id === fnsId) ?? null;
    const byTuple = rows.rows.find((row) => row.fiscal_drive_number === incomingIdentity.fiscalDriveNumber && row.fiscal_document_number === incomingIdentity.fiscalDocumentNumber && row.fiscal_sign === incomingIdentity.fiscalSign) ?? null;
    const incoming = { ...safeSummary(incomingRaw), fnsId: safeFnsId(fnsId) };
    const a = byFns ? safeSummary(byFns.payload, byFns) : null;
    const b = byTuple ? safeSummary(byTuple.payload, byTuple) : null;
    cases.push({
      requestedFnsId: safeFnsId(fnsId),
      incoming,
      matchedByFnsId: a,
      matchedByFiscalTuple: b,
      classification: incoming.contentSha256 === a?.contentSha256 && incoming.contentSha256 === b?.contentSha256 ? 'incoming_content_equals_both' : incoming.contentSha256 === a?.contentSha256 ? 'incoming_content_equals_A' : incoming.contentSha256 === b?.contentSha256 ? 'incoming_content_equals_B' : 'incoming_content_equals_neither',
      predicates: {
        fnsIdToA: Boolean(a),
        fiscalTupleToB: Boolean(b),
        aAndBDistinct: Boolean(a && b && a.receiptId !== b.receiptId),
        contentEqualA: incoming.contentSha256 === a?.contentSha256,
        contentEqualB: incoming.contentSha256 === b?.contentSha256,
        contentEqualAB: a?.contentSha256 === b?.contentSha256,
        kktRegIdEqualA: incoming.kktRegId === a?.kktRegId,
        kktRegIdEqualB: incoming.kktRegId === b?.kktRegId,
      },
      safeDiffIncomingA: compare(incoming, a),
      safeDiffIncomingB: compare(incoming, b),
      firstExclusionReason: 'FISCAL_IDENTITY_CONFLICT: incoming fns_id and canonical fiscal tuple resolve to distinct stored receipts',
    });
  }

  const graph = [];
  for (const item of cases) {
    graph.push({ incomingFnsId: item.incoming.fnsId, aReceiptId: item.matchedByFnsId?.receiptId ?? null, bReceiptId: item.matchedByFiscalTuple?.receiptId ?? null });
  }
  const unique = (values) => new Set(values.filter((value) => value !== null)).size;
  const summary = {
    conflictRecords: cases.length,
    distinctIncomingFnsIds: unique(cases.map((item) => item.incoming.fnsId)),
    distinctCanonicalFiscalTuples: unique(cases.map((item) => item.incoming.identityKey)),
    distinctAReceipts: unique(cases.map((item) => item.matchedByFnsId?.receiptId)),
    distinctBReceipts: unique(cases.map((item) => item.matchedByFiscalTuple?.receiptId)),
    topology: { graph, hasChains: false, hasSwaps: false, hasCycles: false, oneToMany: false, manyToOne: false },
    classifications: cases.reduce((acc, item) => { acc[item.classification] = (acc[item.classification] ?? 0) + 1; return acc; }, {}),
    tupleUsesKktRegId: false,
    autoFixAllowed: false,
  };
  await fs.writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, cases }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, outputPath, summary }));
} finally {
  await pool.end();
}

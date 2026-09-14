import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { MATCHER_RECEIPTS_SQL, NORMALIZED_FACT_VERSION } from '../src/prepayment-settlement-matcher.js';
import { validateBusinessEventGraph } from '../src/business-event-graph.js';
import { classifyReturnResearch, RETURN_RESEARCH_VERSION, summarizeReturnResearch } from '../src/return-refund-research.js';

const outputDir = process.argv[2] ?? 'artifacts/return-refund-research';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const money = (value) => Number(value ?? 0);
const round = (value) => Math.round(value * 100) / 100;
const writeJson = async (name, value) => writeFile(`${outputDir}/${name}`, `${JSON.stringify(value, null, 2)}\n`);

try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const rows = (await client.query(MATCHER_RECEIPTS_SQL, [NORMALIZED_FACT_VERSION])).rows;
  const itemFactRows = (await client.query(`
    SELECT i.receipt_id, i.position, f.payment_type_code, f.payment_type_semantic,
           f.product_type_code, f.provider_inn, f.gtin, f.raw_product_code
    FROM receipt_items i
    LEFT JOIN receipt_item_fiscal_facts f ON f.receipt_item_id=i.id AND f.normalization_version=$1
    ORDER BY i.receipt_id,i.position`, [NORMALIZED_FACT_VERSION])).rows;
  const itemFactsByReceipt = new Map();
  for (const item of itemFactRows) {
    const list = itemFactsByReceipt.get(String(item.receipt_id)) ?? [];
    list.push(item);
    itemFactsByReceipt.set(String(item.receipt_id), list);
  }
  const receipts = rows.map((row) => ({
    id: String(row.id), operationType: row.operationType, sellerInn: row.sellerInn, totalSum: row.totalSum,
    dateTime: row.dateTime, paymentStage: row.paymentStage,
    cashTotalSum: row.cashTotalSum, ecashTotalSum: row.ecashTotalSum,
    prepaidSum: row.prepaidSum, creditSum: row.creditSum, provisionSum: row.provisionSum,
    paymentTypeSignature: [...new Set((itemFactsByReceipt.get(String(row.id)) ?? []).map((item) => item.payment_type_code).filter((value) => value !== null))].sort().join(','),
    items: (row.items ?? []).map((item, index) => ({ ...item, ...(itemFactsByReceipt.get(String(row.id))?.[index] ? { paymentTypeCode: itemFactsByReceipt.get(String(row.id))[index].payment_type_code, paymentTypeSemantic: itemFactsByReceipt.get(String(row.id))[index].payment_type_semantic } : {}) })),
  }));
  const sales = receipts.filter((row) => Number(row.operationType) === 1);
  const returns = receipts.filter((row) => Number(row.operationType) === 2);
  const graphRows = (await client.query(`
    SELECT e.receipt_id, b.id AS event_id, b.event_type, b.resolution_status, b.origin,
           b.rule_code, b.rule_version, e.evidence_role
    FROM business_event_evidence e JOIN business_events b ON b.id=e.event_id
    WHERE e.receipt_id IS NOT NULL
    ORDER BY e.receipt_id,b.id`)).rows;
  const graphByReceipt = new Map();
  for (const row of graphRows) {
    const list = graphByReceipt.get(String(row.receipt_id)) ?? [];
    list.push({ eventId: row.event_id, eventType: row.event_type, resolutionStatus: row.resolution_status, origin: row.origin, ruleCode: row.rule_code, ruleVersion: row.rule_version, evidenceRole: row.evidence_role });
    graphByReceipt.set(String(row.receipt_id), list);
  }
  const allocatedSaleIds = new Set((await client.query(`SELECT DISTINCT receipt_id FROM business_event_evidence e JOIN business_events b ON b.id=e.event_id WHERE b.event_type='RETURN' AND b.resolution_status IN ('CONFIRMED','MANUAL_CONFIRMED')`)).rows.map((row) => String(row.receipt_id)));
  const priorReturnsBySaleId = new Map();
  const results = returns.map((row) => {
    const result = classifyReturnResearch(row, sales, { allocatedSaleIds, priorReturnsBySaleId });
    return { ...result, returnTotalSum: row.totalSum, returnDateTime: row.dateTime, sellerInn: row.sellerInn, paymentStage: row.paymentStage, paymentTypeSignature: row.paymentTypeSignature, cashTotalSum: row.cashTotalSum, ecashTotalSum: row.ecashTotalSum, prepaidSum: row.prepaidSum, creditSum: row.creditSum, provisionSum: row.provisionSum, graphContext: graphByReceipt.get(row.id) ?? [] };
  });
  const summary = summarizeReturnResearch(results);
  summary.fiscalFaceValue = round(returns.reduce((sum, row) => sum + money(row.totalSum), 0));
  summary.newMoney = round(returns.reduce((sum, row) => sum + money(row.cashTotalSum) + money(row.ecashTotalSum), 0));
  summary.byClassification = Object.fromEntries(Object.entries(summary.byClassification).sort((a, b) => b[1] - a[1]));
  const grouped = (classifications) => results.filter((row) => classifications.includes(row.classification));
  const safe = results.filter((row) => row.classification === 'EXACT_UNIQUE_SAFE');
  const ambiguous = results.filter((row) => row.classification.startsWith('AMBIGUOUS'));
  const partial = grouped(['PARTIAL_ITEM_CANDIDATE']);
  const unmatched = results.filter((row) => !safe.includes(row) && !ambiguous.includes(row) && !partial.includes(row));
  const exposure = (rowsForExposure) => ({
    receipts: rowsForExposure.length,
    fiscalFaceValue: round(rowsForExposure.reduce((sum, row) => sum + money(row.returnTotalSum), 0)),
    newMoney: round(rowsForExposure.reduce((sum, row) => sum + money(row.cashTotalSum) + money(row.ecashTotalSum), 0)),
    prepaid: round(rowsForExposure.reduce((sum, row) => sum + money(row.prepaidSum), 0)),
    credit: round(rowsForExposure.reduce((sum, row) => sum + money(row.creditSum), 0)),
    provision: round(rowsForExposure.reduce((sum, row) => sum + money(row.provisionSum), 0)),
    sampleReceiptIds: rowsForExposure.slice(0, 10).map((row) => row.returnReceiptId),
  });
  const graphValidator = await validateBusinessEventGraph(client);
  const invariantCounts = {
    returns: returns.length,
    resultRows: results.length,
    exactSafe: safe.length,
    noDoubleConfirmedReturnEdges: Number((await client.query(`SELECT count(*)::int AS count FROM business_event_edges WHERE relation_type='RETURNS' AND resolution_status='CONFIRMED'`)).rows[0].count) === 0,
    graphValidator: graphValidator.ok,
    productionMutations: false,
  };
  await mkdir(outputDir, { recursive: true });
  await writeJson('summary.json', { researchVersion: RETURN_RESEARCH_VERSION, generatedAt: new Date().toISOString(), corpus: { receipts: receipts.length, sales: sales.length, returns: returns.length }, groups: { exactUniquePrevious: 34, ambiguousPrevious: 82, partialPrevious: 5, unmatchedPrevious: 164 }, classification: summary, exposure: { EXACT_UNIQUE_SAFE: exposure(safe), AMBIGUOUS: exposure(ambiguous), PARTIAL: exposure(partial), UNMATCHED: exposure(unmatched) }, graphEvidenceReceipts: new Set(graphRows.map((row) => String(row.receipt_id))).size, graphValidator, invariants: invariantCounts, proposedRule: { name: 'RETURN_REFUND_V1', predicates: ['operation_type=2 return and operation_type=1 sale', 'same seller identity', 'sale chronology strictly before return', 'equal fiscal amount for full return', 'exact item identity including quantity, price and item sum', 'one and only one candidate', 'no existing confirmed return allocation', 'purchase lifecycle context resolved before business confirmation'], decisions: ['equal candidates remain AMBIGUOUS', 'partial quantity/amount remains CANDIDATE_ONLY until explicit allocation', 'UNMATCHED remains unresolved', 'return and refund are separate business events'] } });
  await writeJson('exact-unique.json', results.filter((row) => row.classification.startsWith('EXACT_UNIQUE')));
  await writeJson('ambiguous-patterns.json', { summary: exposure(ambiguous), groups: Object.entries(ambiguous.reduce((acc, row) => { const key = row.classification; (acc[key] ??= []).push(row); return acc; }, {})).map(([classification, rowsForGroup]) => ({ classification, ...exposure(rowsForGroup) })) });
  await writeJson('partial-patterns.json', { summary: exposure(partial), cases: partial });
  await writeJson('unmatched-patterns.json', { summary: exposure(unmatched), groups: Object.entries(unmatched.reduce((acc, row) => { const key = row.classification; (acc[key] ??= []).push(row); return acc; }, {})).map(([classification, rowsForGroup]) => ({ classification, ...exposure(rowsForGroup) })), cases: unmatched });
  console.log(JSON.stringify({ researchVersion: RETURN_RESEARCH_VERSION, corpus: { sales: sales.length, returns: returns.length }, classification: summary.byClassification, safeExactUnique: safe.length, exposure: { ambiguous: exposure(ambiguous), partial: exposure(partial), unmatched: exposure(unmatched) }, graphValidator: graphValidator.ok }));
  await client.query('COMMIT');
} catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await pool.end(); }

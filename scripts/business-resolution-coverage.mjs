import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { MATCHER_RECEIPTS_SQL, matchPrepaymentSettlements, MATCHER_VERSION, NORMALIZED_FACT_VERSION, PREPAYMENT_SETTLEMENT_RULE } from '../src/prepayment-settlement-matcher.js';
import { validateBusinessEventGraph } from '../src/business-event-graph.js';
import { aggregateCoverage, classifyCoverage, componentTotals, COVERAGE_VERSION, paymentComponentSignature, paymentTypeSignature } from '../src/business-resolution-coverage.js';

const outputDir = process.argv[2] ?? 'artifacts/business-resolution-coverage';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const round = (value) => Math.round(Number(value || 0) * 100) / 100;
const add = (a, b) => round(Number(a || 0) + Number(b || 0));
const key = (parts) => parts.map((value) => value ?? '').join('|');
const sameItems = (a, b) => JSON.stringify((a ?? []).map((x) => [x.name, x.quantity, x.price, x.itemSum, x.providerInn, x.gtin, x.rawProductCode])) === JSON.stringify((b ?? []).map((x) => [x.name, x.quantity, x.price, x.itemSum, x.providerInn, x.gtin, x.rawProductCode]));
const appendToMapList = (map, mapKey, value) => {
  const list = map.get(mapKey) ?? [];
  list.push(value);
  map.set(mapKey, list);
};

async function writeJson(name, value) { await writeFile(`${outputDir}/${name}`, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' }); }

try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const receiptRows = (await client.query(`
    SELECT r.id, r.operation_type, r.total_sum, r.date_time, r.seller_inn, r.currency,
           f.receipt_id, f.normalization_status, f.normalization_version, f.ffd_version,
           f.fiscal_operation_type, f.cash_total_sum, f.ecash_total_sum, f.prepaid_sum,
           f.credit_sum, f.provision_sum, f.cash_total_state, f.ecash_total_state,
           f.prepaid_state, f.credit_state, f.provision_state, f.payment_components_status,
           f.payment_stage, f.correction_status
    FROM receipts r
    LEFT JOIN receipt_fiscal_facts f ON f.receipt_id=r.id AND f.normalization_version=$1
    ORDER BY r.id`, [NORMALIZED_FACT_VERSION])).rows.map((row) => ({
      ...row,
      fact: {
        ...row,
        totalSum: row.total_sum,
        normalizationStatus: row.normalization_status,
        ffdVersion: row.ffd_version,
        fiscalOperationType: row.fiscal_operation_type,
        cashTotalSum: row.cash_total_sum,
        ecashTotalSum: row.ecash_total_sum,
        prepaidSum: row.prepaid_sum,
        creditSum: row.credit_sum,
        provisionSum: row.provision_sum,
        cashTotalState: row.cash_total_state,
        ecashTotalState: row.ecash_total_state,
        prepaidState: row.prepaid_state,
        creditState: row.credit_state,
        provisionState: row.provision_state,
        paymentComponentsStatus: row.payment_components_status,
        paymentStage: row.payment_stage,
        correctionStatus: row.correction_status,
      },
    }));
  const itemRows = (await client.query(`
    SELECT i.receipt_id, i.position, i.name, i.quantity, i.price, i.item_sum,
           f.payment_type_code, f.payment_type_semantic, f.product_type_code,
           f.provider_inn, f.gtin, f.raw_product_code
    FROM receipt_items i
    LEFT JOIN receipt_item_fiscal_facts f ON f.receipt_item_id=i.id AND f.normalization_version=$1
    ORDER BY i.receipt_id, i.position`, [NORMALIZED_FACT_VERSION])).rows;
  const itemsByReceipt = new Map();
  for (const item of itemRows) appendToMapList(itemsByReceipt, String(item.receipt_id), item);
  const graphRows = (await client.query(`
    SELECT e.receipt_id, b.id AS event_id, b.event_type, b.resolution_status, b.origin,
           b.graph_model_version, b.rule_code, b.rule_version, e.evidence_role
    FROM business_event_evidence e JOIN business_events b ON b.id=e.event_id
    WHERE e.receipt_id IS NOT NULL ORDER BY e.receipt_id,b.id`)).rows;
  const evidenceByReceipt = new Map();
  for (const row of graphRows) appendToMapList(evidenceByReceipt, String(row.receipt_id), row);
  const matcherRows = (await client.query(MATCHER_RECEIPTS_SQL, [NORMALIZED_FACT_VERSION])).rows.map((row) => ({ ...row, scopeKey: 'default' }));
  const matcher = matchPrepaymentSettlements(matcherRows, { scopeKey: 'default' });
  const settlementById = new Map(matcher.settlements.map((row) => [String(row.settlementReceiptId), row]));
  const confirmedPairs = matcher.candidates.filter((pair) => pair.confirmed === true);
  const strictBySettlement = new Map();
  for (const pair of matcher.candidates.filter((pair) => pair.strict)) (strictBySettlement.get(String(pair.settlementReceiptId)) ?? strictBySettlement.set(String(pair.settlementReceiptId), []).get(String(pair.settlementReceiptId))).push(pair);
  const candidateByReceipt = new Map();
  for (const pair of matcher.candidates.filter((pair) => pair.research)) {
    for (const id of [pair.prepaymentReceiptId, pair.settlementReceiptId]) appendToMapList(candidateByReceipt, String(id), pair);
  }
  const graphConfirmed = new Set(graphRows.filter((row) => row.resolution_status === 'CONFIRMED').map((row) => String(row.receipt_id)));
  const receiptById = new Map(matcherRows.map((row) => [String(row.id), row]));

  const returnCandidates = [];
  const returnStateById = new Map();
  for (const row of receiptRows.filter((r) => Number(r.operation_type) === 2)) {
    const currentItems = itemsByReceipt.get(String(row.id)) ?? [];
    const candidates = receiptRows.filter((sale) => Number(sale.operation_type) === 1 && sale.seller_inn === row.seller_inn && Number(sale.total_sum) === Number(row.total_sum) && new Date(sale.date_time).getTime() < new Date(row.date_time).getTime());
    const exact = candidates.filter((sale) => sameItems(currentItems, itemsByReceipt.get(String(sale.id)) ?? []));
    const partial = candidates.filter((sale) => (itemsByReceipt.get(String(sale.id)) ?? []).some((item) => currentItems.some((returned) => returned.name === item.name)));
    const state = exact.length === 1 ? 'EXACT_UNIQUE' : (exact.length > 1 ? 'AMBIGUOUS' : (partial.length ? 'PARTIAL' : 'UNMATCHED'));
    returnStateById.set(String(row.id), state);
    returnCandidates.push({ receiptId: row.id, state, exactCandidateCount: exact.length, partialCandidateCount: partial.length, candidateReceiptIds: [...new Set([...exact, ...partial].map((candidate) => candidate.id))].slice(0, 10) });
  }

  const coverage = [];
  for (const row of receiptRows) {
    const id = String(row.id);
    const fact = row.fact;
    const settlement = settlementById.get(id);
    const strictPairs = strictBySettlement.get(id) ?? [];
    const returnState = returnStateById.get(id);
    let matcherState = null;
    let scenarioClass = null;
    if (settlement?.status === 'AMBIGUOUS' || (strictPairs.length && strictPairs.some((pair) => pair.confirmed === false))) matcherState = 'AMBIGUOUS';
    else if (settlement?.status === 'CANDIDATE' || candidateByReceipt.has(id)) matcherState = 'CANDIDATE';
    if (settlement?.status === 'AMBIGUOUS') scenarioClass = 'PREPAYMENT_AMBIGUOUS';
    else if (settlement?.status === 'CANDIDATE') scenarioClass = 'PREPAYMENT_CANDIDATE';
    if (Number(row.operation_type) === 2) scenarioClass = null;
    if (fact.payment_stage === 'ADVANCE_ONLY' && matcherState === 'CANDIDATE') scenarioClass = 'ADVANCE_WITH_POSSIBLE_SETTLEMENT';
    if (fact.payment_stage === 'ADVANCE_ONLY' && graphConfirmed.has(id)) scenarioClass = 'PREPAYMENT_SETTLEMENT_CONFIRMED';
    const classification = classifyCoverage({ operationType: row.operation_type, fact }, { graphConfirmed: graphConfirmed.has(id), confirmedScenario: scenarioClass ?? (fact.payment_stage === 'ADVANCE_ONLY' ? 'PREPAYMENT_SETTLEMENT_CONFIRMED' : undefined), matcherState, scenarioClass, returnState, unknownSignature: `${row.operation_type}|${row.ffd_version}|${fact.payment_stage}` });
    coverage.push({ receiptId: row.id, state: classification.state, scenarioClass: classification.scenarioClass, operationType: row.operation_type, totalSum: row.total_sum, fact, items: itemsByReceipt.get(id) ?? [], graphEvidence: evidenceByReceipt.get(id) ?? [], matcherCandidateCount: (candidateByReceipt.get(id) ?? []).length });
  }
  const states = new Map(coverage.map((row) => [row.receiptId, row.state]));
  const stateCounts = Object.fromEntries(Object.entries(aggregateCoverage(coverage)).map(([state, value]) => [state, Object.fromEntries(Object.entries(value).map(([keyName, amount]) => [keyName, round(amount)]))]));
  const scenarios = {};
  for (const row of coverage) {
    const bucket = scenarios[row.scenarioClass] ?? { scenarioClass: row.scenarioClass, states: {}, receipts: 0, fiscalFaceValue: 0, newMoney: 0, prepaidUsed: 0, creditUsed: 0, provisionUsed: 0, sampleReceiptIds: [] };
    const totals = componentTotals({ ...row.fact, totalSum: row.totalSum });
    bucket.receipts += 1;
    bucket.states[row.state] = (bucket.states[row.state] ?? 0) + 1;
    bucket.fiscalFaceValue = add(bucket.fiscalFaceValue, totals.fiscalFaceValue);
    bucket.newMoney = add(bucket.newMoney, totals.newMoney);
    bucket.prepaidUsed = add(bucket.prepaidUsed, totals.prepaidUsed);
    bucket.creditUsed = add(bucket.creditUsed, totals.creditUsed);
    bucket.provisionUsed = add(bucket.provisionUsed, totals.provisionUsed);
    if (bucket.sampleReceiptIds.length < 5) bucket.sampleReceiptIds.push(row.receiptId);
    scenarios[row.scenarioClass] = bucket;
  }
  const paymentSignatures = {}, componentSignatures = {}, unknownGroups = {};
  const reconciliationViolations = [];
  for (const row of coverage) {
    const paymentSignature = paymentTypeSignature(row.items.map((item) => ({ paymentTypeCode: item.payment_type_code })));
    const componentSignature = paymentComponentSignature(row.fact);
    for (const [map, signature] of [[paymentSignatures, paymentSignature], [componentSignatures, componentSignature]]) {
      const bucket = map[signature] ?? { signature, receipts: 0, fiscalFaceValue: 0, newMoney: 0, states: {}, scenarioClasses: {}, sampleReceiptIds: [] };
      const totals = componentTotals({ ...row.fact, totalSum: row.totalSum });
      bucket.receipts += 1; bucket.fiscalFaceValue = add(bucket.fiscalFaceValue, totals.fiscalFaceValue); bucket.newMoney = add(bucket.newMoney, totals.newMoney); bucket.states[row.state] = (bucket.states[row.state] ?? 0) + 1; bucket.scenarioClasses[row.scenarioClass] = (bucket.scenarioClasses[row.scenarioClass] ?? 0) + 1; if (bucket.sampleReceiptIds.length < 5) bucket.sampleReceiptIds.push(row.receiptId); map[signature] = bucket;
    }
    const totals = componentTotals({ ...row.fact, totalSum: row.totalSum });
    if (totals.componentSum !== null && Math.abs(totals.componentSum - totals.fiscalFaceValue) > 0.005) reconciliationViolations.push({ receiptId: row.receiptId, fiscalFaceValue: totals.fiscalFaceValue, componentSum: totals.componentSum });
    if (row.state === 'UNKNOWN_PATTERN') {
      const signature = `${row.operationType}|${row.fact.ffd_version}|${paymentSignature}|${componentSignature}|items=${row.items.length}|stage=${row.fact.payment_stage}|graph=${row.graphEvidence.length > 0}`;
      const bucket = unknownGroups[signature] ?? { signature, receipts: 0, fiscalFaceValue: 0, newMoney: 0, sampleReceiptIds: [], sellers: new Set(), minDate: null, maxDate: null };
      const totals = componentTotals({ ...row.fact, totalSum: row.totalSum }); bucket.receipts += 1; bucket.fiscalFaceValue = add(bucket.fiscalFaceValue, totals.fiscalFaceValue); bucket.newMoney = add(bucket.newMoney, totals.newMoney); bucket.sellers.add(row.fact.seller_inn); bucket.minDate = !bucket.minDate || row.fact.date_time < bucket.minDate ? row.fact.date_time : bucket.minDate; bucket.maxDate = !bucket.maxDate || row.fact.date_time > bucket.maxDate ? row.fact.date_time : bucket.maxDate; if (bucket.sampleReceiptIds.length < 5) bucket.sampleReceiptIds.push(row.receiptId); unknownGroups[signature] = bucket;
    }
  }
  const graphValidator = await validateBusinessEventGraph(client);
  const lifecycleCount = Number((await client.query(`SELECT count(*)::int AS count FROM business_events WHERE event_type='PURCHASE' AND resolution_status='CONFIRMED' AND rule_code=$1`, [PREPAYMENT_SETTLEMENT_RULE])).rows[0].count);
  const evidenceCoverage = coverage.filter((row) => row.graphEvidence.length > 0).length;
  const confirmedReceiptCoverage = coverage.filter((row) => row.state === 'CONFIRMED').length;
  const confirmedPrepayments = new Set(confirmedPairs.map((pair) => String(pair.prepaymentReceiptId)));
  const confirmedSettlements = new Set(confirmedPairs.map((pair) => String(pair.settlementReceiptId)));
  const matcherCensus = { rule: PREPAYMENT_SETTLEMENT_RULE, matcherVersion: MATCHER_VERSION, summary: matcher.summary, distinctConfirmedPrepayments: confirmedPrepayments.size, distinctConfirmedSettlements: confirmedSettlements.size, reusedConfirmedPrepayments: confirmedPairs.length - confirmedPrepayments.size, confirmedPairs: confirmedPairs.length, monetary: { fiscalFaceValue: 0, newMoney: 0 } };
  for (const pair of confirmedPairs) { const row = receiptById.get(String(pair.prepaymentReceiptId)); const totals = row ? componentTotals(row) : {}; matcherCensus.monetary.fiscalFaceValue = add(matcherCensus.monetary.fiscalFaceValue, totals.fiscalFaceValue); matcherCensus.monetary.newMoney = add(matcherCensus.monetary.newMoney, totals.newMoney); }
  const exposureStates = ['AMBIGUOUS', 'CANDIDATE_ONLY', 'UNRESOLVED', 'UNKNOWN_PATTERN', 'BLOCKED'];
  const unresolvedExposure = Object.fromEntries(exposureStates.map((state) => [state, stateCounts[state]]));
  const unknownOutput = Object.values(unknownGroups).map((bucket) => ({ ...bucket, sellers: bucket.sellers.size })).sort((a, b) => b.fiscalFaceValue - a.fiscalFaceValue || b.receipts - a.receipts);
  await mkdir(outputDir, { recursive: true });
  await writeJson('summary.json', { coverageVersion: COVERAGE_VERSION, generatedAt: new Date().toISOString(), schemaMigrations: (await client.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map((row) => row.filename), corpus: { receipts: coverage.length, items: itemRows.length }, states: stateCounts, graphEvidenceCoverage: { receipts: evidenceCoverage, percent: round(evidenceCoverage / coverage.length * 100), confirmedBusinessLifecycleReceipts: confirmedReceiptCoverage, percentConfirmed: round(confirmedReceiptCoverage / coverage.length * 100), distinctConfirmedBusinessLifecycles: lifecycleCount }, matcher: matcherCensus, unresolvedExposure, operationTypes: Object.fromEntries([1, 2, 3, 4].map((operationType) => [operationType, aggregateCoverage(coverage.filter((row) => Number(row.operationType) === operationType))])), paymentComponentReconciliation: { violations: reconciliationViolations.length, samples: reconciliationViolations.slice(0, 20) }, graphValidator, invariants: { everyReceiptExactlyOnce: new Set(coverage.map((row) => row.receiptId)).size === coverage.length && coverage.length === receiptRows.length, classifiedStateCount: coverage.length, duplicateSourceIdentity: Number((await client.query('SELECT count(*)::int AS count FROM (SELECT fns_id FROM receipts GROUP BY fns_id HAVING count(*)>1) q')).rows[0].count), duplicateCanonicalTuple: Number((await client.query('SELECT count(*)::int AS count FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL AND fiscal_document_number IS NOT NULL AND fiscal_sign IS NOT NULL GROUP BY 1,2,3 HAVING count(*)>1) q')).rows[0].count), accountingMutations: false } });
  await writeJson('scenarios.json', Object.values(scenarios).sort((a, b) => b.fiscalFaceValue - a.fiscalFaceValue));
  await writeJson('unknown-patterns.json', unknownOutput);
  await writeJson('return-candidates.json', { summary: { totalReturns: returnCandidates.length, exactUnique: returnCandidates.filter((row) => row.state === 'EXACT_UNIQUE').length, ambiguous: returnCandidates.filter((row) => row.state === 'AMBIGUOUS').length, partial: returnCandidates.filter((row) => row.state === 'PARTIAL').length, unmatched: returnCandidates.filter((row) => row.state === 'UNMATCHED').length }, candidates: returnCandidates });
  await writeJson('advance-candidates.json', coverage.filter((row) => row.fact.payment_stage === 'ADVANCE_ONLY').map((row) => ({ receiptId: row.receiptId, state: row.state, scenarioClass: row.scenarioClass, candidateCount: row.matcherCandidateCount, totalSum: row.totalSum, itemNames: row.items.map((item) => item.name).slice(0, 10) })));
  await writeJson('payment-signatures.json', Object.values(paymentSignatures).sort((a, b) => b.fiscalFaceValue - a.fiscalFaceValue));
  await writeJson('component-signatures.json', Object.values(componentSignatures).sort((a, b) => b.fiscalFaceValue - a.fiscalFaceValue));
  console.log(JSON.stringify({ coverageVersion: COVERAGE_VERSION, corpus: coverage.length, states: stateCounts, matcher: matcherCensus, graphEvidenceCoverage: evidenceCoverage, confirmedLifecycles: lifecycleCount, returnSummary: { total: returnCandidates.length, exactUnique: returnCandidates.filter((r) => r.state === 'EXACT_UNIQUE').length, ambiguous: returnCandidates.filter((r) => r.state === 'AMBIGUOUS').length, partial: returnCandidates.filter((r) => r.state === 'PARTIAL').length, unmatched: returnCandidates.filter((r) => r.state === 'UNMATCHED').length }, advanceReceipts: coverage.filter((r) => r.fact.payment_stage === 'ADVANCE_ONLY').length, unknownGroups: unknownOutput.length, graphValidator: graphValidator.ok }));
  await client.query('COMMIT');
} catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await pool.end(); }

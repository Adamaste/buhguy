import { fiscalContentFingerprint } from './fiscal-evidence.js';

export const CERTIFICATION_MODEL_VERSION = 'reconciliation-certification-v1';
export const CERTIFICATION_RULE_VERSION = 'certification-rules-v1';
export const CERTIFICATION_SOURCE_STATE_OVERRIDE = 'CERTIFICATION_SOURCE_STATE_OVERRIDE';

const MONEY_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;

function moneyMinorUnits(value) {
  if (value === null || value === undefined || value === '') return 0n;
  const text = String(value);
  if (!MONEY_PATTERN.test(text)) throw new Error(`Invalid NUMERIC(18,2) amount: ${text}`);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const minor = (BigInt(whole) * 100n) + BigInt(fraction.padEnd(2, '0'));
  return negative ? -minor : minor;
}

function money(value) {
  const minor = typeof value === 'bigint' ? value : moneyMinorUnits(value);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
const inPeriod = (value, from, to) => (!from || new Date(value) >= new Date(from)) && (!to || new Date(value) < new Date(to));

async function sourceState(pool, scopeId) {
  const counts = (await pool.query(`SELECT
    (SELECT count(*) FROM receipts) AS receipts,
    (SELECT count(*) FROM receipt_items) AS items,
    (SELECT count(*) FROM receipt_raw) AS raw,
    (SELECT count(*) FROM business_events WHERE scope_id=$1) AS events,
    (SELECT count(*) FROM business_event_evidence ev JOIN business_events e ON e.id=ev.event_id WHERE e.scope_id=$1) AS evidence,
    (SELECT count(*) FROM business_event_edges WHERE scope_id=$1) AS edges,
    (SELECT count(*) FROM business_event_allocations WHERE scope_id=$1) AS allocations`, [scopeId])).rows[0];
  const entries = (await pool.query(`SELECT e.id,e.scope_id,e.source_event_id,e.currency,e.event_at,e.semantic_key,
      e.derivation_rule,e.derivation_version,e.derivation_status,e.certification_status,e.origin,e.reason_code,e.description
    FROM ledger_entries e
    WHERE e.scope_id=$1
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)
    ORDER BY e.id`, [scopeId])).rows;
  const postings = (await pool.query(`SELECT p.ledger_entry_id,p.account_id,p.currency,p.debit,p.credit,
      p.source_allocation_id,p.source_receipt_id
    FROM ledger_postings p
    JOIN ledger_entries e ON e.id=p.ledger_entry_id
    WHERE e.scope_id=$1
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)
    ORDER BY p.ledger_entry_id,p.id`, [scopeId])).rows;
  const links = (await pool.query(`SELECT l.ledger_entry_id,l.business_event_id,l.graph_evidence_id,
      l.graph_allocation_id,l.receipt_id,l.normalization_version,l.link_role,l.semantic_key,l.bank_receipt_match_id,l.bank_transaction_id
    FROM ledger_source_links l
    JOIN ledger_entries e ON e.id=l.ledger_entry_id
    WHERE e.scope_id=$1
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)
    ORDER BY l.ledger_entry_id,l.id`, [scopeId])).rows;
  const supersessions = (await pool.query(`SELECT scope_id,superseded_ledger_entry_id,
      replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code
    FROM ledger_entry_supersessions
    WHERE scope_id=$1
    ORDER BY id`, [scopeId])).rows;
  return fiscalContentFingerprint({
    scopeId: Number(scopeId),
    certificationModelVersion: CERTIFICATION_MODEL_VERSION,
    counts,
    activeEntries: entries,
    activePostings: postings,
    activeLinks: links,
    supersessions,
  });
}

export async function certificationSourceStateKey(pool, scopeId) {
  return sourceState(pool, scopeId);
}

async function loadInputs(pool, scopeKey, eventIds = null) {
  const scope = (await pool.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
  if (!scope) throw new Error(`Accounting scope not found: ${scopeKey}`);
  const filter = eventIds?.length ? ' AND e.source_event_id = ANY($2::bigint[])' : '';
  const params = eventIds?.length ? [scope.id, eventIds] : [scope.id];
  const entries = (await pool.query(`SELECT e.*,b.event_type,b.rule_code,b.rule_version,b.amount AS event_amount
    FROM ledger_entries e JOIN business_events b ON b.id=e.source_event_id
    WHERE e.scope_id=$1
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)${filter} ORDER BY e.id`, params)).rows;
  const postings = (await pool.query(`SELECT p.*,a.account_code FROM ledger_postings p JOIN ledger_entries e ON e.id=p.ledger_entry_id JOIN ledger_accounts a ON a.id=p.account_id WHERE e.scope_id=$1 AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)${filter} ORDER BY p.id`, params)).rows;
  const links = (await pool.query(`SELECT l.*,ev.event_id FROM ledger_source_links l JOIN ledger_entries e ON e.id=l.ledger_entry_id LEFT JOIN business_event_evidence ev ON ev.id=l.graph_evidence_id WHERE e.scope_id=$1 AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)${filter} ORDER BY l.id`, params)).rows;
  return { scope, entries, postings, links };
}

const certificationConflict = (message) => Object.assign(new Error(message), { code: 'CERTIFICATION_CONFLICT' });
const certificationSourceStateOverride = () => Object.assign(
  new Error('Caller-provided sourceStateKey is not allowed for persistent certification'),
  { code: CERTIFICATION_SOURCE_STATE_OVERRIDE },
);

const canonicalValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  return String(value);
};

const canonicalRows = (rows, fields) => rows
  .map((row) => fields.reduce((result, field) => ({ ...result, [field]: canonicalValue(row[field]) }), {}))
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

const FACT_FIELDS = ['run_id', 'scope_id', 'subject_type', 'subject_id', 'metric_code', 'dimension', 'status', 'amount', 'currency', 'event_at', 'reason_code', 'rule_code', 'rule_version', 'ledger_entry_id', 'business_event_id', 'graph_evidence_id', 'semantic_key', 'source_state_key'];
const RESULT_FIELDS = ['run_id', 'metric_code', 'status', 'amount', 'currency', 'count_items', 'reason_code', 'semantic_key'];

export function certificationResultSemanticKey(result, runId) {
  return fiscalContentFingerprint({
    metricCode: result.metricCode ?? result.metric_code,
    status: result.status,
    amount: result.amount,
    currency: result.currency,
    countItems: result.countItems ?? result.count_items,
    reasonCode: result.reasonCode ?? result.reason_code,
    runId: Number(runId),
  });
}

const resultSemanticKey = certificationResultSemanticKey;

async function insertFacts(client, runId, facts) {
  for (const fact of facts) await client.query(`INSERT INTO certification_facts(run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(semantic_key) DO UPDATE SET run_id=EXCLUDED.run_id,status=EXCLUDED.status,amount=EXCLUDED.amount`, [runId, fact.scopeId, fact.subjectType, fact.subjectId, fact.metricCode, fact.dimension, fact.status, fact.amount, fact.currency, fact.eventAt, fact.reasonCode, fact.ruleCode, fact.ruleVersion, fact.ledgerEntryId, fact.businessEventId, fact.graphEvidenceId, fact.semanticKey, fact.sourceStateKey]);
}

function expectedFactRows(runId, facts) {
  return facts.map((fact) => ({
    run_id: runId,
    scope_id: fact.scopeId,
    subject_type: fact.subjectType,
    subject_id: fact.subjectId,
    metric_code: fact.metricCode,
    dimension: fact.dimension,
    status: fact.status,
    amount: fact.amount,
    currency: fact.currency,
    event_at: fact.eventAt,
    reason_code: fact.reasonCode,
    rule_code: fact.ruleCode,
    rule_version: fact.ruleVersion,
    ledger_entry_id: fact.ledgerEntryId,
    business_event_id: fact.businessEventId,
    graph_evidence_id: fact.graphEvidenceId,
    semantic_key: fact.semanticKey,
    source_state_key: fact.sourceStateKey,
  }));
}

function expectedResultRows(runId, results) {
  return results.map((result) => ({
    run_id: runId,
    metric_code: result.metricCode,
    status: result.status,
    amount: result.amount,
    currency: result.currency,
    count_items: result.countItems,
    reason_code: result.reasonCode,
    semantic_key: resultSemanticKey(result, runId),
  }));
}

function certificationSnapshotMatches(runId, facts, results, persistedFacts, persistedResults) {
  return JSON.stringify(canonicalRows(persistedFacts, FACT_FIELDS))
    === JSON.stringify(canonicalRows(expectedFactRows(runId, facts), FACT_FIELDS))
    && JSON.stringify(canonicalRows(persistedResults, RESULT_FIELDS))
    === JSON.stringify(canonicalRows(expectedResultRows(runId, results), RESULT_FIELDS));
}

export async function refreshCertificationForEvents(pool, { scopeKey = 'default', eventIds = [], client: transactionClient = null } = {}) {
  if (!eventIds.length) return { bounded: true, eventIds: [], facts: 0 };
  const client = transactionClient ?? await pool.connect();
  const ownsTransaction = !transactionClient;
  try {
    if (ownsTransaction) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1 FOR UPDATE', [scopeKey])).rows[0];
    if (!scope) throw new Error(`Accounting scope not found: ${scopeKey}`);
    const sourceStateKey = await sourceState(client, scope.id);
    const completeInput = await loadInputs(client, scopeKey);
    const facts = deriveCertificationFacts({ ...completeInput, sourceStateKey });
    const results = aggregateFacts(facts);
    const existing = (await client.query(`SELECT * FROM reconciliation_runs
      WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
        AND period_from IS NULL AND period_to IS NULL
      FOR UPDATE`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey])).rows[0];
    if (existing) {
      if (existing.status !== 'READY') throw certificationConflict(`Certification run ${existing.id} is not READY`);
      const persistedFacts = (await client.query(`SELECT run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key FROM certification_facts WHERE run_id=$1`, [existing.id])).rows;
      const persistedResults = (await client.query(`SELECT run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key FROM reconciliation_results WHERE run_id=$1`, [existing.id])).rows;
      if (existing.status !== 'READY' || !existing.finished_at
        || !certificationSnapshotMatches(existing.id, facts, results, persistedFacts, persistedResults)) {
        throw certificationConflict(`Certification snapshot ${existing.id} does not match source state ${sourceStateKey}`);
      }
      if (ownsTransaction) await client.query('COMMIT');
      return { bounded: true, eventIds, facts: facts.length, runId: Number(existing.id), sourceStateKey, reused: true, refreshed: false };
    }
    const run = (await client.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,finished_at) VALUES($1,$2,$3,'READY',NOW()) RETURNING id`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey])).rows[0];
    await insertFacts(client, run.id, facts);
    for (const result of results) await client.query(`INSERT INTO reconciliation_results(run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [run.id, result.metricCode, result.status, result.amount, result.currency, result.countItems, result.reasonCode, resultSemanticKey(result, run.id)]);
    if (ownsTransaction) await client.query('COMMIT');
    return { bounded: true, eventIds, facts: facts.length, runId: Number(run.id), sourceStateKey, reused: false, refreshed: true };
  } catch (error) { if (ownsTransaction) await client.query('ROLLBACK'); throw error; } finally { if (ownsTransaction) client.release(); }
}

export function deriveCertificationFacts({ entries, postings, links, sourceStateKey, from = null, to = null }) {
  const facts = [];
  const periodIdentity = from !== null || to !== null
    ? { periodFrom: from, periodTo: to }
    : {};
  const byEntry = new Map();
  for (const posting of postings) byEntry.set(Number(posting.ledger_entry_id), [...(byEntry.get(Number(posting.ledger_entry_id)) ?? []), posting]);
  const linkByEntry = new Map();
  for (const link of links) linkByEntry.set(Number(link.ledger_entry_id), [...(linkByEntry.get(Number(link.ledger_entry_id)) ?? []), link]);
  const add = (entry, metricCode, dimension, status, amount, reasonCode, subjectType = 'LEDGER_ENTRY') => {
    if (!inPeriod(entry.event_at, from, to)) return;
    const link = (linkByEntry.get(Number(entry.id)) ?? [])[0];
    facts.push({
      scopeId: Number(entry.scope_id), subjectType, subjectId: Number(entry.id), metricCode, dimension, status,
      amount: money(amount), currency: entry.currency, eventAt: entry.event_at, reasonCode,
      ruleCode: entry.derivation_rule, ruleVersion: CERTIFICATION_RULE_VERSION, ledgerEntryId: Number(entry.id),
      businessEventId: Number(entry.source_event_id), graphEvidenceId: link?.graph_evidence_id ?? null, sourceStateKey,
      semanticKey: fiscalContentFingerprint({ sourceStateKey, entryId: entry.id, metricCode, dimension, status, amount: money(amount), ...periodIdentity }),
    });
  };
  for (const entry of entries) {
    const entryPostings = byEntry.get(Number(entry.id)) ?? [];
    const debit = (code) => entryPostings.filter((p) => p.account_code === code).reduce((sum, p) => sum + moneyMinorUnits(p.debit), 0n);
    const credit = (code) => entryPostings.filter((p) => p.account_code === code).reduce((sum, p) => sum + moneyMinorUnits(p.credit), 0n);
    if (entry.derivation_status === 'BLOCKED') {
      add(entry, 'BLOCKED_EXPOSURE', 'BUSINESS_CERTIFICATION', 'BLOCKED', moneyMinorUnits(entry.event_amount), entry.reason_code ?? 'BLOCKED_LEDGER_ENTRY');
      continue;
    }
    if (entry.derivation_status !== 'READY') continue;
    if (entry.derivation_rule === 'LEDGER_PREPAYMENT_V1') {
      add(entry, 'FISCAL_NEW_MONEY', 'FUNDING_CERTIFICATION', 'PROVISIONAL', credit('FISCAL_PAYMENT_CLEARING'), 'FUNDING_UNRECONCILED');
    } else if (entry.derivation_rule === 'LEDGER_FULFILLMENT_V1') {
      add(entry, 'CONFIRMED_ACQUISITION_VALUE', 'BUSINESS_CERTIFICATION', 'CERTIFIED', debit('UNCLASSIFIED_ACQUISITION'), 'BUSINESS_GRAPH_CONFIRMED');
      add(entry, 'ACQUISITION_CLASSIFICATION', 'CLASSIFICATION_CERTIFICATION', 'PROVISIONAL', debit('UNCLASSIFIED_ACQUISITION'), 'UNCLASSIFIED_ACQUISITION');
    } else if (entry.derivation_rule === 'LEDGER_STANDALONE_PURCHASE_V1') {
      add(entry, 'CONFIRMED_ACQUISITION_VALUE', 'BUSINESS_CERTIFICATION', 'CERTIFIED', debit('UNCLASSIFIED_ACQUISITION'), 'BUSINESS_GRAPH_CONFIRMED');
      add(entry, 'ACQUISITION_CLASSIFICATION', 'CLASSIFICATION_CERTIFICATION', 'PROVISIONAL', debit('UNCLASSIFIED_ACQUISITION'), 'UNCLASSIFIED_ACQUISITION');
      add(entry, 'FISCAL_NEW_MONEY', 'FUNDING_CERTIFICATION', 'PROVISIONAL', credit('FISCAL_PAYMENT_CLEARING'), 'FUNDING_UNRECONCILED');
    } else if (entry.derivation_rule === 'LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1') {
      add(entry, 'CONFIRMED_ACQUISITION_VALUE', 'BUSINESS_CERTIFICATION', 'CERTIFIED', debit('UNCLASSIFIED_ACQUISITION'), 'BUSINESS_GRAPH_CONFIRMED');
      add(entry, 'ACQUISITION_CLASSIFICATION', 'CLASSIFICATION_CERTIFICATION', 'PROVISIONAL', debit('UNCLASSIFIED_ACQUISITION'), 'UNCLASSIFIED_ACQUISITION');
    } else if (entry.derivation_rule === 'LEDGER_RETURN_V1') {
      add(entry, 'CONFIRMED_RETURN_VALUE', 'BUSINESS_CERTIFICATION', 'CERTIFIED', credit('UNCLASSIFIED_ACQUISITION'), 'BUSINESS_GRAPH_CONFIRMED');
      add(entry, 'OUTSTANDING_REFUND_RECEIVABLE', 'BUSINESS_CERTIFICATION', 'CERTIFIED', debit('MERCHANT_REFUND_RECEIVABLE'), 'REFUND_NOT_YET_PROVEN');
    }
  }
  return facts;
}

export function aggregateCertificationFacts(facts) {
  const result = new Map();
  for (const fact of facts) {
    const key = `${fact.metricCode}|${fact.status}|${fact.reasonCode}|${fact.currency ?? ''}`;
    const current = result.get(key) ?? { metricCode: fact.metricCode, status: fact.status, amount: 0n, currency: fact.currency, countItems: 0, reasonCode: fact.reasonCode };
    current.amount += moneyMinorUnits(fact.amount); current.countItems += 1; result.set(key, current);
  }
  return [...result.values()].map((item) => { const amount = money(item.amount); return { ...item, amount, semanticKey: fiscalContentFingerprint({ ...item, amount }) }; });
}

export function summarizeCertificationTotals(results, balances = {}) {
  const byMetric = {};
  for (const result of results ?? []) byMetric[result.metricCode] = [...(byMetric[result.metricCode] ?? []), result];

  const summarize = (metricCode, status) => {
    const rows = byMetric[metricCode] ?? [];
    const currencies = [...new Set(rows.map((row) => row.currency).filter(Boolean))].sort();
    if (currencies.length > 1) {
      return { amount: null, status: 'BLOCKED', reason: 'MULTI_CURRENCY_REQUIRES_SEPARATE_REPORT', currency: null };
    }
    return {
      amount: money(rows.reduce((sum, row) => sum + moneyMinorUnits(row.amount), 0n)),
      status,
      currency: currencies[0] ?? null,
    };
  };

  const acquisition = summarize('CONFIRMED_ACQUISITION_VALUE', 'CERTIFIED');
  const returns = summarize('CONFIRMED_RETURN_VALUE', 'CERTIFIED');
  const currencyConflict = acquisition.currency && returns.currency && acquisition.currency !== returns.currency;
  const net = currencyConflict || acquisition.status === 'BLOCKED' || returns.status === 'BLOCKED'
    ? { amount: null, status: 'BLOCKED', reason: 'MULTI_CURRENCY_REQUIRES_SEPARATE_REPORT', currency: null }
    : {
      amount: money(moneyMinorUnits(acquisition.amount) - moneyMinorUnits(returns.amount)),
      status: acquisition.status === 'CERTIFIED' && returns.status === 'CERTIFIED' ? 'CERTIFIED' : 'BLOCKED',
      currency: acquisition.currency ?? returns.currency,
    };

  const metric = (code, status, reason = undefined) => {
    const item = summarize(code, status);
    return reason === undefined ? item : { ...item, reason };
  };
  return {
    confirmedAcquisitionValue: acquisition,
    confirmedReturnValue: returns,
    netConfirmedAcquisition: net,
    fiscalNewMoney: metric('FISCAL_NEW_MONEY', 'PROVISIONAL', 'FUNDING_UNRECONCILED'),
    merchantAdvanceBalance: { amount: money(balances.merchantAdvance ?? '0.00'), status: 'CERTIFIED', reason: 'BUSINESS_ADVANCE_RECONCILED' },
    outstandingRefundReceivable: metric('OUTSTANDING_REFUND_RECEIVABLE', 'CERTIFIED'),
    blockedExposure: metric('BLOCKED_EXPOSURE', 'BLOCKED'),
  };
}

const aggregateFacts = aggregateCertificationFacts;

export async function rebuildCertification(pool, { scopeKey = 'default', from = null, to = null, persist = false, replace = false, reuseUnchanged = false, failAfter = null, sourceStateKey: providedSourceStateKey = null } = {}) {
  if ((persist || replace) && providedSourceStateKey !== null) throw certificationSourceStateOverride();
  let { scope, entries, postings, links } = await loadInputs(pool, scopeKey);
  // Read-only snapshot callers already computed this key in the same transaction.
  // Reuse it so validation cannot observe a second, logically different state.
  const sourceStateKey = providedSourceStateKey ?? await sourceState(pool, scope.id);
  const facts = deriveCertificationFacts({ entries, postings, links, sourceStateKey, from, to });
  const results = aggregateFacts(facts);
  let merchantAdvanceBalance = postings.filter((p) => p.account_code === 'MERCHANT_ADVANCE').reduce((sum, p) => sum + moneyMinorUnits(p.debit) - moneyMinorUnits(p.credit), 0n);
  if (!persist) return { model: CERTIFICATION_MODEL_VERSION, sourceStateKey, facts, results, balances: { merchantAdvance: money(merchantAdvanceBalance) } };
  const client = await pool.connect();
  try {
    // Persistent certification must serialize with source mutations so a
    // source change cannot commit around the final no-op decision.
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const transactionScope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1 FOR UPDATE', [scopeKey])).rows[0];
    if (!transactionScope) throw new Error(`Accounting scope not found: ${scopeKey}`);
    const transactionInputs = await loadInputs(client, scopeKey);
    const transactionSourceStateKey = await sourceState(client, transactionScope.id);
    if (transactionSourceStateKey !== sourceStateKey) throw certificationConflict('Source state changed before certification persistence');
    ({ scope, entries, postings, links } = transactionInputs);
    const transactionFacts = deriveCertificationFacts({ entries, postings, links, sourceStateKey: transactionSourceStateKey, from, to });
    const transactionResults = aggregateFacts(transactionFacts);
    merchantAdvanceBalance = postings.filter((p) => p.account_code === 'MERCHANT_ADVANCE').reduce((sum, p) => sum + moneyMinorUnits(p.debit) - moneyMinorUnits(p.credit), 0n);
    facts.splice(0, facts.length, ...transactionFacts);
    results.splice(0, results.length, ...transactionResults);
    if (reuseUnchanged) {
      const existing = (await client.query(`SELECT id,status,finished_at FROM reconciliation_runs
        WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
          AND period_from IS NOT DISTINCT FROM $4 AND period_to IS NOT DISTINCT FROM $5
        FOR UPDATE`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey, from, to])).rows[0];
      if (existing) {
        if (existing.status !== 'READY' || !existing.finished_at) throw certificationConflict(`Certification run ${existing.id} is not READY`);
        const persistedFacts = (await client.query(`SELECT run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key FROM certification_facts WHERE run_id=$1`, [existing.id])).rows;
        const persistedResults = (await client.query(`SELECT run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key FROM reconciliation_results WHERE run_id=$1`, [existing.id])).rows;
        if (!certificationSnapshotMatches(existing.id, facts, results, persistedFacts, persistedResults)) throw certificationConflict(`Certification snapshot ${existing.id} does not match source state ${sourceStateKey}`);
        await client.query('COMMIT');
        return { model: CERTIFICATION_MODEL_VERSION, runId: Number(existing.id), sourceStateKey, facts, results, balances: { merchantAdvance: money(merchantAdvanceBalance) }, reused: true, refreshed: false };
      }
    }
    if (replace) await client.query('DELETE FROM reconciliation_runs WHERE scope_id=$1 AND model_version=$2', [scope.id, CERTIFICATION_MODEL_VERSION]);
    if (!replace) {
      const existing = (await client.query(`SELECT id,status,finished_at FROM reconciliation_runs
        WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
          AND period_from IS NOT DISTINCT FROM $4 AND period_to IS NOT DISTINCT FROM $5
        FOR UPDATE`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey, from, to])).rows[0];
      if (existing) {
        if (existing.status !== 'READY' || !existing.finished_at) throw certificationConflict(`Certification run ${existing.id} is not READY`);
        const persistedFacts = (await client.query(`SELECT run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key FROM certification_facts WHERE run_id=$1`, [existing.id])).rows;
        const persistedResults = (await client.query(`SELECT run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key FROM reconciliation_results WHERE run_id=$1`, [existing.id])).rows;
        if (!certificationSnapshotMatches(existing.id, facts, results, persistedFacts, persistedResults)) throw certificationConflict(`Certification snapshot ${existing.id} does not match source state ${sourceStateKey}`);
        await client.query('COMMIT');
        return { model: CERTIFICATION_MODEL_VERSION, runId: Number(existing.id), sourceStateKey, facts, results, balances: { merchantAdvance: money(merchantAdvanceBalance) }, reused: true, refreshed: false };
      }
    }
    let run = (await client.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,period_from,period_to,status,finished_at) VALUES($1,$2,$3,$4,$5,'READY',NOW()) ON CONFLICT(scope_id,model_version,source_state_key,period_from,period_to) DO NOTHING RETURNING id`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey, from, to])).rows[0];
    if (!run) {
      run = (await client.query(`SELECT id,status,finished_at FROM reconciliation_runs
        WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
          AND period_from IS NOT DISTINCT FROM $4 AND period_to IS NOT DISTINCT FROM $5
        FOR UPDATE`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey, from, to])).rows[0];
      if (!run || run.status !== 'READY' || !run.finished_at) throw certificationConflict(`Certification run for source state ${sourceStateKey} is not READY`);
      const persistedFacts = (await client.query(`SELECT run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key FROM certification_facts WHERE run_id=$1`, [run.id])).rows;
      const persistedResults = (await client.query(`SELECT run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key FROM reconciliation_results WHERE run_id=$1`, [run.id])).rows;
      if (!certificationSnapshotMatches(run.id, facts, results, persistedFacts, persistedResults)) throw certificationConflict(`Certification snapshot ${run.id} does not match source state ${sourceStateKey}`);
      await client.query('COMMIT');
      return { model: CERTIFICATION_MODEL_VERSION, runId: Number(run.id), sourceStateKey, facts, results, balances: { merchantAdvance: money(merchantAdvanceBalance) }, reused: true, refreshed: false };
    }
    for (const [index, fact] of facts.entries()) {
      await client.query(`INSERT INTO certification_facts(run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(semantic_key) DO NOTHING`, [run.id, fact.scopeId, fact.subjectType, fact.subjectId, fact.metricCode, fact.dimension, fact.status, fact.amount, fact.currency, fact.eventAt, fact.reasonCode, fact.ruleCode, fact.ruleVersion, fact.ledgerEntryId, fact.businessEventId, fact.graphEvidenceId, fact.semanticKey, fact.sourceStateKey]);
      if (failAfter !== null && index + 1 >= Number(failAfter)) throw new Error('injected certification failure');
    }
    for (const result of results) await client.query(`INSERT INTO reconciliation_results(run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(semantic_key) DO UPDATE SET run_id=EXCLUDED.run_id,amount=EXCLUDED.amount,count_items=EXCLUDED.count_items`, [run.id, result.metricCode, result.status, result.amount, result.currency, result.countItems, result.reasonCode, resultSemanticKey(result, run.id)]);
    await client.query('COMMIT');
    return { model: CERTIFICATION_MODEL_VERSION, runId: Number(run.id), sourceStateKey, facts, results, balances: { merchantAdvance: money(merchantAdvanceBalance) }, reused: false, refreshed: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function certificationReport(pool, { scopeKey = 'default', from = null, to = null } = {}) {
  const projection = await rebuildCertification(pool, { scopeKey, from, to, persist: false });
  return { model: projection.model, sourceStateKey: projection.sourceStateKey, period: { from, to, semantics: 'business event/ledger event_at, half-open [from,to)' }, metrics: summarizeCertificationTotals(projection.results, projection.balances), results: projection.results, proofFacts: projection.facts };
}


import { certificationResultSemanticKey, certificationSourceStateKey, rebuildCertification, CERTIFICATION_MODEL_VERSION } from './certification.js';
import { createLogger } from './logger.js';

export const CURRENT_SPENDING_SNAPSHOT_MODEL = 'canonical-spending-current-snapshot-v1';
export const CURRENT_SPENDING_SNAPSHOT_FAILURES = Object.freeze({
  NO_CURRENT_CERTIFICATION: 'NO_CURRENT_CERTIFICATION',
  STALE_SNAPSHOT: 'STALE_SNAPSHOT',
  CORRUPT_SNAPSHOT: 'CORRUPT_SNAPSHOT',
  CERTIFICATION_CONFLICT: 'CERTIFICATION_CONFLICT',
});

const FACT_FIELDS = [
  'run_id', 'scope_id', 'subject_type', 'subject_id', 'metric_code', 'dimension',
  'status', 'amount', 'currency', 'event_at', 'reason_code', 'rule_code',
  'rule_version', 'ledger_entry_id', 'business_event_id', 'graph_evidence_id',
  'semantic_key', 'source_state_key',
];
const RESULT_FIELDS = ['run_id', 'metric_code', 'status', 'amount', 'currency', 'count_items', 'reason_code', 'semantic_key'];
const SAFE_COVERAGE_LIMITATIONS = Object.freeze([
  'CERTIFIED_ECONOMIC_ACQUISITIONS_ARE_NOT_COMPLETE_PERSONAL_SPENDING',
  'BANK_ONLY_OR_UNMATCHED_PURCHASES_MAY_BE_OUTSIDE_CERTIFIED_ACQUISITIONS',
  'PERSON_ATTRIBUTION_REMAINS_EXPLICIT_OR_UNATTRIBUTED',
]);

function canonicalValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  return String(value);
}

function canonicalRows(rows, fields) {
  return rows
    .map((row) => Object.fromEntries(fields.map((field) => [field, canonicalValue(row[field])])))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function failure(reasonCode, details = {}) {
  return {
    ok: false,
    modelVersion: CURRENT_SPENDING_SNAPSHOT_MODEL,
    status: reasonCode,
    reasonCode,
    snapshot: null,
    ...details,
  };
}

async function loadSnapshotOnClient(client, { scopeKey = 'default', sourceStateKey: providedSourceStateKey = null } = {}) {
  const scope = (await client.query('SELECT id,scope_key FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
  if (!scope) return failure('SCOPE_NOT_FOUND', { scopeKey });

  const sourceStateKey = providedSourceStateKey ?? await certificationSourceStateKey(client, Number(scope.id));
  const runs = (await client.query(`SELECT id,scope_id,model_version,source_state_key,period_from,period_to,status,started_at,finished_at
    FROM reconciliation_runs
    WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
      AND period_from IS NULL AND period_to IS NULL
    ORDER BY id`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey])).rows;
  if (!runs.length) return failure(CURRENT_SPENDING_SNAPSHOT_FAILURES.NO_CURRENT_CERTIFICATION, { scopeKey, sourceStateKey });
  if (runs.length !== 1) return failure(CURRENT_SPENDING_SNAPSHOT_FAILURES.CERTIFICATION_CONFLICT, { scopeKey, sourceStateKey });

  const run = runs[0];
  if (run.status !== 'READY' || !run.finished_at) {
    return failure(CURRENT_SPENDING_SNAPSHOT_FAILURES.NO_CURRENT_CERTIFICATION, { scopeKey, sourceStateKey, runId: Number(run.id) });
  }
  if (Number(run.scope_id) !== Number(scope.id) || run.model_version !== CERTIFICATION_MODEL_VERSION || run.source_state_key !== sourceStateKey || run.period_from !== null || run.period_to !== null) {
    return failure(CURRENT_SPENDING_SNAPSHOT_FAILURES.CORRUPT_SNAPSHOT, { scopeKey, sourceStateKey, runId: Number(run.id) });
  }

  const expected = await rebuildCertification(client, { scopeKey, persist: false, sourceStateKey });
  if (expected.sourceStateKey !== sourceStateKey) {
    return failure(CURRENT_SPENDING_SNAPSHOT_FAILURES.STALE_SNAPSHOT, { scopeKey, sourceStateKey, runId: Number(run.id) });
  }
  const facts = (await client.query(`SELECT run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key
    FROM certification_facts WHERE run_id=$1`, [run.id])).rows;
  const results = (await client.query(`SELECT run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key
    FROM reconciliation_results WHERE run_id=$1`, [run.id])).rows;
  const expectedFacts = expected.facts.map((fact) => ({
    run_id: run.id,
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
  const expectedResults = expected.results.map((result) => ({
    run_id: run.id,
    metric_code: result.metricCode,
    status: result.status,
    amount: result.amount,
    currency: result.currency,
    count_items: result.countItems,
    reason_code: result.reasonCode,
    // Preserve the existing certification writer's result identity contract.
    semantic_key: certificationResultSemanticKey(result, run.id),
  }));
  const factsHaveForeignIdentity = facts.some((fact) => Number(fact.scope_id) !== Number(scope.id) || fact.source_state_key !== sourceStateKey || Number(fact.run_id) !== Number(run.id));
  const resultsHaveForeignIdentity = results.some((result) => Number(result.run_id) !== Number(run.id));
  const factsMatch = JSON.stringify(canonicalRows(facts, FACT_FIELDS)) === JSON.stringify(canonicalRows(expectedFacts, FACT_FIELDS));
  const resultsMatch = JSON.stringify(canonicalRows(results, RESULT_FIELDS)) === JSON.stringify(canonicalRows(expectedResults, RESULT_FIELDS));
  if (factsHaveForeignIdentity || resultsHaveForeignIdentity || !factsMatch || !resultsMatch) return failure(CURRENT_SPENDING_SNAPSHOT_FAILURES.CORRUPT_SNAPSHOT, { scopeKey, sourceStateKey, runId: Number(run.id) });

  const currencies = (await client.query(`SELECT DISTINCT currency FROM certification_facts
    WHERE run_id=$1 AND source_state_key=$2 ORDER BY currency`, [run.id, sourceStateKey])).rows.map((row) => row.currency);
  const snapshot = {
    scopeKey: scope.scope_key,
    scopeId: Number(scope.id),
    runId: Number(run.id),
    modelVersion: run.model_version,
    sourceStateKey,
    status: run.status,
    period: { from: null, to: null, semantics: 'event_at, half-open [from,to)' },
    currency: currencies.length === 1 ? currencies[0] : currencies.length ? 'MIXED' : null,
    currencies,
    coverage: {
      certifiedEconomicAcquisitions: true,
      completePersonalSpending: false,
      limitations: [...SAFE_COVERAGE_LIMITATIONS],
    },
    startedAt: run.started_at,
    finishedAt: run.finished_at,
  };
  return { ok: true, modelVersion: CURRENT_SPENDING_SNAPSHOT_MODEL, status: 'READY', reasonCode: null, snapshot };
}

async function withCurrentSnapshot(pool, options, reader) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const resolved = await loadSnapshotOnClient(client, options);
    if (!resolved.ok) {
      await client.query('ROLLBACK');
      return resolved;
    }
    const data = await reader(client, resolved.snapshot);
    await client.query('ROLLBACK');
    return { ...resolved, ...(data ?? { data }) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

// Internal transaction-bound entry point for read-only projections that have
// already computed the authoritative source state in the same snapshot.
export async function resolveCurrentSpendingSnapshotOnClient(client, options = {}) {
  return loadSnapshotOnClient(client, options);
}

export async function resolveCurrentSpendingSnapshot(pool, options = {}) {
  return withCurrentSnapshot(pool, options, async () => null);
}

function scopedViewWhere(snapshot) {
  return [snapshot.scopeId, snapshot.runId, snapshot.sourceStateKey];
}

function readResult(snapshot, rows, queryPeriod = null) {
  return { snapshot, ...(queryPeriod ? { queryPeriod } : {}), rows };
}

export async function currentHouseholdSummary(pool, options = {}) {
  return withCurrentSnapshot(pool, options, async (client, snapshot) => readResult(snapshot, (await client.query(`SELECT scope_id,certification_run_id,certification_model_version,source_state_key,currency,gross_spend::text,confirmed_returns::text,net_spend::text
    FROM canonical_spending_household_summary_v1
    WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
    ORDER BY currency`, scopedViewWhere(snapshot))).rows));
}

export async function currentMonthlySpending(pool, { timezone = 'UTC', from = null, to = null, ...options } = {}) {
  const queryPeriod = {
    timezone,
    from,
    to,
    semantics: 'event_at, half-open [from,to)',
    snapshotIdentity: 'unbounded certification snapshot; query period is an additional filter',
  };
  return withCurrentSnapshot(pool, options, async (client, snapshot) => readResult(snapshot, (await client.query(`WITH monetary AS (
      SELECT purchased_at AS event_at, amount AS gross_spend, 0::NUMERIC(18,2) AS confirmed_returns, currency
      FROM canonical_spending_purchases_v1
      WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
      UNION ALL
      SELECT returned_at, 0::NUMERIC(18,2), return_amount, currency
      FROM canonical_spending_returns_v1
      WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
    )
    SELECT to_char(date_trunc('month',event_at AT TIME ZONE $6),'YYYY-MM') AS month,
      currency, SUM(gross_spend)::NUMERIC(18,2)::text AS gross_spend,
      SUM(confirmed_returns)::NUMERIC(18,2)::text AS confirmed_returns,
      (SUM(gross_spend)-SUM(confirmed_returns))::NUMERIC(18,2)::text AS net_spend
    FROM monetary
    WHERE ($4::timestamptz IS NULL OR event_at >= $4::timestamptz)
      AND ($5::timestamptz IS NULL OR event_at < $5::timestamptz)
    GROUP BY date_trunc('month',event_at AT TIME ZONE $6), currency
    ORDER BY month,currency`, [...scopedViewWhere(snapshot), from, to, timezone])).rows, queryPeriod));
}

export async function currentCategorySummary(pool, options = {}) {
  return withCurrentSnapshot(pool, options, async (client, snapshot) => readResult(snapshot, (await client.query(`SELECT scope_id,certification_run_id,source_state_key,currency,taxonomy_id,taxonomy_version,category_code,gross_spend::text,confirmed_returns::text,net_spend::text
    FROM canonical_spending_category_summary_v1
    WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
    ORDER BY currency,taxonomy_version,category_code`, scopedViewWhere(snapshot))).rows));
}

export async function currentPersonSummary(pool, options = {}) {
  return withCurrentSnapshot(pool, options, async (client, snapshot) => readResult(snapshot, (await client.query(`SELECT scope_id,certification_run_id,source_state_key,currency,person_id,gross_spend::text,confirmed_returns::text,net_spend::text,attribution_status
    FROM canonical_spending_person_summary_v1
    WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
    ORDER BY currency,person_id NULLS FIRST`, scopedViewWhere(snapshot))).rows));
}

export async function currentPurchases(pool, options = {}) {
  return withCurrentSnapshot(pool, options, async (client, snapshot) => readResult(snapshot, (await client.query(`SELECT scope_id,certification_run_id,certification_model_version,source_state_key,certification_fact_id,purchase_id,graph_evidence_id,amount::text,currency,purchased_at,rule_code,rule_version,semantic_key
    FROM canonical_spending_purchases_v1
    WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
    ORDER BY purchased_at,purchase_id`, scopedViewWhere(snapshot))).rows));
}

export async function currentReturns(pool, options = {}) {
  return withCurrentSnapshot(pool, options, async (client, snapshot) => readResult(snapshot, (await client.query(`SELECT scope_id,certification_run_id,certification_model_version,source_state_key,certification_fact_id,return_id,return_amount::text,currency,returned_at,rule_code,rule_version,semantic_key,relationship_status,related_purchase_id,related_receipt_item_id
    FROM canonical_spending_returns_v1
    WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
    ORDER BY returned_at,return_id`, scopedViewWhere(snapshot))).rows));
}

export function logCurrentSpendingSnapshot(result, options = {}, logger = createLogger()) {
  logger?.info?.('canonical_spending_current_snapshot_read_completed', {
    scopeKey: options.scopeKey ?? 'default',
    status: result.status,
    reasonCode: result.reasonCode ?? null,
    runId: result.snapshot?.runId ?? null,
    sourceStateKey: result.snapshot?.sourceStateKey ?? null,
    currency: result.snapshot?.currency ?? null,
    currencies: result.snapshot?.currencies ?? [],
  });
}

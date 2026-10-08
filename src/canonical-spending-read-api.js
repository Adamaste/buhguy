import { resolveCurrentSpendingSnapshotOnClient } from './canonical-spending-current-snapshot.js';

export const CANONICAL_SPENDING_QUERY_MODEL = 'canonical-spending-read-api-v1';
export const SPENDING_QUERY_FAILURES = Object.freeze({
  MISSING: 'MISSING',
  STALE: 'STALE',
  CONFLICT: 'CONFLICT',
  CORRUPT: 'CORRUPT',
  ACCESS_ERROR: 'ACCESS_ERROR',
  INVALID_PERIOD: 'INVALID_PERIOD',
});

const LIMITATIONS = Object.freeze([
  'CERTIFIED_ACQUISITIONS_ARE_NOT_COMPLETE_PERSONAL_SPENDING',
  'BANK_ONLY_OR_UNMATCHED_PURCHASES_REMAIN_INCOMPLETE',
  'PERSON_ATTRIBUTION_MAY_REMAIN_UNATTRIBUTED',
]);

function isAccessError(error) {
  return /42501|permission denied|access denied/i.test(String(error?.code ?? error?.message ?? ''));
}

function failure(reasonCode, details = {}) {
  return { ok: false, modelVersion: CANONICAL_SPENDING_QUERY_MODEL, status: reasonCode, reasonCode, snapshot: null, data: null, ...details };
}

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function zonedMidnightUtc(date, timezone) {
  const day = localParts(date, timezone);
  const localAsUtc = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day));
  const rendered = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(rendered.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const renderedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return new Date(localAsUtc - (renderedAsUtc - date.getTime()));
}

export function resolveSpendingPeriod({ period = 'today', timezone = 'Europe/Moscow', from = null, to = null, now = new Date() } = {}) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(now); } catch { return { ok: false, reasonCode: SPENDING_QUERY_FAILURES.INVALID_PERIOD }; }
  if (period === 'range') {
    const start = new Date(from ?? 'invalid');
    const end = new Date(to ?? 'invalid');
    if (!from || !to || Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start >= end) return { ok: false, reasonCode: SPENDING_QUERY_FAILURES.INVALID_PERIOD };
    return { ok: true, timezone, from: start.toISOString(), to: end.toISOString(), semantics: 'event_at, half-open [from,to)' };
  }
  if (from !== null || to !== null || !['today', 'yesterday'].includes(period)) return { ok: false, reasonCode: SPENDING_QUERY_FAILURES.INVALID_PERIOD };
  const midnight = zonedMidnightUtc(now, timezone);
  const start = new Date(midnight.getTime() + (period === 'yesterday' ? -86400000 : 0));
  const end = new Date(start.getTime() + 86400000);
  return { ok: true, timezone, from: start.toISOString(), to: end.toISOString(), semantics: 'event_at, half-open [from,to)' };
}

export function validatePurchaseGrainRows(rows) {
  const purchases = new Set();
  const facts = new Set();
  const keys = new Set();
  for (const row of rows) {
    const purchase = String(row.purchase_id);
    const fact = String(row.certification_fact_id);
    const key = String(row.semantic_key);
    if (purchases.has(purchase) || facts.has(fact) || keys.has(key)) return { ok: false, reasonCode: SPENDING_QUERY_FAILURES.CORRUPT, detail: 'DUPLICATE_PURCHASE_GRAIN' };
    purchases.add(purchase); facts.add(fact); keys.add(key);
  }
  return { ok: true };
}

async function classifyFailure(client, resolved, scopeId) {
  if (resolved.reasonCode === 'CORRUPT_SNAPSHOT') return failure(SPENDING_QUERY_FAILURES.CORRUPT, { sourceStateKey: resolved.sourceStateKey, runId: resolved.runId });
  if (resolved.reasonCode === 'CERTIFICATION_CONFLICT') return failure(SPENDING_QUERY_FAILURES.CONFLICT, { sourceStateKey: resolved.sourceStateKey });
  if (resolved.reasonCode !== 'NO_CURRENT_CERTIFICATION') return resolved;
  const prior = (await client.query(`SELECT id,source_state_key FROM reconciliation_runs
    WHERE scope_id=$1 AND model_version='reconciliation-certification-v1'
      AND period_from IS NULL AND period_to IS NULL AND status='READY' ORDER BY id DESC`, [scopeId])).rows;
  if (resolved.runId) return failure(SPENDING_QUERY_FAILURES.CORRUPT, { sourceStateKey: resolved.sourceStateKey, runId: resolved.runId, previousRunId: prior[0]?.id ?? null });
  if (prior.length) return failure(SPENDING_QUERY_FAILURES.STALE, { sourceStateKey: resolved.sourceStateKey, previousRunId: Number(prior[0].id), previousSourceStateKey: prior[0].source_state_key });
  return failure(SPENDING_QUERY_FAILURES.MISSING, { sourceStateKey: resolved.sourceStateKey });
}

function safeRows(rows, fields) { return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null]))); }
function totals(rows, gross, returns, net) {
  return rows.map((row) => ({ currency: row.currency, gross: String(row[gross]), returns: String(row[returns]), net: String(row[net]) }));
}

export async function queryCanonicalSpending(pool, {
  scopeKey = 'default', period = 'today', timezone = 'Europe/Moscow', from = null, to = null, statementTimeoutMs = 120000, lockTimeoutMs = 5000,
} = {}) {
  const queryPeriod = resolveSpendingPeriod({ period, timezone, from, to });
  if (!queryPeriod.ok) return failure(queryPeriod.reasonCode);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [String(lockTimeoutMs)]);
    const resolved = await resolveCurrentSpendingSnapshotOnClient(client, { scopeKey });
    if (!resolved.ok) {
      const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
      const result = scope ? await classifyFailure(client, resolved, scope.id) : failure(SPENDING_QUERY_FAILURES.MISSING, { scopeKey });
      await client.query('ROLLBACK');
      return { ...result, queryPeriod };
    }
    const args = [resolved.snapshot.scopeId, resolved.snapshot.runId, resolved.snapshot.sourceStateKey, queryPeriod.from, queryPeriod.to];
    const [purchases, returns, household, category, person, results] = await Promise.all([
      client.query(`SELECT scope_id,certification_run_id,source_state_key,certification_fact_id,purchase_id,amount::text,currency,purchased_at,rule_code,rule_version,semantic_key
        FROM canonical_spending_purchases_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
          AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz ORDER BY purchased_at,purchase_id`, args),
      client.query(`SELECT scope_id,certification_run_id,source_state_key,certification_fact_id,return_id,return_amount::text,currency,returned_at
        FROM canonical_spending_returns_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
          AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz ORDER BY returned_at,return_id`, args),
      client.query(`SELECT scope_id,certification_run_id,source_state_key,currency,gross_spend::text,confirmed_returns::text,net_spend::text FROM canonical_spending_household_summary_v1
        WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 ORDER BY currency`, args.slice(0, 3)),
      client.query(`SELECT scope_id,certification_run_id,source_state_key,currency,taxonomy_id,taxonomy_version,category_code,gross_spend::text,confirmed_returns::text,net_spend::text FROM canonical_spending_category_summary_v1
        WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 ORDER BY currency,taxonomy_version,category_code`, args.slice(0, 3)),
      client.query(`SELECT scope_id,certification_run_id,source_state_key,currency,person_id,gross_spend::text,confirmed_returns::text,net_spend::text,attribution_status FROM canonical_spending_person_summary_v1
        WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 ORDER BY currency,person_id NULLS FIRST`, args.slice(0, 3)),
      client.query(`SELECT metric_code,status,amount::text,currency,count_items,reason_code FROM reconciliation_results WHERE run_id=$1 ORDER BY metric_code,status,currency,reason_code`, [resolved.snapshot.runId]),
    ]);
    const duplicate = validatePurchaseGrainRows(purchases.rows);
    if (!duplicate.ok) { await client.query('ROLLBACK'); return failure(duplicate.reasonCode, { detail: duplicate.detail, sourceStateKey: resolved.snapshot.sourceStateKey, runId: resolved.snapshot.runId, queryPeriod }); }
    const data = {
      grossReturnsNetByCurrency: totals(household.rows, 'gross_spend', 'confirmed_returns', 'net_spend'),
      confirmedPurchases: safeRows(purchases.rows, ['purchase_id', 'amount', 'currency', 'purchased_at', 'rule_code', 'rule_version']),
      confirmedReturns: safeRows(returns.rows, ['return_id', 'return_amount', 'currency', 'returned_at']),
      category: totals(category.rows, 'gross_spend', 'confirmed_returns', 'net_spend'),
      person: totals(person.rows, 'gross_spend', 'confirmed_returns', 'net_spend'),
      unresolved: {
        blockedExposure: safeRows(results.rows.filter((row) => row.status === 'BLOCKED'), ['metric_code', 'amount', 'currency', 'count_items', 'reason_code']),
        unattributedPersonRows: person.rows.filter((row) => row.person_id === null).map((row) => ({ currency: row.currency, gross: String(row.gross_spend), returns: String(row.confirmed_returns), net: String(row.net_spend) })),
      },
      bankOnlyIncomplete: { status: 'EXCLUDED_FROM_CERTIFIED_ACQUISITIONS', reasonCode: 'BANK_ONLY_OR_UNMATCHED_NOT_PROVEN_PURCHASE' },
      limitations: [...LIMITATIONS],
    };
    await client.query('ROLLBACK');
    return { ok: true, modelVersion: CANONICAL_SPENDING_QUERY_MODEL, status: 'READY', reasonCode: null, snapshot: resolved.snapshot, queryPeriod, data };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    return failure(isAccessError(error) ? SPENDING_QUERY_FAILURES.ACCESS_ERROR : 'TECHNICAL_ERROR', { reason: isAccessError(error) ? 'READ_ONLY_ACCESS_DENIED' : 'READ_ONLY_QUERY_FAILED', queryPeriod });
  } finally { client.release(); }
}


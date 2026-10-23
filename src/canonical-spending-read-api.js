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

const MAX_STATEMENT_TIMEOUT_MS = 300000;
const MAX_LOCK_TIMEOUT_MS = 30000;
const MAX_PERIOD_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 1000;
const MAX_PAGE_OFFSET = 1000000;

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
  return zonedLocalDateMidnightUtc(day, timezone);
}

function zonedLocalDateMidnightUtc(day, timezone) {
  const targetUtc = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day));
  let guess = targetUtc;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const rendered = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(rendered.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    const renderedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    const next = targetUtc - (renderedAsUtc - guess);
    if (next === guess) return new Date(next);
    guess = next;
  }
  return new Date(guess);
}

function validateBoundedInteger(value, max) {
  return Number.isInteger(value) && value > 0 && value <= max;
}

function validatePagination(value, max, fallback) {
  return value === undefined ? fallback : Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function validatePageSize(value) {
  return value === undefined ? 100 : Number.isInteger(value) && value > 0 && value <= MAX_PAGE_SIZE ? value : null;
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
  const day = localParts(now, timezone);
  const localCalendarDate = (delta) => {
    const shifted = new Date(Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day) + delta));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
  };
  const todayStart = zonedLocalDateMidnightUtc(localCalendarDate(0), timezone);
  const tomorrowStart = zonedLocalDateMidnightUtc(localCalendarDate(1), timezone);
  if (period === 'yesterday') return { ok: true, timezone, from: zonedLocalDateMidnightUtc(localCalendarDate(-1), timezone).toISOString(), to: todayStart.toISOString(), semantics: 'event_at, half-open [from,to)' };
  const end = tomorrowStart;
  return { ok: true, timezone, from: todayStart.toISOString(), to: end.toISOString(), semantics: 'event_at, half-open [from,to)' };
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
export async function queryCanonicalSpending(pool, {
  scopeKey = 'default', period = 'today', timezone = 'Europe/Moscow', from = null, to = null, statementTimeoutMs = 120000, lockTimeoutMs = 5000, limit = 100, offset = 0,
} = {}) {
  const queryPeriod = resolveSpendingPeriod({ period, timezone, from, to });
  if (!queryPeriod.ok) return failure(queryPeriod.reasonCode);
  if (period === 'range' && new Date(queryPeriod.to).getTime() - new Date(queryPeriod.from).getTime() > MAX_PERIOD_MS) return failure(SPENDING_QUERY_FAILURES.INVALID_PERIOD, { reason: 'PERIOD_TOO_WIDE' });
  if (!validateBoundedInteger(statementTimeoutMs, MAX_STATEMENT_TIMEOUT_MS) || !validateBoundedInteger(lockTimeoutMs, MAX_LOCK_TIMEOUT_MS)) return failure(SPENDING_QUERY_FAILURES.INVALID_PERIOD, { reason: 'TIMEOUT_OUT_OF_BOUNDS' });
  const pageSize = validatePageSize(limit);
  const pageOffset = validatePagination(offset, MAX_PAGE_OFFSET, 0);
  if (pageSize === null || pageOffset === null) return failure(SPENDING_QUERY_FAILURES.INVALID_PERIOD, { reason: 'PAGINATION_OUT_OF_BOUNDS' });
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
    const [purchases, purchaseGrain, returns, household, category, person] = await Promise.all([
      client.query(`SELECT scope_id,certification_run_id,source_state_key,certification_fact_id,purchase_id,amount::text,currency,purchased_at,rule_code,rule_version,semantic_key
        FROM canonical_spending_purchases_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
          AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz ORDER BY purchased_at,purchase_id LIMIT $6 OFFSET $7`, [...args, pageSize + 1, pageOffset]),
      client.query(`SELECT certification_fact_id,purchase_id,semantic_key
        FROM canonical_spending_purchases_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
          AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz ORDER BY purchased_at,purchase_id`, args),
      client.query(`SELECT scope_id,certification_run_id,source_state_key,certification_fact_id,return_id,return_amount::text,currency,returned_at
        FROM canonical_spending_returns_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3
          AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz ORDER BY returned_at,return_id LIMIT $6 OFFSET $7`, [...args, pageSize + 1, pageOffset]),
      client.query(`WITH monetary AS (
          SELECT currency,amount AS gross,0::numeric AS returns FROM canonical_spending_purchases_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz
          UNION ALL SELECT currency,0::numeric,return_amount FROM canonical_spending_returns_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz
        ) SELECT currency,SUM(gross)::text AS gross_spend,SUM(returns)::text AS confirmed_returns,(SUM(gross)-SUM(returns))::text AS net_spend FROM monetary GROUP BY currency ORDER BY currency`, args),
      client.query(`WITH p AS (SELECT DISTINCT purchase_id AS subject_event_id,currency FROM canonical_spending_purchases_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz), r AS (SELECT DISTINCT return_id AS subject_event_id,currency FROM canonical_spending_returns_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz), a AS (SELECT * FROM canonical_spending_category_allocations_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3), filtered AS (SELECT a.currency,a.taxonomy_id,a.taxonomy_version,a.category_code,a.allocation_status,a.category_gross AS gross_spend,a.category_returns AS confirmed_returns FROM a JOIN p ON p.subject_event_id=a.subject_event_id AND p.currency=a.currency WHERE a.category_gross <> 0 UNION ALL SELECT a.currency,a.taxonomy_id,a.taxonomy_version,a.category_code,a.allocation_status,a.category_gross,a.category_returns FROM a JOIN r ON r.subject_event_id=a.subject_event_id AND r.currency=a.currency WHERE a.category_returns <> 0) SELECT currency,taxonomy_id,taxonomy_version,category_code,allocation_status,SUM(gross_spend)::text AS gross_spend,SUM(confirmed_returns)::text AS confirmed_returns,(SUM(gross_spend)-SUM(confirmed_returns))::text AS net_spend FROM filtered GROUP BY currency,taxonomy_id,taxonomy_version,category_code,allocation_status ORDER BY currency,taxonomy_version,category_code,allocation_status`, args),
      client.query(`WITH p AS (SELECT DISTINCT purchase_id AS subject_event_id,currency FROM canonical_spending_purchases_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz), r AS (SELECT DISTINCT return_id AS subject_event_id,currency FROM canonical_spending_returns_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz), a AS (SELECT * FROM canonical_spending_person_allocations_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3), filtered AS (SELECT a.currency,a.person_id,CASE WHEN a.person_id IS NULL THEN 'UNATTRIBUTED' ELSE 'ATTRIBUTED' END AS attribution_status,a.allocation_status,a.person_gross AS gross_spend,a.person_returns AS confirmed_returns FROM a JOIN p ON p.subject_event_id=a.subject_event_id AND p.currency=a.currency WHERE a.person_gross <> 0 UNION ALL SELECT a.currency,a.person_id,CASE WHEN a.person_id IS NULL THEN 'UNATTRIBUTED' ELSE 'ATTRIBUTED' END,a.allocation_status,a.person_gross,a.person_returns FROM a JOIN r ON r.subject_event_id=a.subject_event_id AND r.currency=a.currency WHERE a.person_returns <> 0) SELECT currency,person_id,attribution_status,allocation_status,SUM(gross_spend)::text AS gross_spend,SUM(confirmed_returns)::text AS confirmed_returns,(SUM(gross_spend)-SUM(confirmed_returns))::text AS net_spend FROM filtered GROUP BY currency,person_id,attribution_status,allocation_status ORDER BY currency,person_id NULLS FIRST,allocation_status`, args),
    ]);
    const duplicate = validatePurchaseGrainRows(purchaseGrain.rows);
    if (!duplicate.ok) { await client.query('ROLLBACK'); return failure(duplicate.reasonCode, { detail: duplicate.detail, sourceStateKey: resolved.snapshot.sourceStateKey, runId: resolved.snapshot.runId, queryPeriod }); }
    const data = {
      grossReturnsNetByCurrency: safeRows(household.rows, ['currency', 'gross_spend', 'confirmed_returns', 'net_spend']).map((row) => ({ currency: row.currency, gross: row.gross_spend, returns: row.confirmed_returns, net: row.net_spend })),
      confirmedPurchases: safeRows(purchases.rows.slice(0, pageSize), ['purchase_id', 'amount', 'currency', 'purchased_at', 'rule_code', 'rule_version']),
      confirmedReturns: safeRows(returns.rows.slice(0, pageSize), ['return_id', 'return_amount', 'currency', 'returned_at']),
      category: category.rows.map((row) => ({ currency: row.currency, taxonomyId: row.taxonomy_id, taxonomyVersion: row.taxonomy_version, categoryCode: row.category_code, allocationStatus: row.allocation_status, gross: row.gross_spend, returns: row.confirmed_returns, net: row.net_spend })),
      person: person.rows.map((row) => ({ currency: row.currency, personId: row.person_id ?? null, attributionStatus: row.attribution_status, allocationStatus: row.allocation_status, gross: row.gross_spend, returns: row.confirmed_returns, net: row.net_spend })),
      unresolved: {
        blockedExposure: [],
        blockedExposureStatus: 'INCOMPLETE_PERIOD_UNSUPPORTED',
        blockedExposureReasonCode: 'PERIOD_FILTERED_BLOCKED_FACT_GRAIN_UNAVAILABLE',
        unattributedPersonRows: person.rows.filter((row) => row.person_id === null).map((row) => ({ currency: row.currency, gross: String(row.gross_spend), returns: String(row.confirmed_returns), net: String(row.net_spend) })),
      },
      bankOnlyIncomplete: { status: 'PARTIALLY_INCLUDED', reasonCode: 'UNPROVEN_OR_OUT_OF_COHORT_BANK_MOVEMENTS_REMAIN_EXCLUDED' },
      limitations: [...LIMITATIONS],
      pagination: {
        limit: pageSize,
        offset: pageOffset,
        purchases: { hasMore: purchases.rows.length > pageSize },
        returns: { hasMore: returns.rows.length > pageSize },
      },
    };
    await client.query('ROLLBACK');
    return { ok: true, modelVersion: CANONICAL_SPENDING_QUERY_MODEL, status: 'READY', reasonCode: null, snapshot: resolved.snapshot, queryPeriod, data };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    return failure(isAccessError(error) ? SPENDING_QUERY_FAILURES.ACCESS_ERROR : 'TECHNICAL_ERROR', { reason: isAccessError(error) ? 'READ_ONLY_ACCESS_DENIED' : 'READ_ONLY_QUERY_FAILED', queryPeriod });
  } finally { client.release(); }
}


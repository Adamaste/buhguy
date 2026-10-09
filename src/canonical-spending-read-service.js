import { queryCanonicalSpending } from './canonical-spending-read-api.js';

export const CANONICAL_SPENDING_READ_SERVICE_MODEL = 'canonical-spending-read-service-v1';
export const READ_SERVICE_FAILURES = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  SCOPE_FORBIDDEN: 'SCOPE_FORBIDDEN',
  INVALID_REQUEST: 'INVALID_REQUEST',
  ACCESS_ERROR: 'ACCESS_ERROR',
  TECHNICAL_ERROR: 'TECHNICAL_ERROR',
});

const SAFE_STATUSES = new Set(['READY', 'STALE', 'MISSING', 'CONFLICT', 'CORRUPT', 'ACCESS_ERROR', 'TECHNICAL_ERROR', 'INVALID_PERIOD']);
const DEFAULT_TIMEZONES = Object.freeze(['Europe/Moscow']);
const DEFAULT_PERIODS = Object.freeze(['today', 'yesterday', 'range']);

function failure(reasonCode, reason = reasonCode, status = 'ACCESS_ERROR') {
  return {
    ok: false,
    modelVersion: CANONICAL_SPENDING_READ_SERVICE_MODEL,
    status,
    reasonCode,
    reason,
    snapshot: null,
    queryPeriod: null,
    data: null,
  };
}

function safeSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    scopeId: snapshot.scopeId ?? null,
    runId: snapshot.runId ?? null,
    sourceStateKey: snapshot.sourceStateKey ?? null,
  };
}

function safeData(data) {
  if (!data) return null;
  return {
    grossReturnsNetByCurrency: Array.isArray(data.grossReturnsNetByCurrency)
      ? data.grossReturnsNetByCurrency.map(({ currency, gross, returns, net }) => ({ currency, gross, returns, net }))
      : [],
    confirmedPurchases: Array.isArray(data.confirmedPurchases)
      ? data.confirmedPurchases.map(({ purchase_id, amount, currency, purchased_at, rule_code, rule_version }) => ({
        purchase_id, amount, currency, purchased_at, rule_code, rule_version,
      }))
      : [],
    confirmedReturns: Array.isArray(data.confirmedReturns)
      ? data.confirmedReturns.map(({ return_id, return_amount, currency, returned_at }) => ({
        return_id, return_amount, currency, returned_at,
      }))
      : [],
    category: Array.isArray(data.category)
      ? data.category.map(({ currency, taxonomyId, taxonomyVersion, categoryCode, allocationStatus, gross, returns, net }) => ({
        currency, taxonomyId, taxonomyVersion, categoryCode, allocationStatus, gross, returns, net,
      }))
      : [],
    person: Array.isArray(data.person)
      ? data.person.map(({ currency, personId, attributionStatus, allocationStatus, gross, returns, net }) => ({
        currency, personId, attributionStatus, allocationStatus, gross, returns, net,
      }))
      : [],
    unresolved: data.unresolved ? {
      blockedExposureStatus: data.unresolved.blockedExposureStatus ?? null,
      blockedExposureReasonCode: data.unresolved.blockedExposureReasonCode ?? null,
      unattributedPersonRows: Array.isArray(data.unresolved.unattributedPersonRows)
        ? data.unresolved.unattributedPersonRows.map(({ currency, gross, returns, net }) => ({ currency, gross, returns, net }))
        : [],
    } : null,
    bankOnlyIncomplete: data.bankOnlyIncomplete ? {
      status: data.bankOnlyIncomplete.status ?? null,
      reasonCode: data.bankOnlyIncomplete.reasonCode ?? null,
    } : null,
    limitations: Array.isArray(data.limitations) ? [...data.limitations] : [],
    pagination: data.pagination ?? null,
  };
}

function validateRequest(request, limits) {
  if (!request || typeof request !== 'object') return 'REQUEST_REQUIRED';
  if (!limits.periods.includes(request.period ?? 'today')) return 'PERIOD_NOT_ALLOWED';
  if (!limits.timezones.includes(request.timezone ?? 'Europe/Moscow')) return 'TIMEZONE_NOT_ALLOWED';
  if (request.period === 'range' && (!request.from || !request.to)) return 'RANGE_REQUIRED';
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > limits.maxPageSize)) return 'PAGE_SIZE_OUT_OF_BOUNDS';
  if (request.offset !== undefined && (!Number.isInteger(request.offset) || request.offset < 0 || request.offset > limits.maxOffset)) return 'PAGE_OFFSET_OUT_OF_BOUNDS';
  return null;
}

function safeSummary(result, scopeKey) {
  return {
    scopeKey,
    status: result.status ?? null,
    reasonCode: result.reasonCode ?? null,
    sourceStateKey: result.snapshot?.sourceStateKey ?? null,
    runId: result.snapshot?.runId ?? null,
    purchaseCount: result.data?.confirmedPurchases?.length ?? 0,
    returnCount: result.data?.confirmedReturns?.length ?? 0,
    currencyCount: result.data?.grossReturnsNetByCurrency?.length ?? 0,
  };
}

export function createCanonicalSpendingReadService({
  pool,
  authenticate,
  authorizeScope,
  query = queryCanonicalSpending,
  logger = { info() {} },
  timezones = DEFAULT_TIMEZONES,
  periods = DEFAULT_PERIODS,
  maxPageSize = 100,
  maxOffset = 10000,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
  if (typeof authenticate !== 'function') throw new TypeError('authenticate is required');
  if (typeof authorizeScope !== 'function') throw new TypeError('authorizeScope is required');
  const limits = {
    timezones: [...timezones],
    periods: [...periods],
    maxPageSize,
    maxOffset,
  };
  return {
    async handle(request, context = {}) {
      let principal;
      try {
        principal = await authenticate(context);
      } catch {
        return failure(READ_SERVICE_FAILURES.AUTHENTICATION_REQUIRED);
      }
      if (!principal) return failure(READ_SERVICE_FAILURES.AUTHENTICATION_REQUIRED);
      const invalid = validateRequest(request, limits);
      if (invalid) return failure(READ_SERVICE_FAILURES.INVALID_REQUEST, invalid);
      let scope;
      try {
        scope = await authorizeScope({ principal, requestedScopeKey: request.scopeKey ?? 'default' });
      } catch {
        return failure(READ_SERVICE_FAILURES.SCOPE_FORBIDDEN);
      }
      if (!scope || typeof scope.scopeKey !== 'string') return failure(READ_SERVICE_FAILURES.SCOPE_FORBIDDEN);
      const options = {
        scopeKey: scope.scopeKey,
        period: request.period ?? 'today',
        timezone: request.timezone ?? 'Europe/Moscow',
        from: request.from ?? null,
        to: request.to ?? null,
        limit: request.limit ?? 100,
        offset: request.offset ?? 0,
        statementTimeoutMs: request.statementTimeoutMs,
        lockTimeoutMs: request.lockTimeoutMs,
      };
      let result;
      try {
        result = await query(pool, options);
      } catch {
        result = failure(READ_SERVICE_FAILURES.TECHNICAL_ERROR, 'READ_ONLY_QUERY_FAILED', 'TECHNICAL_ERROR');
      }
      const safeResult = {
        ok: result?.ok === true && result?.status === 'READY',
        modelVersion: CANONICAL_SPENDING_READ_SERVICE_MODEL,
        status: SAFE_STATUSES.has(result?.status) ? result.status : 'TECHNICAL_ERROR',
        reasonCode: result?.reasonCode ?? null,
        reason: result?.reason ?? null,
        snapshot: safeSnapshot(result?.snapshot),
        queryPeriod: result?.queryPeriod ?? null,
        data: safeData(result?.data),
      };
      try {
        logger.info('canonical_spending_read_service_completed', safeSummary(safeResult, scope.scopeKey));
      } catch {}
      return safeResult;
    },
  };
}

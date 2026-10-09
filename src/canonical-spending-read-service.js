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
const SERVER_STATEMENT_TIMEOUT_MS = 120000;
const SERVER_LOCK_TIMEOUT_MS = 5000;

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

function validSourceStateKey(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function safeSnapshot(snapshot) {
  if (!snapshot || !Number.isSafeInteger(Number(snapshot.scopeId)) || Number(snapshot.scopeId) < 1
      || !Number.isSafeInteger(Number(snapshot.runId)) || Number(snapshot.runId) < 1
      || !validSourceStateKey(snapshot.sourceStateKey)
      || snapshot.status !== 'READY'
      || typeof snapshot.scopeKey !== 'string'
      || typeof snapshot.modelVersion !== 'string') return null;
  return {
    scopeKey: snapshot.scopeKey,
    scopeId: Number(snapshot.scopeId),
    runId: Number(snapshot.runId),
    modelVersion: snapshot.modelVersion,
    sourceStateKey: snapshot.sourceStateKey,
    status: 'READY',
    currency: typeof snapshot.currency === 'string' ? snapshot.currency : null,
    currencies: Array.isArray(snapshot.currencies) ? snapshot.currencies.filter((value) => typeof value === 'string') : [],
    finishedAt: typeof snapshot.finishedAt === 'string' ? snapshot.finishedAt : null,
  };
}

function safeQueryPeriod(queryPeriod) {
  if (!queryPeriod || typeof queryPeriod !== 'object'
      || typeof queryPeriod.timezone !== 'string'
      || typeof queryPeriod.from !== 'string'
      || typeof queryPeriod.to !== 'string'
      || queryPeriod.semantics !== 'event_at, half-open [from,to)') return null;
  return {
    timezone: queryPeriod.timezone,
    from: queryPeriod.from,
    to: queryPeriod.to,
    semantics: queryPeriod.semantics,
  };
}

function safeData(data) {
  if (!data || typeof data !== 'object'
      || !Array.isArray(data.grossReturnsNetByCurrency)
      || !Array.isArray(data.confirmedPurchases)
      || !Array.isArray(data.confirmedReturns)
      || !Array.isArray(data.category)
      || !Array.isArray(data.person)
      || !data.unresolved || typeof data.unresolved !== 'object'
      || !data.bankOnlyIncomplete || typeof data.bankOnlyIncomplete !== 'object'
      || !Array.isArray(data.limitations)
      || !data.pagination || typeof data.pagination !== 'object') return null;
  const pagination = data.pagination;
  if (!Number.isInteger(pagination.limit) || !Number.isInteger(pagination.offset)
      || !pagination.purchases || typeof pagination.purchases.hasMore !== 'boolean'
      || !pagination.returns || typeof pagination.returns.hasMore !== 'boolean') return null;
  return {
    grossReturnsNetByCurrency: data.grossReturnsNetByCurrency.map(({ currency, gross, returns, net }) => ({ currency, gross, returns, net })),
    confirmedPurchases: data.confirmedPurchases.map(({ purchase_id, amount, currency, purchased_at, rule_code, rule_version }) => ({
      purchase_id, amount, currency, purchased_at, rule_code, rule_version,
    })),
    confirmedReturns: data.confirmedReturns.map(({ return_id, return_amount, currency, returned_at }) => ({
      return_id, return_amount, currency, returned_at,
    })),
    category: data.category.map(({ currency, taxonomyId, taxonomyVersion, categoryCode, allocationStatus, gross, returns, net }) => ({
      currency, taxonomyId, taxonomyVersion, categoryCode, allocationStatus, gross, returns, net,
    })),
    person: data.person.map(({ currency, personId, attributionStatus, allocationStatus, gross, returns, net }) => ({
      currency, personId, attributionStatus, allocationStatus, gross, returns, net,
    })),
    unresolved: {
      blockedExposureStatus: data.unresolved.blockedExposureStatus ?? null,
      blockedExposureReasonCode: data.unresolved.blockedExposureReasonCode ?? null,
      unattributedPersonRows: Array.isArray(data.unresolved.unattributedPersonRows)
        ? data.unresolved.unattributedPersonRows.map(({ currency, gross, returns, net }) => ({ currency, gross, returns, net }))
        : [],
    },
    bankOnlyIncomplete: {
      status: data.bankOnlyIncomplete.status ?? null,
      reasonCode: data.bankOnlyIncomplete.reasonCode ?? null,
    },
    limitations: data.limitations.filter((value) => typeof value === 'string').slice(0, 32),
    pagination: {
      limit: pagination.limit,
      offset: pagination.offset,
      purchases: { hasMore: pagination.purchases.hasMore },
      returns: { hasMore: pagination.returns.hasMore },
    },
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
        scope = await authorizeScope({ principal, requestedScopeKey: request.scopeKey ?? null });
      } catch {
        return failure(READ_SERVICE_FAILURES.SCOPE_FORBIDDEN);
      }
      if (!scope || typeof scope.scopeKey !== 'string'
          || (request.scopeKey !== undefined && request.scopeKey !== scope.scopeKey)) return failure(READ_SERVICE_FAILURES.SCOPE_FORBIDDEN);
      const options = {
        scopeKey: scope.scopeKey,
        period: request.period ?? 'today',
        timezone: request.timezone ?? 'Europe/Moscow',
        from: request.from ?? null,
        to: request.to ?? null,
        limit: request.limit ?? 100,
        offset: request.offset ?? 0,
        statementTimeoutMs: SERVER_STATEMENT_TIMEOUT_MS,
        lockTimeoutMs: SERVER_LOCK_TIMEOUT_MS,
      };
      let result;
      try {
        result = await query(pool, options);
      } catch {
        result = failure(READ_SERVICE_FAILURES.TECHNICAL_ERROR, 'READ_ONLY_QUERY_FAILED', 'TECHNICAL_ERROR');
      }
      const status = SAFE_STATUSES.has(result?.status) ? result.status : 'TECHNICAL_ERROR';
      const snapshot = safeSnapshot(result?.snapshot);
      const queryPeriod = safeQueryPeriod(result?.queryPeriod);
      const readyData = result?.ok === true && status === 'READY' && snapshot && queryPeriod ? safeData(result?.data) : null;
      const readyContractValid = result?.ok === true && status === 'READY' && snapshot && queryPeriod && readyData;
      const safeResult = {
        ok: readyContractValid === true,
        modelVersion: CANONICAL_SPENDING_READ_SERVICE_MODEL,
        status: readyContractValid === true ? 'READY' : (result?.ok === true && status === 'READY' ? 'CORRUPT' : status),
        reasonCode: readyContractValid === true ? null : (result?.ok === true && status === 'READY' ? 'READY_RESULT_CONTRACT_INVALID' : (typeof result?.reasonCode === 'string' ? result.reasonCode.slice(0, 128) : null)),
        reason: readyContractValid === true ? null : (typeof result?.reason === 'string' ? result.reason.slice(0, 256) : (result?.ok === true && status === 'READY' ? 'READY_RESULT_CONTRACT_INVALID' : null)),
        snapshot: readyContractValid === true ? snapshot : (snapshot && status === 'READY' ? snapshot : null),
        queryPeriod,
        data: readyContractValid === true ? readyData : null,
      };
      try {
        logger.info('canonical_spending_read_service_completed', safeSummary(safeResult, scope.scopeKey));
      } catch {}
      return safeResult;
    },
  };
}

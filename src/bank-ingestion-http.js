import http from 'node:http';
import { authenticateBankDevice } from './bank-device-auth.js';
import { createBankIngestionHandler, resolveBankObservationAccountingScope, validateBankEventInput } from './bank-ingestion.js';
import { matchedPurchaseReconciliationWindow, readMatchedPurchaseReconciliationOptIn, runBoundedMatchedPurchaseReconciliation } from './matched-purchase-reconciliation.js';

const DEFAULT_BODY_LIMIT = 32 * 1024;
const SAFE_RECONCILIATION_STATUS = new Set(['COMPLETED', 'REVIEW_REQUIRED', 'BLOCKED', 'ERROR', 'DISABLED']);
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;

function safeReconciliationResult(value) {
  const status = SAFE_RECONCILIATION_STATUS.has(value?.status) ? value.status : 'ERROR';
  const reasonCode = typeof value?.reasonCode === 'string' && SAFE_CODE.test(value.reasonCode) ? value.reasonCode : null;
  return { status, ...(reasonCode ? { reasonCode } : {}) };
}

function logSafely(logger, level, event, fields) {
  try { logger[level]?.(event, fields); } catch { /* logging cannot alter a committed ingestion result */ }
}

function writeJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        reject(Object.assign(new Error('request body is too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function bearerToken(request) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !/^Bearer\s+\S+$/.test(value)) return null;
  return value.slice(value.indexOf(' ') + 1);
}

export function createBankIngestionServer({
  pool,
  logger = console,
  bodyLimit = DEFAULT_BODY_LIMIT,
  matchedPurchaseCanary = readMatchedPurchaseReconciliationOptIn(),
  reconcileMatchedPurchases = runBoundedMatchedPurchaseReconciliation,
  now = () => new Date(),
} = {}) {
  const handler = createBankIngestionHandler({ pool });
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') return writeJson(response, 200, { status: 'ok' });
      if (request.url !== '/api/v1/bank/events') return writeJson(response, 404, { status: 'not_found' });
      if (request.method !== 'POST') return writeJson(response, 405, { status: 'rejected', code: 'METHOD_NOT_ALLOWED' });
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return writeJson(response, 415, { status: 'rejected', code: 'UNSUPPORTED_MEDIA_TYPE' });
      const auth = await authenticateBankDevice(pool, bearerToken(request));
      if (!auth.ok) return writeJson(response, 401, { status: 'unauthorized', code: 'AUTHENTICATION_FAILED' });
      let body;
      try {
        body = JSON.parse(await readBody(request, bodyLimit));
      } catch (error) {
        if (error.code === 'BODY_TOO_LARGE') return writeJson(response, 413, { status: 'rejected', code: 'BODY_TOO_LARGE' });
        return writeJson(response, 400, { status: 'rejected', code: 'INVALID_EVENT' });
      }
      try { validateBankEventInput(body); } catch { return writeJson(response, 400, { status: 'rejected', code: 'INVALID_EVENT' }); }
      if (body.sourceKey !== auth.sourceKey) return writeJson(response, 403, { status: 'rejected', code: 'SOURCE_MISMATCH' });
      const result = await handler({ body });
      let responseResult = result;
      if (matchedPurchaseCanary?.enabled === true && result.status === 'created') {
        let reconciliation = { status: 'BLOCKED', reasonCode: 'BANK_EVENT_SCOPE_UNRESOLVED' };
        try {
          const resolved = await resolveBankObservationAccountingScope(pool, {
            bankSourceId: auth.bankSourceId,
            observationId: result.observationId,
          });
          if (resolved.status !== 'RESOLVED') reconciliation = resolved;
          else if (resolved.scopeKey !== matchedPurchaseCanary.canaryScopeKey) reconciliation = { status: 'BLOCKED', reasonCode: 'CANARY_SCOPE_MISMATCH' };
          else {
            const summary = await reconcileMatchedPurchases(pool, {
              ...matchedPurchaseReconciliationWindow(now()),
              enabled: true,
              canaryScopeKey: matchedPurchaseCanary.canaryScopeKey,
              scopeKey: resolved.scopeKey,
              approvedMatchKey: matchedPurchaseCanary.approvedMatchKey,
              automaticPolicy: matchedPurchaseCanary.automaticPolicy ?? null,
              bankIngestedAfter: matchedPurchaseCanary.bankIngestedAfter ?? null,
            });
            reconciliation = safeReconciliationResult(summary);
          }
        } catch (error) {
          reconciliation = {
            status: 'ERROR',
            reasonCode: typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'RECONCILIATION_ERROR',
          };
        }
        responseResult = { ...result, reconciliation };
        const level = reconciliation.status === 'ERROR' ? 'error' : reconciliation.status === 'BLOCKED' ? 'warn' : 'info';
        logSafely(logger, level, 'matched_purchase_reconciliation_after_ingestion', reconciliation);
      }
      if (result.status === 'created') return writeJson(response, 201, responseResult);
      if (result.status === 'duplicate') return writeJson(response, 200, responseResult);
      if (result.code === 'SOURCE_EVENT_CONFLICT') return writeJson(response, 409, responseResult);
      return writeJson(response, 400, responseResult);
    } catch (error) {
      logger.error?.('bank_ingestion_request_failed', { errorCode: error.code || 'INTERNAL_ERROR', status: error.status });
      if (!response.headersSent) writeJson(response, 500, { status: 'error', code: 'INTERNAL_ERROR' });
    }
  });
}

export { DEFAULT_BODY_LIMIT };

import http from 'node:http';
import { authenticateBankDevice } from './bank-device-auth.js';
import { createBankIngestionHandler, validateBankEventInput } from './bank-ingestion.js';

const DEFAULT_BODY_LIMIT = 32 * 1024;

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

export function createBankIngestionServer({ pool, logger = console, bodyLimit = DEFAULT_BODY_LIMIT }) {
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
      if (result.status === 'created') return writeJson(response, 201, result);
      if (result.status === 'duplicate') return writeJson(response, 200, result);
      if (result.code === 'SOURCE_EVENT_CONFLICT') return writeJson(response, 409, result);
      return writeJson(response, 400, result);
    } catch (error) {
      logger.error?.('bank_ingestion_request_failed', { errorCode: error.code || 'INTERNAL_ERROR', status: error.status });
      if (!response.headersSent) writeJson(response, 500, { status: 'error', code: 'INTERNAL_ERROR' });
    }
  });
}

export { DEFAULT_BODY_LIMIT };

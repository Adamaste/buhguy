import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createCanonicalSpendingReadService } from './canonical-spending-read-service.js';

export const CANONICAL_SPENDING_MCP_MODEL = 'canonical-spending-mcp-v1';
export const CANONICAL_SPENDING_MCP_TOOL = 'canonical_spending_read';
const MAX_REQUESTS_PER_WINDOW = 60;
const RATE_WINDOW_MS = 60_000;

function safeFailure(status, reasonCode, reason) {
  return { ok: false, modelVersion: CANONICAL_SPENDING_MCP_MODEL, status, reasonCode, reason, snapshot: null, queryPeriod: null, data: null };
}
function extractAuthContext(extra = {}) {
  const authInfo = extra.authInfo ?? extra.requestInfo?.authInfo ?? null;
  return authInfo && typeof authInfo === 'object' ? authInfo : null;
}
function createRateLimiter(maxRequests, windowMs) {
  let startedAt = 0; let count = 0;
  return { allow(now = Date.now()) {
    if (now - startedAt >= windowMs) { startedAt = now; count = 0; }
    count += 1; return count <= maxRequests;
  } };
}
function validateLimit(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

export function createCanonicalSpendingMcpToolHandler({
  readService, logger = { info() {} }, maxRequests = MAX_REQUESTS_PER_WINDOW, rateWindowMs = RATE_WINDOW_MS,
} = {}) {
  if (!readService || typeof readService.handle !== 'function') throw new TypeError('readService.handle is required');
  const limiter = createRateLimiter(
    validateLimit(maxRequests, MAX_REQUESTS_PER_WINDOW, MAX_REQUESTS_PER_WINDOW),
    validateLimit(rateWindowMs, RATE_WINDOW_MS, 10 * RATE_WINDOW_MS),
  );
  return async function handleTool(request, extra = {}) {
    if (!limiter.allow()) return safeFailure('ACCESS_ERROR', 'RATE_LIMITED', 'Request rate limit exceeded');
    try {
      const result = await readService.handle(request, { authInfo: extractAuthContext(extra) });
      const safe = result && typeof result === 'object'
        ? result
        : safeFailure('TECHNICAL_ERROR', 'READ_ONLY_QUERY_FAILED', 'Read-only query failed');
      logger.info('canonical_spending_mcp_completed', {
        status: safe.status ?? null, reasonCode: safe.reasonCode ?? null,
        scopeKey: safe.snapshot?.scopeKey ?? request?.scopeKey ?? null,
        purchaseCount: safe.data?.confirmedPurchases?.length ?? 0,
        returnCount: safe.data?.confirmedReturns?.length ?? 0,
        currencyCount: safe.data?.grossReturnsNetByCurrency?.length ?? 0,
      });
      return safe;
    } catch {
      const failure = safeFailure('TECHNICAL_ERROR', 'READ_ONLY_QUERY_FAILED', 'Read-only query failed');
      logger.info('canonical_spending_mcp_completed', {
        status: failure.status, reasonCode: failure.reasonCode, scopeKey: null,
        purchaseCount: 0, returnCount: 0, currencyCount: 0,
      });
      return failure;
    }
  };
}

export function createCanonicalSpendingMcpServer({
  pool, authenticate, authorizeScope, readService, logger, maxRequests, rateWindowMs,
} = {}) {
  const service = readService ?? createCanonicalSpendingReadService({ pool, authenticate, authorizeScope, logger });
  const handleTool = createCanonicalSpendingMcpToolHandler({
    readService: service, logger, maxRequests, rateWindowMs,
  });
  const server = new McpServer({ name: 'canonical-spending-read-only', version: CANONICAL_SPENDING_MCP_MODEL });
  server.registerTool(CANONICAL_SPENDING_MCP_TOOL, {
    title: 'Canonical spending read',
    description: 'Read current certified spending for an authorized scope. This tool never writes data.',
    inputSchema: {
      scopeKey: z.string().min(1).max(128).optional(),
      period: z.enum(['today', 'yesterday', 'range']).optional(),
      timezone: z.string().min(1).max(64).optional(),
      from: z.string().max(64).optional(), to: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    },
  }, async (request, extra) => {
    const result = await handleTool(request, extra);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok !== true };
  });
  return { server, service, handleTool };
}

export async function createCanonicalSpendingMcpStreamableHttp(options = {}) {
  const { server, service, handleTool } = createCanonicalSpendingMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return { server, service, handleTool, transport,
    handleRequest: (request, response, parsedBody) => transport.handleRequest(request, response, parsedBody) };
}

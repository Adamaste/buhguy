import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool } from '../src/database.js';
import {
  MATCHED_PURCHASE_ORCHESTRATION_VERSION,
  previewMatchedPurchaseOrchestration,
} from '../src/matched-purchase-orchestration.js';

export const PREVIEW_STATEMENT_TIMEOUT_MS = 120000;
export const PREVIEW_LOCK_TIMEOUT_MS = 5000;
export const APPROVED_INTERNAL_TRANSFER_WINDOW_MS = 5000;
export const INVARIANT_INTERNAL_TRANSFER_WINDOW_MS = 3600000;
export const APPROVED_RECEIPT_WINDOW_MS = 300000;
export const MAX_PREVIEW_PERIOD_MS = 60 * 24 * 60 * 60 * 1000;

const SUMMARY_FIELDS = Object.freeze([
  'matchedPairs',
  'persistRequired',
  'alreadyPersisted',
  'blockedMatchedPairs',
  'ambiguousBankPurchases',
  'ambiguousReceipts',
  'unmatchedBankPurchases',
  'unmatchedReceipts',
  'ineligibleBankEntries',
  'ineligibleReceipts',
]);
const READINESS = new Set(['READY', 'REVIEW_REQUIRED']);
const SAFE_REASON_CODES = new Set(['MATCHING_WINDOW_INVARIANCE_MISMATCH']);
const PREVIEW_FAILURE_STAGES = new Set([
  'POOL_CONNECT',
  'TRANSACTION_BEGIN',
  'SESSION_READ_ONLY',
  'NARROW_PREVIEW',
  'WIDE_PREVIEW',
  'ROLLBACK',
]);
const PREVIEW_FAILURE_STAGE = Symbol('previewFailureStage');

export function previewFailureStage(error) {
  const stage = error?.[PREVIEW_FAILURE_STAGE];
  return PREVIEW_FAILURE_STAGES.has(stage) ? stage : 'UNKNOWN';
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function stableJson(value) { return JSON.stringify(canonicalize(value)); }

function sortedRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => canonicalize(row))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function matchingWindowInvariantProjection(result) {
  return {
    modelVersion: result?.modelVersion ?? null,
    readiness: result?.readiness ?? null,
    selection: result?.selection ?? null,
    summary: result?.summary ?? null,
    decisions: sortedRows(result?.decisions),
    bankStatuses: sortedRows(result?.bankStatuses),
    receiptStatuses: sortedRows(result?.receiptStatuses),
  };
}

export function matchingWindowInvariantHolds(narrowResult, wideResult) {
  return stableJson(matchingWindowInvariantProjection(narrowResult))
    === stableJson(matchingWindowInvariantProjection(wideResult));
}

function positiveBoundedInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive bounded integer`);
  return value;
}

function safeCount(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid preview summary field: ${field}`);
  return number;
}

function normalizePeriod(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be a valid ISO timestamp`);
  return new Date(value).toISOString();
}

export function validateReadOnlyPreviewOptions({ scopeKey, from, to } = {}) {
  if (typeof scopeKey !== 'string' || !scopeKey.trim()) throw new Error('scopeKey is required');
  const normalizedFrom = normalizePeriod(from, 'from');
  const normalizedTo = normalizePeriod(to, 'to');
  const duration = Date.parse(normalizedTo) - Date.parse(normalizedFrom);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_PREVIEW_PERIOD_MS) throw new Error('preview period is outside the bounded range');
  return { scopeKey, from: normalizedFrom, to: normalizedTo };
}

export function sanitizeReadOnlyPreview(result) {
  if (!result || result.modelVersion !== MATCHED_PURCHASE_ORCHESTRATION_VERSION || !READINESS.has(result.readiness)) {
    throw new Error('authoritative preview result contract is invalid');
  }
  if (!result.summary || typeof result.summary !== 'object') throw new Error('authoritative preview summary is invalid');
  if (result.reasonCode !== undefined && !SAFE_REASON_CODES.has(result.reasonCode)) {
    throw new Error('authoritative preview reason code is invalid');
  }
  const summary = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, safeCount(result.summary[field], field)]));
  return {
    modelVersion: MATCHED_PURCHASE_ORCHESTRATION_VERSION,
    readiness: result.readiness,
    ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    summary,
  };
}

export async function runReadOnlyMatchedPurchasePreview(pool, options = {}) {
  const period = validateReadOnlyPreviewOptions(options);
  positiveBoundedInteger(PREVIEW_STATEMENT_TIMEOUT_MS, 'statementTimeoutMs');
  positiveBoundedInteger(PREVIEW_LOCK_TIMEOUT_MS, 'lockTimeoutMs');
  const preview = options.preview ?? previewMatchedPurchaseOrchestration;
  let stage = 'POOL_CONNECT';
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    stage = 'TRANSACTION_BEGIN';
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    stage = 'SESSION_READ_ONLY';
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${PREVIEW_STATEMENT_TIMEOUT_MS}ms`]);
    await client.query("SELECT set_config('lock_timeout',$1,true)", [`${PREVIEW_LOCK_TIMEOUT_MS}ms`]);
    const readOnly = await client.query("SELECT current_setting('transaction_read_only') AS value");
    if (readOnly.rows[0]?.value !== 'on') throw new Error('read-only transaction was not established');
    const previewOptions = {
      ...period,
      receiptMaxTimeDeltaMs: APPROVED_RECEIPT_WINDOW_MS,
      logger: { info() {} },
    };
    stage = 'NARROW_PREVIEW';
    const narrowResult = await preview(client, {
      ...previewOptions,
      internalTransferMaxTimeDeltaMs: APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
    });
    stage = 'WIDE_PREVIEW';
    const wideResult = await preview(client, {
      ...previewOptions,
      internalTransferMaxTimeDeltaMs: INVARIANT_INTERNAL_TRANSFER_WINDOW_MS,
    });
    const safe = matchingWindowInvariantHolds(narrowResult, wideResult)
      ? sanitizeReadOnlyPreview(narrowResult)
      : sanitizeReadOnlyPreview({
        modelVersion: MATCHED_PURCHASE_ORCHESTRATION_VERSION,
        readiness: 'REVIEW_REQUIRED',
        reasonCode: 'MATCHING_WINDOW_INVARIANCE_MISMATCH',
        summary: narrowResult?.summary,
      });
    await client.query('ROLLBACK');
    transactionOpen = false;
    return safe;
  } catch (error) {
    Object.defineProperty(error, PREVIEW_FAILURE_STAGE, { value: stage, configurable: true });
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        Object.defineProperty(error, PREVIEW_FAILURE_STAGE, { value: 'ROLLBACK', configurable: true });
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return { help: true };
    if (!['--scope-key', '--from', '--to'].includes(arg)) throw new Error('only --scope-key, --from and --to are supported');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    values[arg.slice(2)] = value;
    index += 1;
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  let pool = null;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write('Usage: node scripts/matched-purchase-preview-read-only.mjs --scope-key <scope> --from <ISO> --to <ISO>\n');
      return 0;
    }
    pool = createPool({ max: 1, connectionTimeoutMillis: 10000 });
    const result = await runReadOnlyMatchedPurchasePreview(pool, args);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return result.readiness === 'READY' ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'TECHNICAL_ERROR', reasonCode: 'READ_ONLY_PREVIEW_FAILED', stage: previewFailureStage(error), data: null })}\n`);
    return 1;
  } finally {
    await pool?.end().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}

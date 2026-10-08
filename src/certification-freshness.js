import { certificationSourceStateKey, CERTIFICATION_MODEL_VERSION } from './certification.js';
import { resolveCurrentSpendingSnapshotOnClient } from './canonical-spending-current-snapshot.js';

export const CERTIFICATION_FRESHNESS_MODEL = 'certification-freshness-monitoring-v1';
export const CERTIFICATION_FRESHNESS_STATUS = Object.freeze({
  READY: 'READY',
  STALE: 'STALE',
  MISSING: 'MISSING',
  CONFLICT: 'CONFLICT',
  CORRUPT: 'CORRUPT',
  TECHNICAL_ERROR: 'TECHNICAL_ERROR',
});

const positiveTimeout = (value, name) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
};

const SOURCE_STATE_KEY_PATTERN = /^[0-9a-f]{64}$/;

const isValidSourceStateKey = (value) => typeof value === 'string' && SOURCE_STATE_KEY_PATTERN.test(value);

export function classifyCertificationFreshness({ reader, exactRuns = [], previousReadyRun = null, sourceStateKey = null }) {
  const runs = Array.isArray(exactRuns) ? exactRuns : [];
  const identityConflict = !isValidSourceStateKey(sourceStateKey)
    || runs.some((run) => !isValidSourceStateKey(run?.source_state_key) || run.source_state_key !== sourceStateKey)
    || (previousReadyRun && !isValidSourceStateKey(previousReadyRun.source_state_key));
  const previousRunId = previousReadyRun?.id ?? null;
  if (identityConflict) {
    return { status: CERTIFICATION_FRESHNESS_STATUS.CORRUPT, reasonCode: 'SOURCE_STATE_IDENTITY_MISMATCH', currentRunId: runs[0]?.id ?? null, previousRunId };
  }
  if (reader?.reasonCode === 'CERTIFICATION_CONFLICT' || runs.length > 1) {
    return { status: CERTIFICATION_FRESHNESS_STATUS.CONFLICT, reasonCode: 'CERTIFICATION_CONFLICT', currentRunId: null, previousRunId };
  }
  if (reader?.reasonCode === 'CORRUPT_SNAPSHOT' || reader?.reasonCode === 'STALE_SNAPSHOT') {
    return { status: CERTIFICATION_FRESHNESS_STATUS.CORRUPT, reasonCode: 'CORRUPT_SNAPSHOT', currentRunId: runs[0]?.id ?? null, previousRunId };
  }
  if (runs.length === 1 && (runs[0].status !== 'READY' || !runs[0].finished_at)) {
    return { status: CERTIFICATION_FRESHNESS_STATUS.CORRUPT, reasonCode: 'CORRUPT_SNAPSHOT', currentRunId: runs[0].id, previousRunId };
  }
  const readerState = reader?.status ?? reader?.reasonCode ?? null;
  const knownNonReadyStates = new Set(['NO_CURRENT_CERTIFICATION', 'STALE_SNAPSHOT', 'CORRUPT_SNAPSHOT', 'CERTIFICATION_CONFLICT']);
  if (!reader || typeof reader.ok !== 'boolean' || (reader.ok && reader.status !== 'READY') || (!reader.ok && !knownNonReadyStates.has(readerState) && readerState !== 'READ_ONLY_PROBE_ERROR' && readerState !== 'READ_ONLY_TIMEOUT')) {
    return { status: CERTIFICATION_FRESHNESS_STATUS.TECHNICAL_ERROR, reasonCode: 'READ_ONLY_UNEXPECTED_READER_STATE', currentRunId: null, previousRunId };
  }
  if (reader.ok && reader.status === 'READY') {
    const snapshotMatches = reader.snapshot
      && reader.snapshot.sourceStateKey === sourceStateKey
      && runs.length === 1
      && reader.snapshot.runId === runs[0].id;
    if (!snapshotMatches) {
      return { status: CERTIFICATION_FRESHNESS_STATUS.CORRUPT, reasonCode: 'CORRUPT_SNAPSHOT', currentRunId: runs[0]?.id ?? null, previousRunId };
    }
    return { status: CERTIFICATION_FRESHNESS_STATUS.READY, reasonCode: null, currentRunId: reader.snapshot.runId, previousRunId };
  }
  if (readerState === 'CERTIFICATION_CONFLICT') {
    return { status: CERTIFICATION_FRESHNESS_STATUS.CONFLICT, reasonCode: 'CERTIFICATION_CONFLICT', currentRunId: null, previousRunId };
  }
  if (readerState === 'CORRUPT_SNAPSHOT' || readerState === 'STALE_SNAPSHOT') {
    return { status: CERTIFICATION_FRESHNESS_STATUS.CORRUPT, reasonCode: 'CORRUPT_SNAPSHOT', currentRunId: runs[0]?.id ?? null, previousRunId };
  }
  if (readerState === 'NO_CURRENT_CERTIFICATION') {
    if (runs.length === 1) {
      return { status: CERTIFICATION_FRESHNESS_STATUS.CORRUPT, reasonCode: 'CORRUPT_SNAPSHOT', currentRunId: runs[0].id, previousRunId };
    }
    if (previousReadyRun) {
      return { status: CERTIFICATION_FRESHNESS_STATUS.STALE, reasonCode: 'STALE_SNAPSHOT', currentRunId: null, previousRunId: previousReadyRun.id };
    }
    return { status: CERTIFICATION_FRESHNESS_STATUS.MISSING, reasonCode: 'NO_CURRENT_CERTIFICATION', currentRunId: null, previousRunId: null };
  }
  return { status: CERTIFICATION_FRESHNESS_STATUS.TECHNICAL_ERROR, reasonCode: 'READ_ONLY_PROBE_ERROR', currentRunId: null, previousRunId };
}

const safeErrorReason = (error) => ['57014', '55P03'].includes(error?.code) ? 'READ_ONLY_TIMEOUT' : 'READ_ONLY_PROBE_ERROR';

export async function inspectCertificationFreshness(pool, { scopeKey = 'default', statementTimeoutMs = 120000, lockTimeoutMs = 5000 } = {}) {
  const statementTimeout = positiveTimeout(statementTimeoutMs, 'statementTimeoutMs');
  const lockTimeout = positiveTimeout(lockTimeoutMs, 'lockTimeoutMs');
  const checkedAt = new Date().toISOString();
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${statementTimeout}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${Math.min(lockTimeout, statementTimeout)}ms'`);
    const scope = (await client.query('SELECT id,scope_key FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
    if (!scope) {
      await client.query('ROLLBACK');
      return { ok: false, modelVersion: CERTIFICATION_FRESHNESS_MODEL, status: CERTIFICATION_FRESHNESS_STATUS.MISSING, reasonCode: 'SCOPE_NOT_FOUND', scopeKey, sourceStateKey: null, currentRunId: null, previousRunId: null, checkedAt };
    }
    const sourceStateKey = await certificationSourceStateKey(client, Number(scope.id));
    const runs = (await client.query(`SELECT id,status,source_state_key,started_at,finished_at
      FROM reconciliation_runs
      WHERE scope_id=$1 AND model_version=$2 AND period_from IS NULL AND period_to IS NULL
      ORDER BY id`, [scope.id, CERTIFICATION_MODEL_VERSION])).rows.map((row) => ({ ...row, id: Number(row.id) }));
    const exactRuns = runs.filter((run) => run.source_state_key === sourceStateKey);
    const previousReadyRun = [...runs].reverse().find((run) => run.status === 'READY' && run.finished_at && run.source_state_key !== sourceStateKey) ?? null;
    const reader = await resolveCurrentSpendingSnapshotOnClient(client, { scopeKey, sourceStateKey });
    const classified = classifyCertificationFreshness({ reader, exactRuns, previousReadyRun, sourceStateKey });
    const result = { ok: classified.status === CERTIFICATION_FRESHNESS_STATUS.READY, modelVersion: CERTIFICATION_FRESHNESS_MODEL, status: classified.status, reasonCode: classified.reasonCode, scopeKey, scopeId: Number(scope.id), sourceStateKey, currentRunId: classified.currentRunId, previousRunId: classified.previousRunId, checkedAt };
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    return { ok: false, modelVersion: CERTIFICATION_FRESHNESS_MODEL, status: CERTIFICATION_FRESHNESS_STATUS.TECHNICAL_ERROR, reasonCode: safeErrorReason(error), scopeKey, sourceStateKey: null, currentRunId: null, previousRunId: null, checkedAt };
  } finally {
    client?.release();
  }
}

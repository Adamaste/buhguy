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

export function classifyCertificationFreshness({ reader, exactRuns, previousReadyRun }) {
  if (reader?.ok && reader.status === 'READY') {
    return { status: CERTIFICATION_FRESHNESS_STATUS.READY, reasonCode: null, currentRunId: reader.snapshot.runId, previousRunId: previousReadyRun?.id ?? null };
  }
  if (reader?.reasonCode === 'CERTIFICATION_CONFLICT' || exactRuns.length > 1) {
    return { status: CERTIFICATION_FRESHNESS_STATUS.CONFLICT, reasonCode: 'CERTIFICATION_CONFLICT', currentRunId: null, previousRunId: previousReadyRun?.id ?? null };
  }
  if (reader?.reasonCode === 'CORRUPT_SNAPSHOT' || (exactRuns.length === 1 && exactRuns[0].status !== 'READY')) {
    return { status: CERTIFICATION_FRESHNESS_STATUS.CORRUPT, reasonCode: 'CORRUPT_SNAPSHOT', currentRunId: exactRuns[0]?.id ?? null, previousRunId: previousReadyRun?.id ?? null };
  }
  if (previousReadyRun) {
    return { status: CERTIFICATION_FRESHNESS_STATUS.STALE, reasonCode: 'STALE_SNAPSHOT', currentRunId: null, previousRunId: previousReadyRun.id };
  }
  return { status: CERTIFICATION_FRESHNESS_STATUS.MISSING, reasonCode: 'NO_CURRENT_CERTIFICATION', currentRunId: null, previousRunId: null };
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
    const classified = classifyCertificationFreshness({ reader, exactRuns, previousReadyRun });
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


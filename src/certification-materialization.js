import {
  CERTIFICATION_MODEL_VERSION,
  certificationResultSemanticKey,
  certificationSourceStateKey,
  rebuildCertification,
} from './certification.js';

export const CERTIFICATION_MATERIALIZATION_VERSION = 'canonical-spending-certification-materialization-v1';

const FACT_FIELDS = ['run_id', 'scope_id', 'subject_type', 'subject_id', 'metric_code', 'dimension', 'status', 'amount', 'currency', 'event_at', 'reason_code', 'rule_code', 'rule_version', 'ledger_entry_id', 'business_event_id', 'graph_evidence_id', 'semantic_key', 'source_state_key'];
const RESULT_FIELDS = ['run_id', 'metric_code', 'status', 'amount', 'currency', 'count_items', 'reason_code', 'semantic_key'];
const SOURCE_STATE_KEY_PATTERN = /^[0-9a-f]{64}$/i;

const canonicalValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  return String(value);
};

const canonicalRows = (rows, fields) => rows
  .map((row) => Object.fromEntries(fields.map((field) => [field, canonicalValue(row[field])])))
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

const materializationError = (message, code = 'CERTIFICATION_MATERIALIZATION_CONFLICT') => Object.assign(new Error(message), { code });

function expectedFactRows(runId, facts) {
  return facts.map((fact) => ({
    run_id: runId,
    scope_id: fact.scopeId,
    subject_type: fact.subjectType,
    subject_id: fact.subjectId,
    metric_code: fact.metricCode,
    dimension: fact.dimension,
    status: fact.status,
    amount: fact.amount,
    currency: fact.currency,
    event_at: fact.eventAt,
    reason_code: fact.reasonCode,
    rule_code: fact.ruleCode,
    rule_version: fact.ruleVersion,
    ledger_entry_id: fact.ledgerEntryId,
    business_event_id: fact.businessEventId,
    graph_evidence_id: fact.graphEvidenceId,
    semantic_key: fact.semanticKey,
    source_state_key: fact.sourceStateKey,
  }));
}

function expectedResultRows(runId, results) {
  return results.map((result) => ({
    run_id: runId,
    metric_code: result.metricCode,
    status: result.status,
    amount: result.amount,
    currency: result.currency,
    count_items: result.countItems,
    reason_code: result.reasonCode,
    semantic_key: certificationResultSemanticKey(result, runId),
  }));
}

async function persistedRows(client, runId) {
  const facts = (await client.query(`SELECT run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key
    FROM certification_facts WHERE run_id=$1`, [runId])).rows;
  const results = (await client.query(`SELECT run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key
    FROM reconciliation_results WHERE run_id=$1`, [runId])).rows;
  return { facts, results };
}

async function independentlyObservedSourceState(pool, scopeId, statementTimeoutMs) {
  const verifier = await pool.connect();
  try {
    await verifier.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await verifier.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    await verifier.query(`SET LOCAL lock_timeout = '${Math.min(statementTimeoutMs, 5000)}ms'`);
    const key = await certificationSourceStateKey(verifier, scopeId);
    await verifier.query('COMMIT');
    return key;
  } catch (error) {
    try { await verifier.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    verifier.release();
  }
}

function assertDeadline(deadline) {
  if (Date.now() > deadline) throw materializationError('Certification materialization exceeded its overall timeout', 'CERTIFICATION_MATERIALIZATION_TIMEOUT');
}

async function postCommitState(client, scopeId, expectedSourceStateKey, statementTimeoutMs) {
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${Math.min(statementTimeoutMs, 5000)}ms'`);
    const currentSourceStateKey = await certificationSourceStateKey(client, scopeId);
    await client.query('COMMIT');
    return { postCommitSourceStateKey: currentSourceStateKey, postCommitCurrent: currentSourceStateKey === expectedSourceStateKey };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    return { postCommitSourceStateKey: null, postCommitCurrent: null, postCommitCheckError: error.code ?? 'POSTCOMMIT_READ_FAILED' };
  }
}

function assertPersistedProjection(run, projection, persisted) {
  if (run.status !== 'READY' || run.period_from !== null || run.period_to !== null || !run.finished_at) {
    throw materializationError(`Certification run ${run.id} is not a complete unbounded READY run`);
  }
  const factsMatch = JSON.stringify(canonicalRows(persisted.facts, FACT_FIELDS))
    === JSON.stringify(canonicalRows(expectedFactRows(Number(run.id), projection.facts), FACT_FIELDS));
  const resultsMatch = JSON.stringify(canonicalRows(persisted.results, RESULT_FIELDS))
    === JSON.stringify(canonicalRows(expectedResultRows(Number(run.id), projection.results), RESULT_FIELDS));
  if (!factsMatch || !resultsMatch) throw materializationError(`Certification run ${run.id} does not match the authoritative projection`);
}

async function materialize(pool, { scopeKey = 'default', expectedSourceStateKey, lockTimeoutMs = 5000, statementTimeoutMs = 120000, overallTimeoutMs = 180000, failAfter = null, beforeProjection = null, afterProjection = null } = {}) {
  if (!SOURCE_STATE_KEY_PATTERN.test(expectedSourceStateKey ?? '')) {
    throw materializationError('An explicit SHA-256 expectedSourceStateKey is required', 'CERTIFICATION_EXPECTED_SOURCE_STATE_REQUIRED');
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0 || !Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0 || !Number.isInteger(overallTimeoutMs) || overallTimeoutMs <= 0) {
    throw materializationError('Materialization timeouts must be positive integers', 'CERTIFICATION_MATERIALIZATION_INVALID_OPTIONS');
  }
  const deadline = Date.now() + overallTimeoutMs;
  const client = await pool.connect();
  let destroyClient = false;
  let supportsTransactionTimeout = false;
  let transactionTimeoutConfigured = false;
  // PostgreSQL 18 terminates the backend for transaction_timeout instead of
  // returning a query error. Keep that expected disconnect from becoming an
  // unhandled client error while the catch block maps it safely below.
  client.on('error', () => {});
  try {
    const serverVersionNum = Number((await client.query('SHOW server_version_num')).rows[0]?.server_version_num ?? 0);
    supportsTransactionTimeout = serverVersionNum >= 170000;
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${supportsTransactionTimeout ? statementTimeoutMs : Math.min(statementTimeoutMs, overallTimeoutMs)}ms'`);
    if (supportsTransactionTimeout) {
      await client.query(`SET LOCAL transaction_timeout = '${overallTimeoutMs}ms'`);
      transactionTimeoutConfigured = true;
    }
    const scope = (await client.query('SELECT id,scope_key FROM accounting_scopes WHERE scope_key=$1 FOR UPDATE', [scopeKey])).rows[0];
    if (!scope) throw materializationError(`Accounting scope not found: ${scopeKey}`, 'CERTIFICATION_SCOPE_NOT_FOUND');

    const sourceStateKey = await certificationSourceStateKey(client, Number(scope.id));
    if (sourceStateKey !== expectedSourceStateKey) throw materializationError('Expected source state differs from the authoritative transaction snapshot', 'CERTIFICATION_SOURCE_STATE_CONFLICT');
    if (beforeProjection) await beforeProjection(client, { supportsTransactionTimeout });
    const projection = await rebuildCertification(client, { scopeKey, persist: false, sourceStateKey });
    if (projection.sourceStateKey !== sourceStateKey) throw materializationError('Projection source state differs from the locked source state', 'CERTIFICATION_SOURCE_STATE_CONFLICT');
    if (afterProjection) await afterProjection();
    assertDeadline(deadline);
    const recheckedSourceStateKey = await certificationSourceStateKey(client, Number(scope.id));
    if (recheckedSourceStateKey !== sourceStateKey) throw materializationError('Source state changed during materialization', 'CERTIFICATION_SOURCE_STATE_CONFLICT');
    const independentlyObservedKey = await independentlyObservedSourceState(pool, Number(scope.id), statementTimeoutMs);
    if (independentlyObservedKey !== sourceStateKey) throw materializationError('Source state changed outside the materialization snapshot', 'CERTIFICATION_SOURCE_STATE_CONFLICT');
    assertDeadline(deadline);

    const existing = (await client.query(`SELECT * FROM reconciliation_runs
      WHERE scope_id=$1 AND model_version=$2 AND source_state_key=$3
        AND period_from IS NULL AND period_to IS NULL
      FOR UPDATE`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey])).rows;
    if (existing.length > 1) throw materializationError(`Multiple current certification runs exist for scope ${scope.id}`);
    if (existing.length === 1) {
      const run = existing[0];
      const persisted = await persistedRows(client, Number(run.id));
      assertPersistedProjection(run, projection, persisted);
      assertDeadline(deadline);
      await client.query('COMMIT');
      return { materialized: false, reused: true, runId: Number(run.id), sourceStateKey, facts: persisted.facts.length, results: persisted.results.length, ...(await postCommitState(client, Number(scope.id), sourceStateKey, statementTimeoutMs)) };
    }

    assertDeadline(deadline);
    const run = (await client.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,period_from,period_to,status,finished_at)
      VALUES($1,$2,$3,NULL,NULL,'READY',NOW()) RETURNING *`, [scope.id, CERTIFICATION_MODEL_VERSION, sourceStateKey])).rows[0];
    if (failAfter === 'run') throw materializationError('Injected materialization failure after run', 'INJECTED_CERTIFICATION_MATERIALIZATION_FAILURE');
    for (const fact of projection.facts) {
      assertDeadline(deadline);
      await client.query(`INSERT INTO certification_facts(run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [run.id, fact.scopeId, fact.subjectType, fact.subjectId, fact.metricCode, fact.dimension, fact.status, fact.amount, fact.currency, fact.eventAt, fact.reasonCode, fact.ruleCode, fact.ruleVersion, fact.ledgerEntryId, fact.businessEventId, fact.graphEvidenceId, fact.semanticKey, fact.sourceStateKey]);
      if (failAfter === 'facts') throw materializationError('Injected materialization failure after facts', 'INJECTED_CERTIFICATION_MATERIALIZATION_FAILURE');
    }
    for (const result of projection.results) {
      assertDeadline(deadline);
      await client.query(`INSERT INTO reconciliation_results(run_id,metric_code,status,amount,currency,count_items,reason_code,semantic_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [run.id, result.metricCode, result.status, result.amount, result.currency, result.countItems, result.reasonCode, certificationResultSemanticKey(result, run.id)]);
    }
    if (failAfter === 'results') throw materializationError('Injected materialization failure after results', 'INJECTED_CERTIFICATION_MATERIALIZATION_FAILURE');
    const persisted = await persistedRows(client, Number(run.id));
    assertPersistedProjection(run, projection, persisted);
    assertDeadline(deadline);
    await client.query('COMMIT');
    return { materialized: true, reused: false, runId: Number(run.id), sourceStateKey, facts: persisted.facts.length, results: persisted.results.length, ...(await postCommitState(client, Number(scope.id), sourceStateKey, statementTimeoutMs)) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    if (supportsTransactionTimeout && transactionTimeoutConfigured
      && ['Connection terminated unexpectedly', 'terminating connection due to transaction timeout'].includes(error?.message)) {
      destroyClient = true;
      throw materializationError('Certification materialization transaction timeout', 'CERTIFICATION_MATERIALIZATION_TIMEOUT');
    }
    if (error?.code === '40001' || error?.code === '40P01') {
      throw materializationError('Concurrent source or lock conflict; retry only after a fresh read-only precheck', 'CERTIFICATION_MATERIALIZATION_RETRY_REQUIRED');
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

export async function materializeCurrentCertification(pool, options = {}) {
  return materialize(pool, {
    scopeKey: options.scopeKey,
    expectedSourceStateKey: options.expectedSourceStateKey,
    lockTimeoutMs: options.lockTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs,
    overallTimeoutMs: options.overallTimeoutMs,
  });
}

export async function materializeCurrentCertificationForTest(pool, options = {}) {
  return materialize(pool, options);
}

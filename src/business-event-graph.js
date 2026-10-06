import { fiscalContentFingerprint } from './fiscal-evidence.js';

export const GRAPH_MODEL_VERSION = 'business-graph-v1';
export const SYSTEM_DERIVED = 'SYSTEM_DERIVED';
export const MANUAL = 'MANUAL';
export const EXTERNAL_CONFIRMED = 'EXTERNAL_CONFIRMED';

const RESOLUTION_STATUSES = new Set(['CANDIDATE', 'CONFIRMED', 'AMBIGUOUS', 'REJECTED', 'SUPERSEDED']);
const ORIGINS = new Set([SYSTEM_DERIVED, MANUAL, EXTERNAL_CONFIRMED]);

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

function validateProvenance(input, { requireResolutionStatus = true } = {}) {
  requireValue(input.graphModelVersion, 'graphModelVersion');
  requireValue(input.ruleCode, 'ruleCode');
  requireValue(input.ruleVersion, 'ruleVersion');
  requireValue(input.origin, 'origin');
  if (requireResolutionStatus) {
    requireValue(input.resolutionStatus, 'resolutionStatus');
    if (!RESOLUTION_STATUSES.has(input.resolutionStatus)) throw new Error('Unsupported resolution status');
  }
  if (!ORIGINS.has(input.origin)) throw new Error('Unsupported graph origin');
}

function keyFor(kind, input) {
  if (input.semanticKey && /^[0-9a-f]{64}$/i.test(input.semanticKey)) return input.semanticKey.toLowerCase();
  return fiscalContentFingerprint({ providedSemanticKey: input.semanticKey ?? null, kind, scopeKey: input.scopeKey, eventId: input.eventId, sourceEventId: input.sourceEventId, targetEventId: input.targetEventId, eventType: input.eventType, relationType: input.relationType, evidenceRole: input.evidenceRole, receiptId: input.receiptId, receiptItemId: input.receiptItemId, normalizationVersion: input.normalizationVersion, targetEventSemanticKey: input.targetEventSemanticKey, sourceReceiptId: input.sourceReceiptId, sourceReceiptItemId: input.sourceReceiptItemId, allocatedQuantity: input.allocatedQuantity ?? null, allocatedAmount: input.allocatedAmount ?? null, currency: input.currency ?? null, allocationRole: input.allocationRole ?? null, graphModelVersion: input.graphModelVersion, ruleCode: input.ruleCode, ruleVersion: input.ruleVersion, origin: input.origin, resolutionStatus: input.resolutionStatus });
}

export function businessEventEvidenceSemanticKey(input) {
  return keyFor('evidence', input);
}

function statusFrom(row) { return row ? { ...row, id: Number(row.id), scope_id: Number(row.scope_id) } : null; }

export class BusinessEventGraphRepository {
  constructor(pool) { this.pool = pool; }

  async withTransaction(callback) {
    const client = await this.pool.connect();
    const txRepository = new BusinessEventGraphRepository({ query: client.query.bind(client), connect: async () => client });
    try { await client.query('BEGIN'); const result = await callback(txRepository); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async ensureScope(scopeKey, label = null) {
    requireValue(scopeKey, 'scopeKey');
    const result = await this.pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) ON CONFLICT(scope_key) DO UPDATE SET label=COALESCE(accounting_scopes.label,EXCLUDED.label) RETURNING id,scope_key,label', [scopeKey, label]);
    return result.rows[0];
  }

  async registerRule(ruleCode, ruleVersion, description) {
    requireValue(ruleCode, 'ruleCode'); requireValue(ruleVersion, 'ruleVersion'); requireValue(description, 'description');
    const result = await this.pool.query('INSERT INTO business_graph_rules(rule_code,rule_version,description) VALUES($1,$2,$3) ON CONFLICT(rule_code,rule_version) DO UPDATE SET description=EXCLUDED.description RETURNING rule_code,rule_version,description', [ruleCode, ruleVersion, description]);
    return result.rows[0];
  }

  async createEvent(input) {
    validateProvenance(input); requireValue(input.scopeKey, 'scopeKey'); requireValue(input.eventType, 'eventType');
    const scope = await this.ensureScope(input.scopeKey, input.scopeLabel);
    await this.registerRule(input.ruleCode, input.ruleVersion, input.ruleDescription ?? `${input.ruleCode} ${input.ruleVersion}`);
    const semanticKey = keyFor('event', input);
    const result = await this.pool.query(`INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(scope_id,semantic_key,graph_model_version,rule_code,rule_version,origin) DO UPDATE SET description=COALESCE(business_events.description,EXCLUDED.description)
      RETURNING id,scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description,(xmax=0) AS created`, [scope.id, input.eventType, input.resolutionStatus, input.origin, input.graphModelVersion, input.ruleCode, input.ruleVersion, semanticKey, input.amount ?? null, input.currency ?? null, input.description ?? null]);
    const row = statusFrom(result.rows[0]);
    return { ...row, created: result.rows[0].created };
  }

  async createEvidenceLink(input) {
    validateProvenance(input, { requireResolutionStatus: false }); requireValue(input.eventId, 'eventId'); requireValue(input.normalizationVersion, 'normalizationVersion');
    if (input.receiptId === undefined && input.receiptItemId === undefined) throw new Error('receiptId or receiptItemId is required');
    const semanticKey = businessEventEvidenceSemanticKey(input);
    const result = await this.pool.query(`INSERT INTO business_event_evidence(event_id,receipt_id,receipt_item_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(semantic_key) DO NOTHING
      RETURNING *`, [input.eventId, input.receiptId ?? null, input.receiptItemId ?? null, input.normalizationVersion, input.evidenceRole, input.origin, input.graphModelVersion, input.ruleCode, input.ruleVersion, semanticKey]);
    if (result.rowCount) return { ...result.rows[0], id: Number(result.rows[0].id), created: true };
    const existing = await this.pool.query('SELECT * FROM business_event_evidence WHERE semantic_key=$1', [semanticKey]);
    return { ...existing.rows[0], id: Number(existing.rows[0].id), created: false };
  }

  async createEdge(input) {
    validateProvenance(input); requireValue(input.scopeKey, 'scopeKey'); requireValue(input.sourceEventId, 'sourceEventId'); requireValue(input.targetEventId, 'targetEventId'); requireValue(input.relationType, 'relationType');
    if (input.sourceEventId === input.targetEventId) throw new Error('Self edges are not allowed');
    const scope = await this.ensureScope(input.scopeKey);
    const scopeCheck = await this.pool.query('SELECT count(*) FILTER (WHERE scope_id=$1) AS in_scope, count(*) AS total FROM business_events WHERE id IN ($2,$3)', [scope.id, input.sourceEventId, input.targetEventId]);
    if (Number(scopeCheck.rows[0].in_scope) !== 2 || Number(scopeCheck.rows[0].total) !== 2) throw new Error('Cross-scope or missing event edge');
    const semanticKey = keyFor('edge', input);
    const result = await this.pool.query(`INSERT INTO business_event_edges(scope_id,source_event_id,target_event_id,relation_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,explanation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(semantic_key) DO NOTHING RETURNING *`, [scope.id, input.sourceEventId, input.targetEventId, input.relationType, input.resolutionStatus, input.origin, input.graphModelVersion, input.ruleCode, input.ruleVersion, semanticKey, input.explanation ?? null]);
    if (result.rowCount) return { ...result.rows[0], id: Number(result.rows[0].id), created: true };
    const existing = await this.pool.query('SELECT * FROM business_event_edges WHERE semantic_key=$1', [semanticKey]);
    return { ...existing.rows[0], id: Number(existing.rows[0].id), created: false };
  }

  async createAllocation(input) {
    validateProvenance(input); requireValue(input.scopeKey, 'scopeKey'); requireValue(input.targetEventId, 'targetEventId'); requireValue(input.normalizationVersion, 'normalizationVersion'); requireValue(input.currency, 'currency'); requireValue(input.allocationRole, 'allocationRole');
    if (input.sourceReceiptId === undefined && input.sourceReceiptItemId === undefined) throw new Error('Source receipt or item is required');
    if (input.allocatedQuantity === undefined && input.allocatedAmount === undefined) throw new Error('Allocated quantity or amount is required');
    const scope = await this.ensureScope(input.scopeKey);
    const semanticKey = keyFor('allocation', input);
    const result = await this.pool.query(`INSERT INTO business_event_allocations(scope_id,target_event_id,source_receipt_id,source_receipt_item_id,normalization_version,allocated_quantity,allocated_amount,currency,allocation_role,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,explanation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT(semantic_key) DO NOTHING RETURNING *`, [scope.id, input.targetEventId, input.sourceReceiptId ?? null, input.sourceReceiptItemId ?? null, input.normalizationVersion, input.allocatedQuantity ?? null, input.allocatedAmount ?? null, input.currency, input.allocationRole, input.resolutionStatus, input.origin, input.graphModelVersion, input.ruleCode, input.ruleVersion, semanticKey, input.explanation ?? null]);
    if (result.rowCount) return { ...result.rows[0], id: Number(result.rows[0].id), created: true };
    const existing = await this.pool.query('SELECT * FROM business_event_allocations WHERE semantic_key=$1', [semanticKey]);
    return { ...existing.rows[0], id: Number(existing.rows[0].id), created: false };
  }

  async inspectEvent(eventId) {
    const event = await this.pool.query('SELECT e.*,s.scope_key FROM business_events e JOIN accounting_scopes s ON s.id=e.scope_id WHERE e.id=$1', [eventId]);
    if (!event.rowCount) return null;
    const [evidence, edges, allocations] = await Promise.all([
      this.pool.query('SELECT * FROM business_event_evidence WHERE event_id=$1 ORDER BY id', [eventId]),
      this.pool.query('SELECT * FROM business_event_edges WHERE source_event_id=$1 OR target_event_id=$1 ORDER BY id', [eventId]),
      this.pool.query('SELECT * FROM business_event_allocations WHERE target_event_id=$1 ORDER BY id', [eventId]),
    ]);
    return { event: statusFrom(event.rows[0]), evidence: evidence.rows, edges: edges.rows, allocations: allocations.rows };
  }

  async rebuildSystemDerived({ scopeKey, graphModelVersion = GRAPH_MODEL_VERSION, ruleCode = null, ruleVersion = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const params = [scopeKey, graphModelVersion];
      const ruleClause = ruleCode && ruleVersion ? ' AND e.rule_code=$3 AND e.rule_version=$4' : '';
      if (ruleClause) params.push(ruleCode, ruleVersion);
      const ids = await client.query(`SELECT e.id FROM business_events e JOIN accounting_scopes s ON s.id=e.scope_id WHERE s.scope_key=$1 AND e.graph_model_version=$2 AND e.origin='SYSTEM_DERIVED'${ruleClause}`, params);
      const eventIds = ids.rows.map((row) => row.id);
      if (eventIds.length) {
        await client.query('DELETE FROM business_event_allocations WHERE target_event_id = ANY($1::bigint[]) AND origin=\'SYSTEM_DERIVED\'', [eventIds]);
        await client.query('DELETE FROM business_event_edges WHERE (source_event_id = ANY($1::bigint[]) OR target_event_id = ANY($1::bigint[])) AND origin=\'SYSTEM_DERIVED\'', [eventIds]);
        await client.query('DELETE FROM business_event_evidence WHERE event_id = ANY($1::bigint[]) AND origin=\'SYSTEM_DERIVED\'', [eventIds]);
        await client.query('DELETE FROM business_events WHERE id = ANY($1::bigint[]) AND origin=\'SYSTEM_DERIVED\'', [eventIds]);
      }
      await client.query('COMMIT');
      return { deletedEvents: eventIds.length };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

export async function validateBusinessEventGraph(pool) {
  const checks = [
    ['dangling_evidence', `SELECT count(*)::int AS count FROM business_event_evidence e LEFT JOIN business_events b ON b.id=e.event_id WHERE b.id IS NULL`],
    ['dangling_edges', `SELECT count(*)::int AS count FROM business_event_edges e LEFT JOIN business_events s ON s.id=e.source_event_id LEFT JOIN business_events t ON t.id=e.target_event_id WHERE s.id IS NULL OR t.id IS NULL`],
    ['duplicate_event_semantic_keys', `SELECT count(*)::int AS count FROM (SELECT scope_id,semantic_key,graph_model_version,rule_code,rule_version,origin FROM business_events GROUP BY 1,2,3,4,5,6 HAVING count(*)>1) q`],
    ['missing_provenance', `SELECT count(*)::int AS count FROM business_events WHERE graph_model_version='' OR rule_code='' OR rule_version='' OR origin IS NULL OR resolution_status IS NULL`],
    ['missing_assertion_provenance', `SELECT count(*)::int AS count FROM (SELECT id FROM business_event_evidence WHERE graph_model_version='' OR rule_code='' OR rule_version='' OR origin IS NULL UNION ALL SELECT id FROM business_event_edges WHERE graph_model_version='' OR rule_code='' OR rule_version='' OR origin IS NULL UNION ALL SELECT id FROM business_event_allocations WHERE graph_model_version='' OR rule_code='' OR rule_version='' OR origin IS NULL) q`],
    ['cross_scope_edges', `SELECT count(*)::int AS count FROM business_event_edges e JOIN business_events s ON s.id=e.source_event_id JOIN business_events t ON t.id=e.target_event_id WHERE s.scope_id<>e.scope_id OR t.scope_id<>e.scope_id`],
    ['self_edges', `SELECT count(*)::int AS count FROM business_event_edges WHERE source_event_id=target_event_id`],
    ['negative_allocations', `SELECT count(*)::int AS count FROM business_event_allocations WHERE allocated_amount<0 OR allocated_quantity<0`],
    ['confirmed_receipt_overallocation', `SELECT count(*)::int AS count FROM (SELECT a.scope_id,a.source_receipt_id,SUM(a.allocated_amount) allocated,MAX(r.total_sum) source_amount FROM business_event_allocations a JOIN receipts r ON r.id=a.source_receipt_id WHERE a.resolution_status='CONFIRMED' GROUP BY a.scope_id,a.source_receipt_id HAVING SUM(a.allocated_amount)>MAX(r.total_sum)) q`],
    ['confirmed_item_overallocation', `SELECT count(*)::int AS count FROM (SELECT a.scope_id,a.source_receipt_item_id,SUM(a.allocated_amount) allocated,MAX(i.item_sum) source_amount,SUM(a.allocated_quantity) qty,MAX(i.quantity) source_qty FROM business_event_allocations a JOIN receipt_items i ON i.id=a.source_receipt_item_id WHERE a.resolution_status='CONFIRMED' GROUP BY a.scope_id,a.source_receipt_item_id HAVING SUM(a.allocated_amount)>MAX(i.item_sum) OR SUM(a.allocated_quantity)>MAX(i.quantity)) q`],
  ];
  const results = {};
  for (const [name, sql] of checks) results[name] = (await pool.query(sql)).rows[0].count;
  return { ok: Object.values(results).every((count) => Number(count) === 0), checks: results };
}

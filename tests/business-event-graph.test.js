import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTERNAL_CONFIRMED, GRAPH_MODEL_VERSION, MANUAL, SYSTEM_DERIVED } from '../src/business-event-graph.js';

test('GRAPH-INV-004: graph provenance constants are explicit and stable', () => {
  assert.equal(GRAPH_MODEL_VERSION, 'business-graph-v1');
  assert.deepEqual([SYSTEM_DERIVED, MANUAL, EXTERNAL_CONFIRMED], ['SYSTEM_DERIVED', 'MANUAL', 'EXTERNAL_CONFIRMED']);
});

test('GRAPH-INV-001/002: migration declares required event types and typed relations', async () => {
  const migration = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../db/migrations/005_business_event_graph.sql', import.meta.url), 'utf8'));
  for (const eventType of ['PURCHASE', 'PAYMENT', 'PREPAYMENT', 'ADVANCE', 'FULFILLMENT', 'RETURN', 'REFUND']) assert.match(migration, new RegExp(`'${eventType}'`));
  for (const relation of ['PAYMENT_FOR', 'PREPAYMENT_FOR', 'FULFILLS', 'RETURNS', 'REFUNDS', 'SETTLES']) assert.match(migration, new RegExp(`'${relation}'`));
  assert.match(migration, /UNIQUE \(scope_id, semantic_key, graph_model_version, rule_code, rule_version, origin\)/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN|DATABASE)/i);
});

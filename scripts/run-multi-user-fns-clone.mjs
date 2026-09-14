import assert from 'node:assert/strict';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { normalizeReceiptDetail } from '../src/normalize.js';
import { FnsSourceObservationConflictError } from '../src/multi-user-errors.js';
import { validateBusinessEventGraph } from '../src/business-event-graph.js';

const pool = createPool({ host: '/var/run/postgresql', database: process.env.CLONE_DB ?? 'finance_receipt_collector_multiuser_clone_20260908', user: 'postgres' });
const repo = new ReceiptRepository(pool);
const count = async (table) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
const snapshot = async () => Object.fromEntries(await Promise.all(['receipts', 'receipt_items', 'receipt_raw', 'receipt_source_observations', 'business_events', 'business_event_evidence', 'business_event_edges', 'business_event_allocations', 'ledger_entries', 'ledger_postings', 'certification_facts'].map(async (table) => [table, await count(table)])));

try {
  await migrate(pool);
  const before = await snapshot();
  const legacy = (await pool.query("SELECT id FROM fns_sources WHERE source_key='legacy-default'")).rows[0];
  assert.ok(legacy, 'legacy source backfill missing');
  assert.equal(before.receipt_source_observations, before.receipts, 'legacy observations must cover every receipt');
  const sourceB = await repo.ensureSource({ sourceKey: 'clone-source-b', sessionRef: 'filesystem:/secure/source-b/session.json', deviceRef: 'filesystem:/secure/source-b/device.json', personKey: 'clone-person-b', personDisplayName: 'Clone person B' });
  const sourceC = await repo.ensureSource({ sourceKey: 'clone-source-c', sessionRef: 'filesystem:/secure/source-c/session.json', personKey: 'clone-person-c' });
  const sourceD = await repo.ensureSource({ sourceKey: 'clone-source-d', sessionRef: 'filesystem:/secure/source-d/session.json', personKey: 'clone-person-d' });
  const rows = (await pool.query('SELECT r.id,r.fns_id,rr.payload FROM receipts r JOIN receipt_raw rr ON rr.receipt_id=r.id ORDER BY r.id LIMIT 2')).rows;
  assert.equal(rows.length, 2);
  const normalized = (row, sourceId) => normalizeReceiptDetail(row.payload, { sourceId });
  const first = rows[0];
  const second = rows[1];
  const shared1 = await repo.upsertObservedBundle({ sourceId: sourceB.id, sourceReceiptId: 'source-b-ref-1', normalized: normalized(first, 'source-b-ref-1'), raw: first.payload });
  const shared2 = await repo.upsertObservedBundle({ sourceId: sourceB.id, sourceReceiptId: 'source-b-ref-1', normalized: normalized(first, 'source-b-ref-1'), raw: first.payload });
  assert.equal(shared1.id, Number(first.id));
  assert.equal(shared1.created, false);
  assert.equal(shared1.observationCreated, true);
  assert.equal(shared2.observationCreated, false);
  const distinct = await repo.upsertObservedBundle({ sourceId: sourceB.id, sourceReceiptId: 'source-b-ref-2', normalized: normalized(second, 'source-b-ref-2'), raw: second.payload });
  assert.equal(distinct.id, Number(second.id));
  assert.equal(distinct.created, false);
  await Promise.all([
    repo.upsertObservedBundle({ sourceId: sourceC.id, sourceReceiptId: 'source-c-ref-1', normalized: normalized(first, 'source-c-ref-1'), raw: first.payload }),
    repo.upsertObservedBundle({ sourceId: sourceD.id, sourceReceiptId: 'source-d-ref-1', normalized: normalized(first, 'source-d-ref-1'), raw: first.payload }),
  ]);
  await assert.rejects(() => repo.upsertObservedBundle({ sourceId: sourceB.id, sourceReceiptId: 'source-b-ref-1', normalized: normalized(second, 'source-b-ref-1'), raw: second.payload }), (error) => error instanceof FnsSourceObservationConflictError);
  await repo.updateSourceSyncState(legacy.id, { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), fetched: 1, inserted: 0, replayed: 1 });
  await repo.updateSourceSyncState(sourceB.id, { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: 'synthetic isolated failure', errorClass: 'SYNTHETIC', fetched: 0 });
  const sourceStates = (await pool.query('SELECT s.source_key,st.last_error,st.last_error_class FROM fns_sources s JOIN fns_source_sync_state st ON st.fns_source_id=s.id WHERE s.source_key IN ($1,$2) ORDER BY s.source_key', ['legacy-default', 'clone-source-b'])).rows;
  assert.equal(sourceStates.length, 2);
  assert.equal(sourceStates.find((row) => row.source_key === 'clone-source-b').last_error_class, 'SYNTHETIC');
  const after = await snapshot();
  const graph = await validateBusinessEventGraph(pool);
  assert.equal(graph.ok, true);
  assert.equal(after.receipts, before.receipts);
  assert.equal(after.receipt_items, before.receipt_items);
  assert.equal(after.receipt_raw, before.receipt_raw);
  assert.equal(after.business_events, before.business_events);
  assert.equal(after.business_event_evidence, before.business_event_evidence);
  assert.equal(after.business_event_edges, before.business_event_edges);
  assert.equal(after.business_event_allocations, before.business_event_allocations);
  assert.equal(after.ledger_entries, before.ledger_entries);
  assert.equal(after.ledger_postings, before.ledger_postings);
  assert.equal(after.certification_facts, before.certification_facts);
  const duplicateFns = Number((await pool.query('SELECT count(*)::int AS n FROM (SELECT fns_id FROM receipts GROUP BY fns_id HAVING count(*)>1) q')).rows[0].n);
  const duplicateTuple = Number((await pool.query('SELECT count(*)::int AS n FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL AND fiscal_document_number IS NOT NULL AND fiscal_sign IS NOT NULL GROUP BY 1,2,3 HAVING count(*)>1) q')).rows[0].n);
  assert.equal(duplicateFns, 0);
  assert.equal(duplicateTuple, 0);
  const objectChecks = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('persons','fns_sources','fns_source_person','receipt_source_observations','fns_source_sync_state') ORDER BY table_name")).rows.map((row) => row.table_name);
  console.log(JSON.stringify({ pass: true, before, after, duplicateFns, duplicateTuple, graph, objectChecks, sourceStates }, null, 2));
} finally { await pool.end(); }

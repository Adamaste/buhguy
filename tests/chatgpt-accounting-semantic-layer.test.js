import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'db/analytics/010_chatgpt_accounting_semantic_layer.sql'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'docs/blazesql-accounting-selection.md'), 'utf8');

const views = [
  'receipts', 'receipt_items', 'receipt_fiscal_facts', 'receipt_item_fiscal_facts',
  'normalization_issues', 'business_events', 'business_event_evidence',
  'business_event_edges', 'business_event_allocations', 'ledger_accounts',
  'ledger_entries', 'ledger_postings', 'ledger_source_links', 'certification_facts',
  'receipt_source_observations', 'user_receipts', 'fns_source_receipt_refs', 'persons', 'fns_sources',
  'fns_source_person', 'fns_source_sync_state', 'analytics_purchases',
  'analytics_purchase_items', 'reconciliation_runs', 'reconciliation_results',
  'bank_sources', 'bank_transactions'
];

test('semantic layer exposes the complete safe view manifest', () => {
  for (const view of views) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE VIEW chatgpt_accounting\\.${view}\\b`));
    assert.match(manifest, new RegExp(`chatgpt_accounting\\.${view.replaceAll('_', '\\_')}`));
  }
});

test('semantic layer never exposes raw payload or auth material', () => {
  const definitions = sql.split('COMMENT ON SCHEMA')[0];
  assert.doesNotMatch(definitions, /receipt_raw/i);
  assert.doesNotMatch(definitions, /receipt_raw|payload|session_ref|device_ref|token|cookie|password|secret/i);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE)/i);
  assert.doesNotMatch(sql, /CREATE\s+(?:ROLE|USER)/i);
  assert.match(sql, /GRANT USAGE ON SCHEMA chatgpt_accounting TO chatgpt_reader/);
  assert.match(sql, /GRANT SELECT ON[\s\S]+TO chatgpt_reader/);
  assert.match(sql, /REVOKE SELECT ON public\.analytics_purchases, public\.analytics_purchase_items FROM chatgpt_reader/);
});

test('user receipt view is active-source scoped and deduplicates household provenance', () => {
  assert.match(sql, /CREATE OR REPLACE VIEW chatgpt_accounting\.user_receipts/);
  assert.match(sql, /JOIN public\.fns_sources s ON s\.id = o\.fns_source_id AND s\.enabled/);
  assert.match(sql, /DISTINCT ON \(p\.id, r\.id\)/);
  assert.match(sql, /Canonical receipt inventory by household person/);
  assert.match(sql, /analytics_purchases is a derived economic-purchase view/);
});

test('rollback is limited to the semantic layer schema', () => {
  const rollback = fs.readFileSync(path.join(root, 'db/analytics/010_chatgpt_accounting_semantic_layer.rollback.sql'), 'utf8');
  assert.match(rollback, /DROP SCHEMA IF EXISTS chatgpt_accounting CASCADE/);
  assert.doesNotMatch(rollback, /DROP TABLE|DELETE FROM|TRUNCATE|ALTER TABLE/i);
  assert.doesNotMatch(rollback, /public\.(?:receipts|receipt_items|receipt_raw)/i);
});

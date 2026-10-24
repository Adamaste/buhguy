import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('purchase details SQL exposes only curated non-raw columns', async () => {
  const sql = await fs.readFile(new URL('../db/analytics/009_purchase_details_v1.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE OR REPLACE VIEW analytics_purchases/);
  assert.match(sql, /CREATE OR REPLACE VIEW analytics_purchase_items/);
  assert.match(sql, /CONFIRMED_ACQUISITION_VALUE/);
  assert.match(sql, /bank_merchant\.merchant AS bank_merchant/);
  assert.match(sql, /bank_merchant_source/);
  assert.match(sql, /bank_merchant\.source_type AS bank_merchant_source/);
  assert.match(sql, /merchant_display_source/);
  assert.match(sql, /business_event_bank_evidence/);
  assert.match(sql, /count\(DISTINCT bt\.id\) = 1/);
  assert.match(sql, /count\(DISTINCT NULLIF\(btrim\(bt\.merchant\), ''\)\) = 1/);
  assert.match(sql, /JOIN bank_sources bs ON bs\.id = beo\.bank_source_id/);
  assert.match(sql, /COALESCE\(bank_merchant\.merchant, NULLIF\(btrim\(r\.seller\), ''\)\)/);
  assert.doesNotMatch(sql, /\b(receipt_raw|payload|token|cookie)\b/i);
  assert.doesNotMatch(sql, /total_sum\s+AS|purchase_total/i);
});

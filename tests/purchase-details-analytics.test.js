import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('purchase details SQL exposes only curated non-raw columns', async () => {
  const sql = await fs.readFile(new URL('../db/analytics/009_purchase_details_v1.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE OR REPLACE VIEW analytics_purchases/);
  assert.match(sql, /CREATE OR REPLACE VIEW analytics_purchase_items/);
  assert.match(sql, /CONFIRMED_ACQUISITION_VALUE/);
  assert.doesNotMatch(sql, /\b(receipt_raw|payload|token|cookie)\b/i);
  assert.doesNotMatch(sql, /total_sum\s+AS|purchase_total/i);
});

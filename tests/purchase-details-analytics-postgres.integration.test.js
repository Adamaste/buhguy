import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('purchase details views are deterministic, reconciled and read-only in a clone', { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const sql = await fs.readFile(new URL('../db/analytics/009_purchase_details_v1.sql', import.meta.url), 'utf8');
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM receipts) AS receipts,
    (SELECT count(*) FROM receipt_items) AS items,
    (SELECT count(*) FROM receipt_raw) AS raw,
    (SELECT count(*) FROM business_events) AS events,
    (SELECT count(*) FROM ledger_entries) AS ledger_entries,
    (SELECT count(*) FROM certification_facts) AS facts`)).rows[0];
  try {
    const before = await counts();
    assert.match(sql, /CREATE OR REPLACE VIEW analytics_purchases/);
    assert.match(sql, /CREATE OR REPLACE VIEW analytics_purchase_items/);
    const views = (await pool.query(`SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname IN ('analytics_purchases','analytics_purchase_items')`)).rows;
    assert.equal(views.length, 2);
    const columns = (await pool.query(`SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('analytics_purchases','analytics_purchase_items')
      ORDER BY table_name, ordinal_position`)).rows;
    assert.ok(columns.some((row) => row.table_name === 'analytics_purchases' && row.column_name === 'amount'));
    assert.ok(columns.some((row) => row.table_name === 'analytics_purchase_items' && row.column_name === 'item_sum'));
    assert.ok(!columns.some((row) => /raw|payload|token|cookie|fiscal_sign|fns_id/i.test(row.column_name)));

    const purchases = (await pool.query(`SELECT * FROM analytics_purchases
      WHERE purchased_at >= '2026-08-01T00:00:00+03' AND purchased_at < '2026-09-01T00:00:00+03'
      ORDER BY purchase_id`)).rows;
    const items = (await pool.query(`SELECT * FROM analytics_purchase_items
      WHERE purchased_at >= '2026-08-01T00:00:00+03' AND purchased_at < '2026-09-01T00:00:00+03'
      ORDER BY purchase_id, item_position`)).rows;
    assert.equal(new Set(purchases.map((row) => row.purchase_id)).size, purchases.length);
    assert.equal(Number((await pool.query('SELECT count(*) FROM analytics_purchases WHERE status <> \'CERTIFIED\'')).rows[0].count), 0);
    assert.equal(Number((await pool.query(`SELECT count(*) FROM analytics_purchase_items
      WHERE item_name IS NULL OR item_name = ''`)).rows[0].count), 0);

    const reconciliation = (await pool.query(`SELECT p.purchase_id,
      p.amount, COALESCE(SUM(i.item_sum), 0)::numeric AS item_sum,
      CASE WHEN count(i.item_position)=0 THEN 'NO_ITEMS'
           WHEN COALESCE(SUM(i.item_sum), 0) = p.amount THEN 'MATCH'
           ELSE 'MISMATCH' END AS result
      FROM analytics_purchases p
      LEFT JOIN analytics_purchase_items i ON i.purchase_id=p.purchase_id
      WHERE p.purchased_at >= '2026-08-01T00:00:00+03' AND p.purchased_at < '2026-09-01T00:00:00+03'
      GROUP BY p.purchase_id,p.amount`)).rows;
    assert.equal(reconciliation.length, purchases.length);
    assert.equal(reconciliation.filter((row) => row.result === 'MISMATCH').length, 0);

    const xiaomi = (await pool.query(`SELECT count(*)::int AS count, COALESCE(sum(amount),0)::numeric AS amount
      FROM analytics_purchases WHERE amount=32380.00`)).rows[0];
    assert.equal(xiaomi.count, 1);
    assert.equal(Number(xiaomi.amount), 32380);
    assert.deepEqual(await counts(), before);
  } finally {
    await pool.end();
  }
});

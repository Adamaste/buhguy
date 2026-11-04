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
    assert.ok(columns.some((row) => row.table_name === 'analytics_purchases' && row.column_name === 'bank_merchant'));
    assert.ok(columns.some((row) => row.table_name === 'analytics_purchases' && row.column_name === 'merchant_display_source'));
    assert.ok(columns.some((row) => row.table_name === 'analytics_purchase_items' && row.column_name === 'item_sum'));
    assert.ok(!columns.some((row) => /raw|payload|token|cookie|fiscal_sign|fns_id/i.test(row.column_name)));

    const purchases = (await pool.query(`SELECT * FROM analytics_purchases
      WHERE purchased_at >= '2026-08-01T00:00:00+03' AND purchased_at < '2026-09-01T00:00:00+03'
      ORDER BY purchase_id`)).rows;
    const items = (await pool.query(`SELECT * FROM analytics_purchase_items
      WHERE purchased_at >= '2026-08-01T00:00:00+03' AND purchased_at < '2026-09-01T00:00:00+03'
      ORDER BY purchase_id, item_position`)).rows;
    assert.equal(new Set(purchases.map((row) => row.certification_fact_id)).size, purchases.length);
    assert.equal(Number((await pool.query('SELECT count(*) FROM analytics_purchases WHERE status <> \'CERTIFIED\'')).rows[0].count), 0);
    assert.equal(Number((await pool.query(`SELECT count(*) FROM analytics_purchase_items
      WHERE item_name IS NULL OR item_name = ''`)).rows[0].count), 0);

    const reconciliation = (await pool.query(`SELECT p.purchase_id,p.certification_fact_id,
      p.amount, COALESCE(SUM(i.item_sum), 0)::numeric AS item_sum,
      CASE WHEN count(i.item_position)=0 THEN 'NO_ITEMS'
           WHEN COALESCE(SUM(i.item_sum), 0) = p.amount THEN 'MATCH'
           ELSE 'MISMATCH' END AS result
      FROM analytics_purchases p
      LEFT JOIN analytics_purchase_items i
        ON i.purchase_id=p.purchase_id AND i.certification_fact_id=p.certification_fact_id
      WHERE p.purchased_at >= '2026-08-01T00:00:00+03' AND p.purchased_at < '2026-09-01T00:00:00+03'
      GROUP BY p.purchase_id,p.certification_fact_id,p.amount`)).rows;
    assert.equal(reconciliation.length, purchases.length);
    assert.equal(reconciliation.filter((row) => row.result === 'MISMATCH').length, 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const purchase = (await client.query(`SELECT purchase_id, certification_fact_id, scope_id, receipt_id,
          purchased_at, amount, currency
        FROM analytics_purchases WHERE amount=32380.00 AND status='CERTIFIED'
        ORDER BY purchase_id LIMIT 1`)).rows[0];
      assert.ok(purchase?.receipt_id);
      const account = (await client.query(`INSERT INTO financial_accounts
        (scope_id, institution, provider, display_name, currency)
        VALUES ($1,'Synthetic Bank','synthetic.merchant-test','Synthetic bank account',$2)
        RETURNING id`, [purchase.scope_id, purchase.currency])).rows[0];
      const source = (await client.query(`INSERT INTO bank_sources
        (source_key, source_type, display_name)
        VALUES ('synthetic-merchant-view-source','ANDROID_NOTIFICATION','Synthetic merchant view source')
        RETURNING id`)).rows[0];
      const observation = (await client.query(`INSERT INTO bank_event_observations
        (bank_source_id, source_event_id, dedup_key, observed_at, event_time,
         payload, payload_sha256, ingestion_metadata)
        VALUES ($1,'synthetic-merchant-view-event',repeat('c',64),NOW(),$2,
          '{"title":"Synthetic bank merchant"}'::jsonb,repeat('d',64),
          '{"adapter":"android-notification","provider":"ru.sberbankmobile","schemaVersion":"1"}'::jsonb)
        RETURNING id`, [source.id, purchase.purchased_at])).rows[0];
      const transaction = (await client.query(`INSERT INTO bank_transactions
        (observation_id, occurred_at, amount, currency, direction, merchant,
         normalization_status, normalization_version, evidence_quality, event_type)
        VALUES ($1,$2,$3,$4,'DEBIT','Synthetic bank merchant','READY',
          'sber-bank-normalizer-v7','EXACT','PURCHASE') RETURNING id`,
      [observation.id, purchase.purchased_at, purchase.amount, purchase.currency])).rows[0];
      const match = (await client.query(`INSERT INTO bank_receipt_matches
        (scope_id, bank_transaction_id, receipt_id, financial_account_id,
         matcher_version, match_key, bank_ledger_key, bank_candidate_key,
         bank_journal_key, receipt_candidate_key, receipt_normalization_version,
         receipt_normalized_content_sha256, amount, currency, bank_occurred_at,
         receipt_date_time, time_delta_seconds, relationship_type, reason_code)
        VALUES ($1,$2,$3,$4,'synthetic-matcher-test',repeat('1',64),repeat('2',64),
          repeat('3',64),repeat('4',64),repeat('5',64),'synthetic-fiscal-v1',
          repeat('6',64),$5,$6,$7,$7,0,'MATCHED_PURCHASE','SYNTHETIC_TEST')
        RETURNING id`, [purchase.scope_id, transaction.id, purchase.receipt_id,
        account.id, purchase.amount, purchase.currency, purchase.purchased_at])).rows[0];
      await client.query(`INSERT INTO business_event_bank_evidence
        (scope_id, business_event_id, bank_receipt_match_id, enrichment_key,
         evidence_role, rule_version, semantic_key)
        VALUES ($1,$2,$3,repeat('7',64),'BANK_PURCHASE_MATCH',
          'synthetic-matcher-test',repeat('8',64))`,
      [purchase.scope_id, purchase.purchase_id, match.id]);
      const projected = (await client.query(`SELECT seller, bank_merchant,
          bank_merchant_source, merchant_display, merchant_display_source
        FROM analytics_purchases WHERE purchase_id=$1 AND certification_fact_id=$2`,
      [purchase.purchase_id, purchase.certification_fact_id])).rows;
      assert.equal(projected.length, 1);
      assert.equal(projected[0].seller, 'Synthetic Merchant');
      assert.equal(projected[0].bank_merchant, 'Synthetic bank merchant');
      assert.equal(projected[0].bank_merchant_source, 'ANDROID_NOTIFICATION');
      assert.equal(projected[0].merchant_display, 'Synthetic bank merchant');
      assert.equal(projected[0].merchant_display_source, 'ANDROID_NOTIFICATION');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    const xiaomi = (await pool.query(`SELECT certification_fact_id,amount::numeric(18,2)::text AS amount
      FROM analytics_purchases WHERE amount=32380.00 AND status='CERTIFIED'
      ORDER BY certification_fact_id LIMIT 1`)).rows[0];
    assert.ok(xiaomi.certification_fact_id);
    assert.equal(xiaomi.amount, '32380.00');
    assert.deepEqual(await counts(), before);
  } finally {
    await pool.end();
  }
});

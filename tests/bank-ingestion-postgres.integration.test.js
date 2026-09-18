import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBankSource, ingestBankEvent } from '../src/bank-ingestion.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

integration('bank ingestion is immutable, source-scoped, and deterministic', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await createBankSource(pool, { sourceKey: 'android-bank-test-a', sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic bank A' });
    await createBankSource(pool, { sourceKey: 'android-bank-test-b', sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic bank B' });
    const event = {
      sourceKey: 'android-bank-test-a', sourceEventId: 'evt-1', observedAt: '2026-09-18T10:00:00Z', eventTime: '2026-09-18T09:59:00Z',
      payload: { amount: '125.50', currency: 'RUB', direction: 'DEBIT', merchant: 'Synthetic shop' },
      ingestionMetadata: { adapter: 'test', schemaVersion: '1' },
    };
    const created = await ingestBankEvent(pool, event);
    assert.equal(created.status, 'created');
    assert.equal((await ingestBankEvent(pool, event)).status, 'duplicate');
    assert.deepEqual(await ingestBankEvent(pool, { ...event, payload: { ...event.payload, amount: '126.00' } }), { status: 'rejected', code: 'SOURCE_EVENT_CONFLICT' });
    assert.equal((await ingestBankEvent(pool, { ...event, sourceKey: 'android-bank-test-b' })).status, 'created');
    const counts = await pool.query(`SELECT (SELECT count(*) FROM bank_event_observations) AS observations,
      (SELECT count(*) FROM bank_transactions) AS transactions,
      (SELECT count(*) FROM information_schema.columns WHERE table_name='bank_transactions' AND column_name IN ('receipt_id','purchase_id')) AS forbidden_links`);
    assert.equal(Number(counts.rows[0].observations), 2);
    assert.equal(Number(counts.rows[0].transactions), 2);
    assert.equal(Number(counts.rows[0].forbidden_links), 0);
    const row = await pool.query('SELECT amount, currency, direction, normalization_status FROM bank_transactions ORDER BY id LIMIT 1');
    assert.equal(row.rows[0].amount, '125.50');
    assert.equal(row.rows[0].currency, 'RUB');
    assert.equal(row.rows[0].direction, 'DEBIT');
    assert.equal(row.rows[0].normalization_status, 'READY');
  } finally {
    await pool.end();
  }
});

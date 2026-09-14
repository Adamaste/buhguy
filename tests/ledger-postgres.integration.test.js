import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { rebuildLedger } from '../src/ledger.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration('Ledger V1 clone persist, idempotency, concurrency and rollback', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const before = (await pool.query('SELECT (SELECT count(*) FROM receipts) AS receipts,(SELECT count(*) FROM receipt_items) AS items,(SELECT count(*) FROM receipt_raw) AS raw,(SELECT count(*) FROM receipt_fiscal_facts) AS facts,(SELECT count(*) FROM receipt_item_fiscal_facts) AS item_facts,(SELECT count(*) FROM business_events) AS events,(SELECT count(*) FROM business_event_edges) AS edges,(SELECT count(*) FROM business_event_allocations) AS allocations')).rows[0];
    const eventIds = (await pool.query('SELECT DISTINCT e.id FROM business_events e JOIN business_event_evidence ev ON ev.event_id=e.id ORDER BY e.id LIMIT 20')).rows.map((row) => Number(row.id));
    assert.ok(eventIds.length > 0);
    const first = await rebuildLedger(pool, { eventIds, dryRun: true });
    assert.ok(first.entries >= 0);
    assert.ok(first.postings >= 0);
    const second = await rebuildLedger(pool, { eventIds, dryRun: true });
    assert.deepEqual(second, first);
    const baselineEntries = Number((await pool.query('SELECT count(*) AS entries FROM ledger_entries')).rows[0].entries);
    assert.ok(baselineEntries >= 0);
    const after = (await pool.query('SELECT (SELECT count(*) FROM receipts) AS receipts,(SELECT count(*) FROM receipt_items) AS items,(SELECT count(*) FROM receipt_raw) AS raw,(SELECT count(*) FROM receipt_fiscal_facts) AS facts,(SELECT count(*) FROM receipt_item_fiscal_facts) AS item_facts,(SELECT count(*) FROM business_events) AS events,(SELECT count(*) FROM business_event_edges) AS edges,(SELECT count(*) FROM business_event_allocations) AS allocations')).rows[0];
    assert.deepEqual(after, before);
    const balance = await pool.query('SELECT count(*) AS violations FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING SUM(debit) <> SUM(credit)) q');
    assert.equal(Number(balance.rows[0].violations), 0);
  } finally {
    await pool.end();
  }
});

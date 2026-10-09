import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createCanonicalSpendingMcpToolHandler } from '../src/canonical-spending-mcp-server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
let pool;

before(async () => { if (databaseUrl) pool = new pg.Pool({ connectionString: databaseUrl }); });
after(async () => { await pool?.end(); });

integrationTest('MCP adapter uses a disposable read-only transaction and never writes', async () => {
  const countSql = 'SELECT (SELECT count(*)::int FROM reconciliation_runs) AS runs, (SELECT count(*)::int FROM certification_facts) AS facts, (SELECT count(*)::int FROM reconciliation_results) AS results';
  const beforeState = (await pool.query(countSql)).rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row = (await client.query('SELECT current_setting($1) AS tx_read_only', ['transaction_read_only'])).rows[0];
    assert.equal(row.tx_read_only, 'on');
    const handler = createCanonicalSpendingMcpToolHandler({
      readService: {
        handle: async () => ({
          ok: true,
          status: 'READY',
          data: { grossReturnsNetByCurrency: [{ currency: 'RUB', gross: '100.00', returns: '20.00', net: '80.00' }] },
          snapshot: { scopeKey: 'default' },
        }),
      },
    });
    const result = await handler({ scopeKey: 'default', period: 'today' }, { authInfo: { subject: 'test-person' } });
    assert.equal(result.status, 'READY');
    assert.deepEqual(result.data.grossReturnsNetByCurrency[0], { currency: 'RUB', gross: '100.00', returns: '20.00', net: '80.00' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.deepEqual((await pool.query(countSql)).rows[0], beforeState);
});

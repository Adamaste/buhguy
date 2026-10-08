import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { migrate, runBoundedTransaction } from '../src/database.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const migration = '019_canonical_spending_analytics_foundation.sql';

integration('analytics 011 uses its own bounded transaction without grant exposure', async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const sql = await fs.readFile('db/analytics/011_canonical_spending_analytics_v1.sql', 'utf8');
    assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE)\b/i);
    await runBoundedTransaction(pool, (client) => client.query(sql), { lockTimeoutMs: 5000, statementTimeoutMs: 30000 });
    const views = await pool.query(`
      SELECT count(*)::int AS count
      FROM pg_class
      WHERE relkind='v'
        AND relname LIKE 'canonical_spending_%_v1'`);
    assert.equal(views.rows[0].count, 8);
    const acl = await pool.query(`
      SELECT count(*)::int AS count
      FROM pg_class
      WHERE relkind='v'
        AND relname LIKE 'canonical_spending_%_v1'
        AND relacl IS NOT NULL`);
    assert.equal(acl.rows[0].count, 0);
  } finally {
    await pool.end();
  }
});

integration('strict production migration guard rejects an unexpected pending set before mutation', async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buhguy-migration-guard-'));
  try {
    await fs.writeFile(path.join(directory, migration), 'SELECT 1;');
    await fs.writeFile(path.join(directory, '020_unapproved.sql'), 'CREATE TABLE should_not_exist(id integer);');
    const before = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
    await assert.rejects(
      migrate(pool, directory, { requireSinglePendingMigration: migration, lockTimeoutMs: 5000, statementTimeoutMs: 5000 }),
      (error) => error.code === 'MIGRATION_PENDING_SET_MISMATCH',
    );
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, before.rows[0].count);
    assert.equal((await pool.query("SELECT to_regclass('public.should_not_exist') AS name")).rows[0].name, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await pool.end();
  }
});

integration('bounded migration connection rolls back DDL after conflicting lock timeout', async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const blocker = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buhguy-migration-lock-'));
  const probe = `migration_lock_probe_${process.pid}_${Date.now()}`;
  try {
    await pool.query(`CREATE TABLE ${probe}(id integer)`);
    await pool.query(`DELETE FROM schema_migrations WHERE filename=$1`, [migration]);
    await fs.writeFile(path.join(directory, migration), `ALTER TABLE ${probe} ADD COLUMN applied_marker integer`);
    const lockClient = await blocker.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query(`LOCK TABLE ${probe} IN ACCESS EXCLUSIVE MODE`);
      await assert.rejects(
        migrate(pool, directory, { requireSinglePendingMigration: migration, lockTimeoutMs: 100, statementTimeoutMs: 5000 }),
        (error) => error.code === '55P03',
      );
    } finally {
      await lockClient.query('ROLLBACK');
      lockClient.release();
    }
    assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='applied_marker'`, [probe])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [migration])).rowCount, 0);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${probe}`);
    await fs.rm(directory, { recursive: true, force: true });
    await blocker.end();
    await pool.end();
  }
});


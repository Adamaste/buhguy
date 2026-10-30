import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BANK_RECONCILIATION_MIGRATION_026,
  BANK_RECONCILIATION_MIGRATION_026_SHA256,
  migrateBankReconciliation026,
} from '../scripts/migrate-prod-bank-reconciliation-026.mjs';

const migrationRoot = new URL('../db/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationRoot)).filter(file => file.endsWith('.sql')).sort();
const expectedBefore026 = migrationFiles.filter(file => file !== BANK_RECONCILIATION_MIGRATION_026);

async function makeMigrationsDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buhguy-bank-reconciliation-026-'));
  for (const filename of migrationFiles) await writeFile(path.join(directory, filename), await readFile(new URL(filename, migrationRoot)));
  return directory;
}

function fakePool(appliedFilenames) {
  const executed = [];
  let connectCount = 0;
  const client = {
    async query(sql, parameters = []) {
      const statement = String(sql).trim();
      if (statement.startsWith('SELECT set_config')) return { rows: [{}] };
      if (statement.includes("to_regclass('public.schema_migrations')")) return { rows: [{ name: 'schema_migrations' }] };
      if (statement === 'SELECT filename FROM schema_migrations') return { rows: appliedFilenames.map(filename => ({ filename })) };
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [] };
      if (statement.startsWith('INSERT INTO schema_migrations')) { executed.push({ filename: parameters[0] }); return { rows: [] }; }
      executed.push({ sql: statement });
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { async connect() { connectCount += 1; return client; } }, executed, get connectCount() { return connectCount; } };
}

test('026 runner pins migration bytes and applies only 026 after 001-025', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const bytes = await readFile(path.join(directory, BANK_RECONCILIATION_MIGRATION_026));
    const canonicalBytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    assert.equal(createHash('sha256').update(canonicalBytes).digest('hex'), BANK_RECONCILIATION_MIGRATION_026_SHA256);
    const database = fakePool(expectedBefore026);
    const result = await migrateBankReconciliation026(database.pool, directory);
    assert.deepEqual(result.applied, [BANK_RECONCILIATION_MIGRATION_026]);
    assert.deepEqual(database.executed.map(row => row.filename).filter(Boolean), [BANK_RECONCILIATION_MIGRATION_026]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('026 runner refuses any additional pending migration', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    await writeFile(path.join(directory, '027_unapproved.sql'), 'SELECT 27027;');
    const database = fakePool(expectedBefore026);
    await assert.rejects(() => migrateBankReconciliation026(database.pool, directory), error =>
      error.code === 'MIGRATION_PENDING_SET_MISMATCH' && error.pending.includes('027_unapproved.sql'));
    assert.deepEqual(database.executed, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('026 runner fails closed on changed migration bytes before connecting', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const migrationPath = path.join(directory, BANK_RECONCILIATION_MIGRATION_026);
    await writeFile(migrationPath, `${await readFile(migrationPath, 'utf8')}\n-- changed\n`);
    const database = fakePool(expectedBefore026);
    await assert.rejects(() => migrateBankReconciliation026(database.pool, directory), error => error.code === 'MIGRATION_CHECKSUM_MISMATCH');
    assert.equal(database.connectCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('026 runner is idempotent when its exact migration is already applied', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const database = fakePool(migrationFiles);
    const result = await migrateBankReconciliation026(database.pool, directory);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(database.executed, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BANK_ONLY_MIGRATION_027,
  BANK_ONLY_MIGRATION_027_SHA256,
  migrateBankOnly027,
} from '../scripts/migrate-prod-bank-only-027.mjs';

const migrationRoot = new URL('../db/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationRoot)).filter(file => file.endsWith('.sql')).sort();
const expectedAppliedBefore027 = migrationFiles.filter(file => file !== BANK_ONLY_MIGRATION_027);

async function makeMigrationsDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buhguy-bank-only-027-'));
  for (const filename of migrationFiles) {
    await writeFile(path.join(directory, filename), await readFile(new URL(filename, migrationRoot)));
  }
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
      if (statement.startsWith('INSERT INTO schema_migrations')) {
        executed.push({ filename: parameters[0] });
        return { rows: [] };
      }
      executed.push({ sql: statement });
      return { rows: [] };
    },
    release() {},
  };
  return {
    pool: { async connect() { connectCount += 1; return client; } },
    executed,
    get connectCount() { return connectCount; },
  };
}

test('027 runner pins migration bytes and applies after all earlier migrations are applied', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const bytes = await readFile(path.join(directory, BANK_ONLY_MIGRATION_027));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), BANK_ONLY_MIGRATION_027_SHA256);
    const database = fakePool(expectedAppliedBefore027);
    const result = await migrateBankOnly027(database.pool, directory);
    assert.deepEqual(result.applied, [BANK_ONLY_MIGRATION_027]);
    assert.deepEqual(database.executed, [
      { sql: bytes.toString('utf8').trim() },
      { filename: BANK_ONLY_MIGRATION_027 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('027 runner refuses missing earlier migrations without executing SQL', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const applied = migrationFiles.filter(file => file !== '025_bank_only_purchase_ledger.sql' && file !== BANK_ONLY_MIGRATION_027);
    const database = fakePool(applied);
    await assert.rejects(() => migrateBankOnly027(database.pool, directory), error =>
      error.code === 'MIGRATION_PENDING_SET_MISMATCH'
      && error.expected === BANK_ONLY_MIGRATION_027
      && error.pending.includes('025_bank_only_purchase_ledger.sql')
      && error.pending.includes(BANK_ONLY_MIGRATION_027));
    assert.deepEqual(database.executed, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('027 runner refuses when PR 194 migration 026 is still pending', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const reconciliationMigration = '026_manual_bank_reconciliation_review_evidence.sql';
    await writeFile(path.join(directory, reconciliationMigration), 'SELECT 26026;');
    const database = fakePool(expectedAppliedBefore027);
    await assert.rejects(() => migrateBankOnly027(database.pool, directory), error =>
      error.code === 'MIGRATION_PENDING_SET_MISMATCH'
      && error.pending.includes(BANK_ONLY_MIGRATION_027)
      && error.pending.includes(reconciliationMigration));
    assert.deepEqual(database.executed, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('027 runner proceeds after PR 194 migration 026 is recorded as applied', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const reconciliationMigration = '026_manual_bank_reconciliation_review_evidence.sql';
    await writeFile(path.join(directory, reconciliationMigration), 'SELECT 26026;');
    const database = fakePool([...expectedAppliedBefore027, reconciliationMigration]);
    const result = await migrateBankOnly027(database.pool, directory);
    assert.deepEqual(result.applied, [BANK_ONLY_MIGRATION_027]);
    assert.deepEqual(database.executed.at(-1), { filename: BANK_ONLY_MIGRATION_027 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('027 runner fails closed on changed bytes before opening a connection', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const filename = path.join(directory, BANK_ONLY_MIGRATION_027);
    await writeFile(filename, `${await readFile(filename, 'utf8')}\n-- changed\n`);
    const database = fakePool(expectedAppliedBefore027);
    await assert.rejects(() => migrateBankOnly027(database.pool, directory), error => error.code === 'MIGRATION_CHECKSUM_MISMATCH');
    assert.equal(database.connectCount, 0);
    assert.deepEqual(database.executed, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('027 runner is idempotent when its exact migration is already applied', async () => {
  const directory = await makeMigrationsDirectory();
  try {
    const database = fakePool(migrationFiles);
    const result = await migrateBankOnly027(database.pool, directory);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(database.executed, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

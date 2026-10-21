import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateTroika024, TROIKA_MIGRATION_024 } from '../scripts/migrate-prod-troika-024.mjs';

function fakePool(pending) {
  const applied = [];
  const migrationsRun = [];
  const client = {
    async query(sql, parameters = []) {
      const statement = String(sql).trim();
      if (statement.startsWith('SELECT set_config')) return { rows: [{}] };
      if (statement.includes("to_regclass('public.schema_migrations')")) return { rows: [{ name: 'schema_migrations' }] };
      if (statement === 'SELECT filename FROM schema_migrations') return { rows: pending.map((filename) => ({ filename })) };
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [] };
      if (statement.startsWith('INSERT INTO schema_migrations')) {
        applied.push(parameters[0]);
        return { rows: [] };
      }
      migrationsRun.push(statement);
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, applied, migrationsRun };
}

test('production Troika runner applies only migration 024 and rejects any other pending migration before SQL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buhguy-troika-024-'));
  try {
    const migrationSql = 'SELECT 24024;';
    await writeFile(path.join(directory, TROIKA_MIGRATION_024), migrationSql);
    const accepted = fakePool([]);
    const result = await migrateTroika024(accepted.pool, directory);
    assert.deepEqual(result.applied, [TROIKA_MIGRATION_024]);
    assert.deepEqual(accepted.applied, [TROIKA_MIGRATION_024]);
    assert.deepEqual(accepted.migrationsRun, [migrationSql]);

    await writeFile(path.join(directory, '025_unapproved.sql'), 'SELECT 25025;');
    const rejected = fakePool([]);
    await assert.rejects(() => migrateTroika024(rejected.pool, directory), (error) =>
      error.code === 'MIGRATION_PENDING_SET_MISMATCH'
      && error.expected === TROIKA_MIGRATION_024
      && error.pending.includes('025_unapproved.sql'));
    assert.deepEqual(rejected.applied, []);
    assert.deepEqual(rejected.migrationsRun, [], 'no pending SQL runs when the migration set is not exactly 024');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the legacy production runner remains pinned to migration 019', async () => {
  const source = await readFile(new URL('../scripts/migrate-prod-only.mjs', import.meta.url), 'utf8');
  assert.match(source, /requireSinglePendingMigration:\s*'019_canonical_spending_analytics_foundation\.sql'/);
  assert.doesNotMatch(source, /requireSinglePendingMigration:\s*process\.env/);
});

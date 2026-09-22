import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSchemaCurrent } from '../src/database.js';

async function withMigrations(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'receipt-schema-'));
  try {
    await writeFile(path.join(directory, '001_first.sql'), 'SELECT 1;');
    await writeFile(path.join(directory, '002_second.sql'), 'SELECT 1;');
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('assertSchemaCurrent reads schema_migrations without requesting DDL', async () => {
  await withMigrations(async (directory) => {
    const queries = [];
    const result = await assertSchemaCurrent({
      query: async (sql) => {
        queries.push(sql);
        return { rows: [{ filename: '001_first.sql' }, { filename: '002_second.sql' }] };
      },
    }, directory);
    assert.deepEqual(result, { ok: true, migrations: 2 });
    assert.deepEqual(queries, ['SELECT filename FROM schema_migrations']);
  });
});

test('assertSchemaCurrent returns stable SCHEMA_MIGRATION_REQUIRED for an incomplete schema', async () => {
  await withMigrations(async (directory) => {
    await assert.rejects(
      () => assertSchemaCurrent({ query: async () => ({ rows: [{ filename: '001_first.sql' }] }) }, directory),
      (error) => {
        assert.equal(error.code, 'SCHEMA_MIGRATION_REQUIRED');
        assert.equal(error.message, 'Database schema is not current; run administrative migration before starting runtime.');
        return true;
      },
    );
  });
});

test('assertSchemaCurrent maps a missing migration ledger to the stable error', async () => {
  await withMigrations(async (directory) => {
    await assert.rejects(
      () => assertSchemaCurrent({ query: async () => { throw Object.assign(new Error('missing relation'), { code: '42P01' }); } }, directory),
      (error) => error.code === 'SCHEMA_MIGRATION_REQUIRED',
    );
  });
});

test('assertSchemaCurrent propagates unexpected database failures', async () => {
  await withMigrations(async (directory) => {
    const failure = new Error('connection reset');
    await assert.rejects(
      () => assertSchemaCurrent({ query: async () => { throw failure; } }, directory),
      (error) => error === failure,
    );
  });
});

test('runtime entry points do not invoke migrations', async () => {
  const cliSource = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const schedulerSource = await readFile(new URL('../bin/scheduler.js', import.meta.url), 'utf8');
  const fnsUserBranch = cliSource.slice(cliSource.indexOf("if (command === 'fns-user')"), cliSource.indexOf("if (command === 'bank-device')"));
  const bankDeviceBranch = cliSource.slice(cliSource.indexOf("if (command === 'bank-device')"), cliSource.indexOf("if (command === 'bank-source')"));
  const bankSourceBranch = cliSource.slice(cliSource.indexOf("if (command === 'bank-source')"), cliSource.indexOf("if (command === 'show')"));
  const syncBranch = cliSource.slice(cliSource.indexOf("if (command === 'sync')"), cliSource.indexOf("if (command === 'normalize')"));
  const normalizeBranch = cliSource.slice(cliSource.indexOf("if (command === 'normalize')"), cliSource.indexOf("if (command === 'accounting')"));
  const accountingBranch = cliSource.slice(cliSource.indexOf("if (command === 'accounting')"), cliSource.indexOf("if (command === 'graph')"));
  for (const source of [fnsUserBranch, bankDeviceBranch, bankSourceBranch, syncBranch, normalizeBranch, accountingBranch, schedulerSource]) {
    assert.doesNotMatch(source, /\bmigrate\s*\(/);
  }
  assert.match(cliSource, /if \(command === 'migrate'\)/);
});

test('bounded refresh callers do not invoke certification a second time', async () => {
  const [cliSource, syncSource, standaloneSource] = await Promise.all([
    readFile(new URL('../src/cli.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/sync.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/standalone-purchase.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(syncSource, /certificationRefresher\s*\(/);
  assert.doesNotMatch(standaloneSource, /certificationRefresher\s*\(/);
  const syncStart = cliSource.indexOf("if (command === 'sync')");
  const syncEnd = cliSource.indexOf("if (command === 'normalize')", syncStart);
  assert.doesNotMatch(cliSource.slice(syncStart, syncEnd), /certificationRefresher:/);
});

test('sync performs one scope-wide accounting catch-up after all sources', async () => {
  const cliSource = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const syncStart = cliSource.indexOf("if (command === 'sync')");
  const syncEnd = cliSource.indexOf("if (command === 'normalize')", syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart, 'sync branch must be present');
  const syncBranch = cliSource.slice(syncStart, syncEnd);
  const runSourceStart = syncBranch.indexOf('runSource: async');
  const runSourceEndMatch = syncBranch.slice(runSourceStart).match(/},\r?\n      \}\);/s);
  const runSourceEnd = runSourceEndMatch ? runSourceStart + runSourceEndMatch.index : -1;
  assert.ok(runSourceStart >= 0 && runSourceEnd > runSourceStart, 'source runner must be present');
  const runSource = syncBranch.slice(runSourceStart, runSourceEnd);

  assert.doesNotMatch(runSource, /runAccountingCatchup\s*\(/);
  assert.equal((syncBranch.match(/runAccountingCatchup\s*\(/g) ?? []).length, 1);
  assert.match(syncBranch, /runSourceSyncCycle\([\s\S]*?\);\s*for \(const scopeKey of deriveAccountingCatchupScopeKeys\(/);
});

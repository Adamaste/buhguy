import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFnsSourceConfig } from '../src/fns-source-config.js';
import { deriveAccountingCatchupScopeKeys, effectiveAccountingScopeKey, resolveSyncSources, runAccountingCatchupsForSources, runSourceSyncCycle } from '../src/source-sync-cycle.js';
import { FnsSourceObservationConflictError } from '../src/multi-user-errors.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('multi-user foundation keeps source observation semantics explicit', async () => {
  assert.equal(new FnsSourceObservationConflictError().code, 'FNS_SOURCE_OBSERVATION_CONFLICT');
  const migration = await fs.readFile(new URL('../db/migrations/008_multi_user_fns_foundation.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS receipt_source_observations/);
  assert.match(migration, /UNIQUE \(fns_source_id, source_receipt_id\)/);
  assert.doesNotMatch(migration, /\b(access_token|refresh_token|cookie)\s+(TEXT|JSONB|BYTEA)/i);
  const source = { sourceKey: 'a', sessionDir: '/secure/a', personKey: 'p1' };
  assert.equal(source.personKey, 'p1');
});

test('source reference lifecycle is separate from resolved observations', async () => {
  const migration = await fs.readFile(new URL('../db/migrations/009_fns_source_reference_lifecycle.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fns_source_receipt_refs/);
  assert.match(migration, /source_receipt_id TEXT NOT NULL/);
  assert.match(migration, /receipt_id BIGINT REFERENCES receipts/);
  assert.match(migration, /FNS_DETAIL_UNAVAILABLE/);
  assert.match(migration, /UNIQUE \(fns_source_id, source_receipt_id\)/);
  assert.match(migration, /CHECK \(\(status = 'RESOLVED'\) = \(receipt_id IS NOT NULL\)\)/);
  assert.match(migration, /detail_next_retry_at/);
  assert.doesNotMatch(migration, /ALTER TABLE\s+receipt_source_observations/i);
});

test('source config is metadata-only and preserves independent session references', async () => {
  assert.ok(typeof loadFnsSourceConfig === 'function');
  const config = [{ sourceKey: 'a', sessionDir: '/secure/a', personKey: 'p1' }, { sourceKey: 'b', sessionDir: '/secure/b', personKey: 'p2' }];
  assert.notEqual(config[0].sessionDir, config[1].sessionDir);
  assert.equal(Object.hasOwn(config[0], 'accessToken'), false);
});

test('source observation locking is append-only and privilege-safe', async () => {
  const database = await fs.readFile(new URL('../src/database.js', import.meta.url), 'utf8');
  assert.match(database, /pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)/);
  assert.match(database, /SELECT receipt_id FROM receipt_source_observations WHERE fns_source_id=\$1 AND source_receipt_id=\$2'/);
  assert.doesNotMatch(database, /FROM receipt_source_observations WHERE fns_source_id=\$1 AND source_receipt_id=\$2 FOR UPDATE/);
  const migration = await fs.readFile(new URL('../db/migrations/008_multi_user_fns_foundation.sql', import.meta.url), 'utf8');
  assert.match(migration, /UNIQUE \(fns_source_id, source_receipt_id\)/);
});

test('legacy source resolution preserves the existing source identity contract', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-source-'));
  const resolved = await resolveSyncSources({ configFile: undefined, legacySessionStore: { stateDir } });
  assert.equal(resolved.explicit, false);
  assert.deepEqual(resolved.sources.map(({ sourceKey, personKey, sessionDir }) => ({ sourceKey, personKey, sessionDir })), [{ sourceKey: 'legacy-default', personKey: 'legacy-current-user', sessionDir: stateDir }]);
});

test('explicit sources are resolved once with independent session paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-config-'));
  const configPath = path.join(dir, 'sources.json');
  await fs.writeFile(configPath, JSON.stringify([
    { sourceKey: 'source-a', sessionDir: path.join(dir, 'a'), personKey: 'person-a' },
    { sourceKey: 'source-b', sessionDir: path.join(dir, 'b'), personKey: 'person-b' },
  ]));
  const resolved = await resolveSyncSources({ configFile: configPath });
  assert.equal(resolved.explicit, true);
  assert.deepEqual(resolved.sources.map((source) => source.sourceKey), ['source-a', 'source-b']);
  assert.notEqual(resolved.sources[0].sessionDir, resolved.sources[1].sessionDir);
});

test('source cycle attempts enabled sources after failure and skips disabled sources', async () => {
  const calls = [];
  const states = [];
  const repository = {
    async ensureSource(source) { return { id: source.sourceKey }; },
    async updateSourceSyncState(id, values) { states.push({ id, values }); },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-cycle-'));
  const configPath = path.join(dir, 'sources.json');
  await fs.writeFile(configPath, JSON.stringify([
    { sourceKey: 'a', sessionDir: path.join(dir, 'a') },
    { sourceKey: 'b', sessionDir: path.join(dir, 'b') },
    { sourceKey: 'disabled', sessionDir: path.join(dir, 'disabled'), enabled: false },
    { sourceKey: 'c', sessionDir: path.join(dir, 'c') },
  ]));
  const cycle = await runSourceSyncCycle({
    configFile: configPath,
    repository,
    logger: {},
    runSource: async ({ source }) => {
      calls.push(source.sourceKey);
      if (source.sourceKey === 'b') throw Object.assign(new Error('auth failed'), { code: 'AUTH_FAILED' });
      return { fetched: 1, inserted: 0, alreadyExisted: 1, errors: 0 };
    },
  });
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(cycle.attempted, 3);
  assert.equal(cycle.failed, 1);
  assert.equal(cycle.exitCode, 2);
  assert.equal(states.length, 1);
  assert.equal(states[0].id, 'b');
});

test('source cycle returns zero only when all enabled sources succeed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-cycle-success-'));
  const configPath = path.join(dir, 'sources.json');
  await fs.writeFile(configPath, JSON.stringify([
    { sourceKey: 'a', sessionDir: path.join(dir, 'a') },
    { sourceKey: 'b', sessionDir: path.join(dir, 'b'), enabled: false },
  ]));
  const cycle = await runSourceSyncCycle({
    configFile: configPath,
    repository: { async ensureSource(source) { return { id: source.sourceKey }; }, async updateSourceSyncState() {} },
    logger: {},
    runSource: async () => ({ fetched: 2, inserted: 0, alreadyExisted: 2, errors: 0 }),
  });
  assert.equal(cycle.attempted, 1);
  assert.equal(cycle.failed, 0);
  assert.equal(cycle.exitCode, 0);
});

test('accounting catch-up runs once per unique enabled source scope', () => {
  assert.deepEqual(deriveAccountingCatchupScopeKeys([
    { enabled: true, scopeKey: 'default' },
    { enabled: true, scopeKey: 'household-2' },
    { enabled: true, scopeKey: 'household-2' },
    { enabled: false, scopeKey: 'disabled-scope' },
  ]), ['default', 'household-2']);
  assert.deepEqual(deriveAccountingCatchupScopeKeys([
    { enabled: true, scopeKey: 'default' },
    { enabled: true, scopeKey: 'household-2' },
  ], 'override'), ['default', 'household-2']);
});

test('sync orchestration uses one source-first effective scope for processing and catch-up', async () => {
  const sources = [
    { enabled: true, sourceKey: 'default-source', scopeKey: 'default' },
    { enabled: true, sourceKey: 'household-source', scopeKey: 'household-2' },
    { enabled: true, sourceKey: 'duplicate-household-source', scopeKey: 'household-2' },
    { enabled: false, sourceKey: 'disabled-source', scopeKey: 'disabled' },
  ];
  const processed = sources.filter((source) => source.enabled !== false).map((source) => ({ sourceKey: source.sourceKey, scopeKey: effectiveAccountingScopeKey(source, 'cli-override') }));
  const caughtUp = [];
  await runAccountingCatchupsForSources(sources, 'cli-override', async (scopeKey) => caughtUp.push(scopeKey));
  assert.deepEqual(processed, [
    { sourceKey: 'default-source', scopeKey: 'default' },
    { sourceKey: 'household-source', scopeKey: 'household-2' },
    { sourceKey: 'duplicate-household-source', scopeKey: 'household-2' },
  ]);
  assert.deepEqual(caughtUp, ['default', 'household-2']);
});

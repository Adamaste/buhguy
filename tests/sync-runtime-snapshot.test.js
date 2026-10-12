import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { platform } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRollbackPlan, createSnapshot, SnapshotError, verifySnapshot } from '../scripts/sync-runtime-snapshot.mjs';

const posixSkip = platform() === 'win32' ? 'POSIX filesystem gates run in isolated Linux tests' : false;

async function fixture(t, { entrySource, includeDependency = true, secretImport = false, optionalPeer = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sync-snapshot-test-'));
  await chmod(base, 0o755);
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'mutable-runtime');
  const releases = path.join(base, 'releases');
  const work = path.join(base, 'working-directory');
  await Promise.all([mkdir(source, { mode: 0o777 }), mkdir(releases, { mode: 0o755 }), mkdir(work, { mode: 0o700 })]);
  if (platform() !== 'win32') await chmod(source, 0o777);
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await mkdir(path.join(source, 'src'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'synthetic-sync', type: 'module', dependencies: includeDependency ? { 'synthetic-pkg': '1.0.0' } : {} }));
  await writeFile(path.join(source, 'package-lock.json'), JSON.stringify({ name: 'synthetic-sync', lockfileVersion: 3, packages: {} }));
  const body = entrySource ?? `import { readFileSync } from 'node:fs';\nimport path from 'node:path';\nimport { getValue } from '../src/value.js';\nimport { getSessionMarker } from '../src/marker-module.js';\nimport { value } from 'synthetic-pkg';\nconst state = readFileSync(path.join(process.cwd(), 'state.txt'), 'utf8');\nconsole.log(JSON.stringify({ state, sessionMarker: getSessionMarker(), result: getValue() + value, args: process.argv.slice(2) }));\n`;
  await writeFile(path.join(source, 'bin', 'entry.js'), body);
  await chmod(path.join(source, 'bin', 'entry.js'), 0o755);
  await writeFile(path.join(source, 'src', 'value.js'), `import { suffix } from './nested.js';\nexport const getValue = () => 40 + suffix;\n`);
  await writeFile(path.join(source, 'src', 'nested.js'), 'export const suffix = 2;\n');
  await writeFile(path.join(source, 'src', 'marker-module.js'), 'export const getSessionMarker = () => "code-only-module";\n');
  if (includeDependency) {
    const pkg = path.join(source, 'node_modules', 'synthetic-pkg');
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'synthetic-pkg',
      version: '1.0.0',
      exports: { '.': { import: './index.js', default: './index.js' } },
      ...(optionalPeer ? { peerDependenciesMeta: { 'synthetic-optional-peer': { optional: true } } } : {}),
    }));
    await writeFile(path.join(pkg, 'index.js'), `${optionalPeer ? "import './optional-probe.cjs';\n" : ''}export const value = 0;\n`);
    if (optionalPeer) await writeFile(path.join(pkg, 'optional-probe.cjs'), "try { require('synthetic-optional-peer'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }\n");
  }
  await writeFile(path.join(work, 'state.txt'), 'current-session-state\n');
  if (secretImport) await writeFile(path.join(source, '.env.js'), 'throw new Error("must not be read");\n');
  return { base, source, releases, work, entrypoint: path.join(source, 'bin', 'entry.js') };
}

async function snapshot(t, options = {}) {
  const f = await fixture(t, options);
  const result = await createSnapshot({
    sourceRoot: f.source,
    entrypoint: 'bin/entry.js',
    destinationParent: f.releases,
    minimumFreeBytes: 1024,
    minimumFreeInodes: 64,
    quiesced: true,
  });
  return { ...f, result };
}

test('creates a verified code-only snapshot with POSIX modes and explicit non-Git identity', { skip: posixSkip }, async t => {
  const { source, result } = await snapshot(t);
  const checked = await verifySnapshot({ snapshotRoot: result.path });
  assert.equal(checked.status, 'PASS');
  assert.equal(checked.gitCommit, null);
  assert.equal(result.gitCommit, null);
  if (platform() !== 'win32') {
    assert.equal(result.sourceRootMode, '0777');
    assert.equal((await (await import('node:fs/promises')).stat(path.join(result.path, 'bin', 'entry.js'))).mode & 0o777, 0o755);
    assert.equal((await (await import('node:fs/promises')).stat(path.join(result.path, 'src', 'value.js'))).mode & 0o777, 0o644);
    assert.equal((await (await import('node:fs/promises')).stat(result.path)).mode & 0o777, 0o755);
  }
  assert.equal(await readFile(path.join(source, 'package.json'), 'utf8'), await readFile(path.join(result.path, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(result.path, 'sync-snapshot-manifest.json'), 'utf8'));
  assert.match(manifest.identity, /not a Git commit/);
  assert.equal(manifest.gitCommit, null);
  assert.equal(manifest.files.some(file => file.path.includes('state.txt')), false);
  if (platform() !== 'win32') {
    const verifier = fileURLToPath(new URL('../scripts/sync-runtime-snapshot.mjs', import.meta.url));
    const serviceUserCheck = spawnSync('runuser', ['-u', 'nobody', '--', process.execPath, verifier, 'verify', '--snapshot-root', result.path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(serviceUserCheck.status, 0, serviceUserCheck.stderr);
    assert.equal(JSON.parse(serviceUserCheck.stdout).status, 'PASS');
    const streamedTool = await readFile(verifier, 'utf8');
    const stdinCheck = spawnSync(process.execPath, ['--input-type=module', '-', 'verify', '--snapshot-root', result.path], { input: streamedTool, encoding: 'utf8', timeout: 5000 });
    assert.equal(stdinCheck.status, 0, stdinCheck.stderr);
    assert.equal(JSON.parse(stdinCheck.stdout).status, 'PASS');
  }
});

test('rollback rehearsal changes only the old entrypoint and preserves WorkingDirectory/state', { skip: posixSkip }, async t => {
  const { result, work, entrypoint } = await snapshot(t);
  const oldExecStart = ['/usr/bin/node', entrypoint, 'sync', '--natural-cycle'];
  const plan = await buildRollbackPlan({
    snapshotRoot: result.path,
    originalExecStart: oldExecStart,
    originalWorkingDirectory: work,
    originalEntrypoint: entrypoint,
  });
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.entrypointIndex, 1);
  assert.equal(plan.workingDirectoryUnchanged, work);
  assert.equal(plan.nonEntrypointArgumentsPreserved, true);
  const rollbackExecStart = [...oldExecStart];
  rollbackExecStart[plan.entrypointIndex] = plan.replacementEntrypoint;
  const run = spawnSync(process.execPath, rollbackExecStart.slice(1), { cwd: work, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { state: 'current-session-state\n', sessionMarker: 'code-only-module', result: 42, args: ['sync', '--natural-cycle'] });
  assert.equal(await readFile(path.join(work, 'state.txt'), 'utf8'), 'current-session-state\n');
});

test('rejects missing and traversal imports before publishing any snapshot', { skip: posixSkip }, async t => {
  const missing = await fixture(t, { entrySource: "import './missing.js';\n" });
  await assert.rejects(createSnapshot({ sourceRoot: missing.source, entrypoint: 'bin/entry.js', destinationParent: missing.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => error.code === 'DEPENDENCY_MISSING');
  const traversal = await fixture(t, { entrySource: "import '../../outside.js';\n" });
  await assert.rejects(createSnapshot({ sourceRoot: traversal.source, entrypoint: 'bin/entry.js', destinationParent: traversal.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => ['PATH_TRAVERSAL_OR_NONCANONICAL', 'PATH_ESCAPE'].includes(error.code));
  assert.deepEqual(await readdir(missing.releases), []);
  assert.deepEqual(await readdir(traversal.releases), []);
});

test('rejects a symlink escape', { skip: platform() === 'win32' ? 'real symlink permissions require POSIX' : false }, async t => {
  const linked = await fixture(t, { entrySource: "import '../src/link.js';\n" });
  const outside = path.join(linked.base, 'outside.js');
  await writeFile(outside, 'export default 1;\n');
  await symlink(outside, path.join(linked.source, 'src', 'link.js'));
  await assert.rejects(createSnapshot({ sourceRoot: linked.source, entrypoint: 'bin/entry.js', destinationParent: linked.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => error.code === 'SYMLINK_NOT_ALLOWED');
});

test('rejects secret-like paths, computed imports, and non-quiesced capture', { skip: posixSkip }, async t => {
  const secret = await fixture(t, { entrySource: "import '../.env.js';\n", secretImport: true });
  let secretReads = 0;
  const fsApi = Object.create(await import('node:fs/promises'));
  fsApi.readFile = async (file, ...args) => {
    if (String(file).endsWith('.env.js')) secretReads += 1;
    return readFile(file, ...args);
  };
  await assert.rejects(createSnapshot({ sourceRoot: secret.source, entrypoint: 'bin/entry.js', destinationParent: secret.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true, fsApi }), error => error.code === 'SENSITIVE_PATH_NOT_READ');
  assert.equal(secretReads, 0);

  for (const relative of ['src/credentials.js', 'src/tokens.js', 'src/secret-config.mjs', 'src/session-store.js']) {
    const sensitive = await fixture(t, { entrySource: `import '../${relative}';\n` });
    const canary = 'synthetic-sensitive-canary';
    await writeFile(path.join(sensitive.source, ...relative.split('/')), `throw new Error('${canary}');\n`);
    let sensitiveReads = 0;
    const protectedFs = Object.create(await import('node:fs/promises'));
    protectedFs.readFile = async (file, ...args) => {
      if (String(file) === path.join(sensitive.source, ...relative.split('/'))) sensitiveReads += 1;
      return readFile(file, ...args);
    };
    await assert.rejects(createSnapshot({ sourceRoot: sensitive.source, entrypoint: 'bin/entry.js', destinationParent: sensitive.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true, fsApi: protectedFs }), error => error.code === 'SENSITIVE_PATH_NOT_READ');
    assert.equal(sensitiveReads, 0, relative);
    assert.deepEqual(await readdir(sensitive.releases), []);
    const tool = fileURLToPath(new URL('../scripts/sync-runtime-snapshot.mjs', import.meta.url));
    const cli = spawnSync(process.execPath, [tool, 'create', '--source-root', sensitive.source, '--entrypoint', 'bin/entry.js', '--destination-parent', sensitive.releases, '--minimum-free-bytes', '1024', '--minimum-free-inodes', '64', '--sync-quiesced', 'yes'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(cli.status, 1);
    const diagnostic = `${cli.stdout}${cli.stderr}`;
    assert.equal(diagnostic.includes(relative), false);
    assert.equal(diagnostic.includes(canary), false);
    assert.deepEqual(JSON.parse(diagnostic), { status: 'STOP', code: 'SENSITIVE_PATH_NOT_READ' });
  }

  const dynamic = await fixture(t, { entrySource: "const name = './value.js'; import(name);\n" });
  await assert.rejects(createSnapshot({ sourceRoot: dynamic.source, entrypoint: 'bin/entry.js', destinationParent: dynamic.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => error.code === 'DYNAMIC_IMPORT_UNSUPPORTED');
  const noQuiescence = await fixture(t);
  await assert.rejects(createSnapshot({ sourceRoot: noQuiescence.source, entrypoint: 'bin/entry.js', destinationParent: noQuiescence.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: false }), error => error.code === 'SYNC_QUIESCENCE_REQUIRED');
});

test('stops on imports hidden in flat and nested template expressions before publishing', { skip: posixSkip }, async t => {
  for (const expression of [
    "const value = `${await import('./runtime-dep.js')}`;",
    "const value = `${`${require('./runtime-dep.cjs')}`}`;",
    "const value = `${`${`${await import('./runtime-dep.js')}`}`}`;",
  ]) {
    const f = await fixture(t, { entrySource: `${expression}\n` });
    await writeFile(path.join(f.source, 'src', 'runtime-dep.js'), 'export default 1;\n');
    await writeFile(path.join(f.source, 'src', 'runtime-dep.cjs'), 'module.exports = 1;\n');
    await assert.rejects(createSnapshot({ sourceRoot: f.source, entrypoint: 'bin/entry.js', destinationParent: f.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => error.code === 'TEMPLATE_EXPRESSION_UNSUPPORTED');
    assert.deepEqual(await readdir(f.releases), []);
  }
});

test('conditional exports follow Node key order for import and require', { skip: posixSkip }, async t => {
  for (const kind of ['import', 'require']) {
    const cases = kind === 'import'
      ? [
          { exports: { import: './import.js', node: './node.js', default: './default.js' }, expected: 'import.js' },
          { exports: { node: './node.js', import: './import.js', default: './default.js' }, expected: 'node.js' },
          { exports: { default: './default.js', import: './import.js', node: './node.js' }, expected: 'default.js' },
          { exports: { require: './require.cjs', import: './import.js', node: './node.js', default: './default.js' }, expected: 'import.js' },
        ]
      : [
          { exports: { require: './require.cjs', node: './node.cjs', default: './default.cjs' }, expected: 'require.cjs' },
          { exports: { node: './node.cjs', require: './require.cjs', default: './default.cjs' }, expected: 'node.cjs' },
          { exports: { default: './default.cjs', require: './require.cjs', node: './node.cjs' }, expected: 'default.cjs' },
          { exports: { import: './import.js', require: './require.cjs', node: './node.cjs', default: './default.cjs' }, expected: 'require.cjs' },
        ];
    for (const scenario of cases) {
      const f = await fixture(t, { entrySource: kind === 'import' ? "import 'synthetic-pkg';\n" : "require('synthetic-pkg');\n" });
      const pkg = path.join(f.source, 'node_modules', 'synthetic-pkg');
      for (const target of Object.values(scenario.exports)) await writeFile(path.join(pkg, target.slice(2)), 'export default 1;\n');
      await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'synthetic-pkg', type: 'module', exports: { '.': scenario.exports } }));
      const probe = kind === 'import'
        ? `console.log(import.meta.resolve('synthetic-pkg'))`
        : `console.log(createRequire(new URL('./package.json', import.meta.url)).resolve('synthetic-pkg'))`;
      const resolved = spawnSync(process.execPath, ['--input-type=module', '-e', kind === 'require' ? `import { createRequire } from 'node:module'; ${probe}` : probe], { cwd: f.source, encoding: 'utf8', timeout: 5000 });
      assert.equal(resolved.status, 0, resolved.stderr);
      const nodePath = kind === 'import' ? fileURLToPath(resolved.stdout.trim()) : resolved.stdout.trim();
      assert.equal(path.basename(nodePath), scenario.expected);
      const result = await createSnapshot({ sourceRoot: f.source, entrypoint: 'bin/entry.js', destinationParent: f.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true });
      const manifest = JSON.parse(await readFile(path.join(result.path, 'sync-snapshot-manifest.json'), 'utf8'));
      assert.equal(manifest.files.some(file => file.path.endsWith(`/synthetic-pkg/${scenario.expected}`)), true);
      const conditionTargets = new Set(Object.values(scenario.exports).map(target => `node_modules/synthetic-pkg/${target.slice(2)}`));
      assert.deepEqual(manifest.files.map(file => file.path).filter(file => conditionTargets.has(file)), [`node_modules/synthetic-pkg/${scenario.expected}`]);
    }
  }
});

test('stops on unsupported export arrays, custom conditions, and pattern targets', { skip: posixSkip }, async t => {
  for (const exports of [
    { '.': ['./first.js', './second.js'] },
    { '.': { custom: './custom.js', default: './default.js' } },
    { '.': { import: './feature/*.js', default: './default.js' } },
  ]) {
    const f = await fixture(t, { entrySource: "import 'synthetic-pkg';\n" });
    await writeFile(path.join(f.source, 'node_modules', 'synthetic-pkg', 'package.json'), JSON.stringify({ name: 'synthetic-pkg', exports }));
    await assert.rejects(createSnapshot({ sourceRoot: f.source, entrypoint: 'bin/entry.js', destinationParent: f.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => ['PACKAGE_EXPORT_UNSUPPORTED', 'PACKAGE_EXPORT_UNRESOLVED'].includes(error.code));
    assert.deepEqual(await readdir(f.releases), []);
  }
});

test('detects source races and refuses insufficient reserve', { skip: posixSkip }, async t => {
  const raced = await fixture(t);
  await assert.rejects(createSnapshot({
    sourceRoot: raced.source,
    entrypoint: 'bin/entry.js',
    destinationParent: raced.releases,
    minimumFreeBytes: 1024,
    minimumFreeInodes: 64,
    quiesced: true,
    hooks: { afterInitialRead: async () => writeFile(path.join(raced.source, 'src', 'value.js'), 'export const changed = true;\n') },
  }), error => error.code === 'SOURCE_CHANGED_BEFORE_PUBLISH');
  assert.deepEqual(await readdir(raced.releases), []);
  await assert.rejects(createSnapshot({ sourceRoot: raced.source, entrypoint: 'bin/entry.js', destinationParent: raced.releases, minimumFreeBytes: Number.MAX_SAFE_INTEGER, minimumFreeInodes: 64, quiesced: true }), error => error.code === 'DISK_RESERVE_INSUFFICIENT');
  const inodeLimited = await fixture(t);
  await assert.rejects(createSnapshot({ sourceRoot: inodeLimited.source, entrypoint: 'bin/entry.js', destinationParent: inodeLimited.releases, minimumFreeBytes: 1024, minimumFreeInodes: Number.MAX_SAFE_INTEGER, quiesced: true }), error => error.code === 'INODE_RESERVE_INSUFFICIENT');
});

test('refuses a world-writable destination parent before writing', { skip: posixSkip }, async t => {
  const f = await fixture(t);
  await chmod(f.releases, 0o777);
  await assert.rejects(createSnapshot({ sourceRoot: f.source, entrypoint: 'bin/entry.js', destinationParent: f.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => error.code === 'DESTINATION_PARENT_WRITABLE_BY_OTHERS');
  assert.deepEqual(await readdir(f.releases), []);
});

test('cleans only its marked temporary or just-published directory after injected interruption', { skip: posixSkip }, async t => {
  const f = await fixture(t);
  for (const hooks of [
    { beforePublish: async () => { throw new Error('synthetic interruption before publish'); } },
    { afterPublishBeforeVerify: async () => { throw new Error('synthetic interruption after atomic rename'); } },
  ]) {
    await assert.rejects(createSnapshot({ sourceRoot: f.source, entrypoint: 'bin/entry.js', destinationParent: f.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true, hooks }));
    assert.deepEqual(await readdir(f.releases), []);
  }
  const result = await createSnapshot({ sourceRoot: f.source, entrypoint: 'bin/entry.js', destinationParent: f.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true });
  assert.equal((await verifySnapshot({ snapshotRoot: result.path })).status, 'PASS');
});

test('stops without deleting an existing or potentially active temporary snapshot directory', { skip: posixSkip }, async t => {
  const f = await fixture(t);
  const stale = path.join(f.releases, '.sync-rollback-tmp-prior');
  await mkdir(stale, { mode: 0o700 });
  await writeFile(path.join(stale, 'marker'), 'unowned-test-marker');
  await assert.rejects(createSnapshot({ sourceRoot: f.source, entrypoint: 'bin/entry.js', destinationParent: f.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => error.code === 'STALE_OR_ACTIVE_TEMP_PRESENT');
  assert.equal(await readFile(path.join(stale, 'marker'), 'utf8'), 'unowned-test-marker');
});

test('detects post-copy corruption and fails closed when rollback snapshot is invalid', { skip: posixSkip }, async t => {
  const { result, work, entrypoint } = await snapshot(t);
  const target = path.join(result.path, 'src', 'value.js');
  await writeFile(target, 'export const changed = true;\n');
  await assert.rejects(verifySnapshot({ snapshotRoot: result.path }), error => error.code === 'SNAPSHOT_CONTENT_MISMATCH');
  await assert.rejects(buildRollbackPlan({
    snapshotRoot: result.path,
    originalExecStart: ['/usr/bin/node', entrypoint, 'sync'],
    originalWorkingDirectory: work,
    originalEntrypoint: entrypoint,
  }), error => error.code === 'SNAPSHOT_CONTENT_MISMATCH');
});

test('verifier rejects symlinked parent directories before reading outside snapshot', { skip: posixSkip }, async t => {
  const { base, result } = await snapshot(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside, { mode: 0o755 });
  await writeFile(path.join(outside, 'value.js'), 'export const leaked = true;\n');
  await rm(path.join(result.path, 'src'), { recursive: true });
  await symlink(outside, path.join(result.path, 'src'), 'dir');

  let outsideRead = false;
  const fsApi = Object.create(await import('node:fs/promises'));
  fsApi.readFile = async (file, ...args) => {
    if (await (await import('node:fs/promises')).realpath(file) === await (await import('node:fs/promises')).realpath(path.join(outside, 'value.js'))) outsideRead = true;
    return readFile(file, ...args);
  };
  await assert.rejects(verifySnapshot({ snapshotRoot: result.path, fsApi }), error => error.code === 'SNAPSHOT_SYMLINK_PRESENT');
  assert.equal(outsideRead, false);
});

test('stops on unresolved package dependency and reports only classified codes', { skip: posixSkip }, async t => {
  const missing = await fixture(t, { includeDependency: false });
  await assert.rejects(createSnapshot({ sourceRoot: missing.source, entrypoint: 'bin/entry.js', destinationParent: missing.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true }), error => error instanceof SnapshotError && error.code === 'DEPENDENCY_MISSING');
});

test('records absent optional peers only when package metadata explicitly marks them optional', { skip: posixSkip }, async t => {
  const f = await fixture(t, { optionalPeer: true });
  const result = await createSnapshot({ sourceRoot: f.source, entrypoint: 'bin/entry.js', destinationParent: f.releases, minimumFreeBytes: 1024, minimumFreeInodes: 64, quiesced: true });
  assert.deepEqual((await verifySnapshot({ snapshotRoot: result.path })).status, 'PASS');
  const manifest = JSON.parse(await readFile(path.join(result.path, 'sync-snapshot-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.optionalDependenciesMissing, ['synthetic-optional-peer']);
  assert.equal(manifest.files.some(file => file.path.includes('synthetic-optional-peer')), false);
});

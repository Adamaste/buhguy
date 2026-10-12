import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { publishRelease, sealRelease, selectRelease, validateReleasePath, verifyRelease } from '../deploy/runtime-release.mjs';

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const manifestHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readOnly = mode => (mode & 0o111) ? 0o555 : 0o444;

function posixTestFs() {
  const api = Object.assign(Object.create(Object.getPrototypeOf(fs)), fs, {
    statfs: async () => ({ bavail: 10_000_000, bsize: 1, ffree: 10_000 }),
  });
  if (process.platform === 'win32') {
    const setDirectories = async (root, mode) => {
      const children = await fs.readdir(root, { withFileTypes: true });
      for (const child of children) {
        const absolute = path.join(root, child.name);
        if (child.isDirectory()) { await setDirectories(absolute, mode); await fs.chmod(absolute, mode); }
      }
    };
    api.lstat = async file => {
      const stat = await fs.lstat(file);
      return new Proxy(stat, {
        get(target, key) {
          if (key === 'dev') return 1;
          if (key === 'mode' && target.isDirectory()) return (target.mode & ~0o777) | 0o555;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    api.rename = async (source, destination) => {
      await setDirectories(source, 0o755);
      await fs.chmod(source, 0o755);
      await fs.rename(source, destination);
      await setDirectories(destination, 0o555);
      await fs.chmod(destination, 0o555);
    };
  }
  return api;
}

async function makeStage(root, sha, label) {
  const stage = path.join(root, `.staging-${sha}`);
  const contents = new Map([
    ['bin/receipt-collector.js', `export const release = '${label}';\n`],
    ['src/cli.js', `export const cliRelease = '${label}';\n`],
    ['deploy/runtime-release.mjs', 'export const releaseTool = true;\n'],
    ['package.json', JSON.stringify({ name: 'synthetic-release', type: 'module', engines: { node: '>=22' }, dependencies: {} }) + '\n'],
    ['package-lock.json', JSON.stringify({ name: 'synthetic-release', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'synthetic-release', version: '1.0.0' } } }) + '\n'],
  ]);
  for (const [relative, content] of contents) {
    const file = path.join(stage, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    await fs.chmod(file, 0o644);
  }
  await fs.mkdir(path.join(stage, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(stage, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  await fs.chmod(path.join(stage, 'node_modules', '.package-lock.json'), 0o644);

  const files = [];
  const directories = [];
  async function collect(dir, relDir = '') {
    const children = await fs.readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const rel = relDir ? `${relDir}/${child.name}` : child.name;
      const absolute = path.join(dir, child.name);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) {
        directories.push({ path: rel, mode: '0555' });
        await collect(absolute, rel);
      } else if (stat.isFile()) {
        const bytes = await fs.readFile(absolute);
        const mode = readOnly(stat.mode);
        await fs.chmod(absolute, mode);
        files.push({ path: rel, type: 'file', size: bytes.length, sha256: manifestHash(bytes), mode: mode.toString(8).padStart(4, '0'), gitBlob: null });
      }
    }
  }
  await collect(stage);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  directories.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const bytes = Buffer.from(`${JSON.stringify({ format: 'buhguy-runtime-release-v1', targetSha: sha, files, directories }, null, 2)}\n`);
  await fs.writeFile(path.join(stage, 'release-manifest.json'), bytes, { mode: 0o444 });
  await fs.chmod(path.join(stage, 'release-manifest.json'), 0o444);
  if (process.platform !== 'win32') {
    for (const entry of [...directories].sort((a, b) => b.path.length - a.path.length)) await fs.chmod(path.join(stage, ...entry.path.split('/')), 0o555);
    await fs.chmod(stage, 0o555);
  }
  return { stage, manifestSha256: manifestHash(bytes) };
}

async function makeWritableAndRemove(root) {
  try {
    async function chmodTree(dir) {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        await fs.chmod(dir, 0o755);
        for (const child of await fs.readdir(dir)) await chmodTree(path.join(dir, child));
      } else await fs.chmod(dir, 0o644);
    }
    await chmodTree(root);
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function publishFixture(releases, release) {
  const testFs = posixTestFs();
  await publishRelease({ releaseRoot: releases, sha: path.basename(release.stage).slice('.staging-'.length), manifestSha256: release.manifestSha256, minimumFreeBytes: 1024, minimumFreeInodes: 10, fsApi: testFs });
}

test('synthetic exact-SHA releases deploy A, B, rollback to A and redeploy B without touching cwd state', async t => {
  const root = await fs.mkdtemp(path.join(testDirectory, '.runtime-release-'));
  t.after(() => makeWritableAndRemove(root));
  const releases = path.join(root, 'releases');
  const stateDir = path.join(root, 'legacy-working-directory', '.receipt-collector');
  await fs.mkdir(releases);
  await fs.mkdir(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'synthetic-state.json');
  await fs.writeFile(stateFile, '{"state":"unchanged"}\n');
  const a = await makeStage(releases, shaA, 'A');
  const b = await makeStage(releases, shaB, 'B');
  const testFs = posixTestFs();
  await publishFixture(releases, a);
  await publishFixture(releases, b);

  let selected = null;
  const selector = { read: async () => selected, replace: async sha => { selected = sha; } };
  await selectRelease({ releaseRoot: releases, sha: shaA, manifestSha256: a.manifestSha256, fsApi: testFs, selector });
  await selectRelease({ releaseRoot: releases, sha: shaB, manifestSha256: b.manifestSha256, previousManifestSha256: a.manifestSha256, fsApi: testFs, selector });
  const rollback = await selectRelease({ releaseRoot: releases, sha: shaA, manifestSha256: a.manifestSha256, previousManifestSha256: b.manifestSha256, fsApi: testFs, selector, action: 'rollback' });
  const redeploy = await selectRelease({ releaseRoot: releases, sha: shaB, manifestSha256: b.manifestSha256, previousManifestSha256: a.manifestSha256, fsApi: testFs, selector });

  assert.equal(rollback.status, 'ROLLED_BACK');
  assert.equal(redeploy.status, 'ACTIVATED');
  assert.equal(selected, shaB);
  assert.equal(await fs.readFile(stateFile, 'utf8'), '{"state":"unchanged"}\n');
});

test('repeat selection is idempotent and does not claim a new switch', async t => {
  const root = await fs.mkdtemp(path.join(testDirectory, '.runtime-idempotent-'));
  t.after(() => makeWritableAndRemove(root));
  const release = await makeStage(root, shaA, 'A');
  await publishFixture(root, release);
  const selector = { read: async () => shaA, replace: async () => assert.fail('same release must not be replaced') };
  const result = await selectRelease({ releaseRoot: root, sha: shaA, manifestSha256: release.manifestSha256, selector, fsApi: posixTestFs() });
  assert.equal(result.status, 'UNCHANGED');
});

test('damaged release fails before pointer replacement and never reports activation', async t => {
  const root = await fs.mkdtemp(path.join(testDirectory, '.runtime-corrupt-'));
  t.after(() => makeWritableAndRemove(root));
  const release = await makeStage(root, shaA, 'A');
  await publishFixture(root, release);
  const entry = path.join(root, shaA, 'src', 'cli.js');
  await fs.chmod(entry, 0o644);
  await fs.writeFile(entry, 'tampered\n');
  await fs.chmod(entry, 0o444);
  let replaceCalls = 0;
  const selector = { read: async () => shaB, replace: async () => { replaceCalls += 1; } };
  await assert.rejects(
    () => selectRelease({ releaseRoot: root, sha: shaA, manifestSha256: release.manifestSha256, selector, fsApi: posixTestFs() }),
    error => error.code === 'FILE_INTEGRITY_MISMATCH',
  );
  assert.equal(replaceCalls, 0);
});

test('no success is returned if selector replacement cannot be observed', async t => {
  const root = await fs.mkdtemp(path.join(testDirectory, '.runtime-no-false-pass-'));
  t.after(() => makeWritableAndRemove(root));
  const release = await makeStage(root, shaA, 'A');
  await publishFixture(root, release);
  const selector = { read: async () => null, replace: async () => {} };
  await assert.rejects(
    () => selectRelease({ releaseRoot: root, sha: shaA, manifestSha256: release.manifestSha256, selector, fsApi: posixTestFs() }),
    error => error.code === 'CURRENT_SWITCH_NOT_CONFIRMED',
  );
});

test('manifest traversal and manifest hash mismatch stop verification', async t => {
  const root = await fs.mkdtemp(path.join(testDirectory, '.runtime-manifest-'));
  t.after(() => makeWritableAndRemove(root));
  const release = await makeStage(root, shaA, 'A');
  const manifestPath = path.join(release.stage, 'release-manifest.json');
  await assert.rejects(() => verifyRelease({ releaseDir: release.stage, sha: shaA, manifestSha256: '0'.repeat(64), runtimeCheck: false }), error => error.code === 'MANIFEST_HASH_MISMATCH');
  await fs.chmod(manifestPath, 0o644);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files[0].path = '../outside.js';
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(manifestPath, bytes);
  await fs.chmod(manifestPath, 0o444);
  const hash = manifestHash(bytes);
  await assert.rejects(() => verifyRelease({ releaseDir: release.stage, sha: shaA, manifestSha256: hash, runtimeCheck: false }), error => ['PATH_TRAVERSAL', 'PATH_INVALID'].includes(error.code));
});

test('dependency documentation is distinct from secret and runtime-state paths', () => {
  assert.equal(
    validateReleasePath('node_modules/playwright-core/lib/tools/skills/playwright-cli/references/storage-state.md'),
    'node_modules/playwright-core/lib/tools/skills/playwright-cli/references/storage-state.md',
  );
  for (const relative of [
    'node_modules/pkg/credentials.md',
    'node_modules/pkg/session.json',
    'node_modules/pkg/browser-profile/session.json',
    'node_modules/pkg/.env.example.txt',
    'node_modules/pkg/private-token.txt',
  ]) {
    assert.throws(() => validateReleasePath(relative), error => error.code === 'SENSITIVE_PATH');
  }
});

test('seal binds a synthetic release to one exact Git tree and verifies runtime dependencies', async t => {
  const root = await fs.mkdtemp(path.join(testDirectory, '.runtime-seal-'));
  t.after(() => makeWritableAndRemove(root));
  const source = path.join(root, 'source');
  const stage = path.join(root, 'stage');
  const sourceFiles = new Map([
    ['bin/receipt-collector.js', 'export const entry = true;\n'],
    ['src/cli.js', 'export const cli = true;\n'],
    ['src/session-store.js', 'export const sessionStoreModule = true;\n'],
    ['src/bank-device-auth.js', 'export const bankDeviceAuthModule = true;\n'],
    ['src/browser-session-import.js', 'export const browserSessionImportModule = true;\n'],
    ['db/migrations/001_initial.sql', 'SELECT 1;\n'],
    ['deploy/runtime-release.mjs', await fs.readFile(fileURLToPath(new URL('../deploy/runtime-release.mjs', import.meta.url)), 'utf8')],
    ['package.json', JSON.stringify({ name: 'synthetic-release', type: 'module', engines: { node: '>=22' }, dependencies: {} }) + '\n'],
    ['package-lock.json', JSON.stringify({ name: 'synthetic-release', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'synthetic-release', version: '1.0.0', engines: { node: '>=22' } } } }) + '\n'],
  ]);
  for (const [relative, content] of sourceFiles) {
    const sourcePath = path.join(source, ...relative.split('/'));
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, content);
  }
  execFileSync('git', ['-C', source, 'init', '-q']);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Synthetic Test']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'synthetic@example.invalid']);
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, 'commit', '-qm', 'synthetic exact release']);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await fs.mkdir(stage);
  for (const [relative] of sourceFiles) {
    const from = path.join(source, ...relative.split('/'));
    const to = path.join(stage, ...relative.split('/'));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npm = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--offline'], { cwd: stage, encoding: 'utf8', stdio: 'ignore', timeout: 60_000 });
  assert.equal(npm.status, 0, `synthetic npm ci failed (${npm.error?.code ?? npm.status})`);
  const dependencyLock = path.join(stage, 'node_modules', '.package-lock.json');
  try { await fs.access(dependencyLock); } catch {
    await fs.mkdir(path.dirname(dependencyLock), { recursive: true });
    await fs.writeFile(dependencyLock, '{"lockfileVersion":3,"packages":{}}\n');
  }
  const entryPath = path.join(stage, 'bin', 'receipt-collector.js');
  const modeMismatchFs = posixTestFs();
  const realLstat = modeMismatchFs.lstat;
  modeMismatchFs.lstat = async filePath => {
    const stat = await realLstat(filePath);
    if (path.resolve(filePath) !== path.resolve(entryPath)) return stat;
    return new Proxy(stat, { get(target, key) { return key === 'mode' ? target.mode | 0o111 : Reflect.get(target, key, target); } });
  };
  await assert.rejects(
    () => sealRelease({ sourceRoot: source, releaseDir: stage, sha, fsApi: modeMismatchFs }),
    error => error.code === 'GIT_MODE_MISMATCH',
  );
  for (const relative of ['.env.production', 'src/session-state.json', 'src/credentials.json', 'src/secret-config.mjs', 'src/browser-profile/profile.json']) {
    const target = path.join(stage, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.chmod(path.dirname(target), 0o755);
    await fs.writeFile(target, 'synthetic-secret-state-marker\n');
    const guardedFs = posixTestFs();
    const readFile = guardedFs.readFile;
    const forbiddenReads = [];
    guardedFs.readFile = async (filePath, ...args) => {
      if (path.resolve(filePath) === path.resolve(target)) forbiddenReads.push(filePath);
      return readFile.call(guardedFs, filePath, ...args);
    };
    await assert.rejects(() => sealRelease({ sourceRoot: source, releaseDir: stage, sha, fsApi: guardedFs }), error => error.code === 'SENSITIVE_PATH');
    assert.deepEqual(forbiddenReads, [], `${relative} must be rejected before reading file content`);
    await fs.unlink(target);
    if (relative.startsWith('src/browser-profile/')) await fs.rmdir(path.dirname(target));
  }

  const identityFs = posixTestFs();
  if (process.platform === 'win32') {
    const lstat = identityFs.lstat;
    let firstEntryStat = true;
    identityFs.lstat = async filePath => {
      const stat = await lstat(filePath);
      if (firstEntryStat && path.resolve(filePath) === path.resolve(entryPath)) {
        firstEntryStat = false;
        return new Proxy(stat, { get(target, key) { return key === 'dev' ? 0 : Reflect.get(target, key, target); } });
      }
      return stat;
    };
  }
  const result = await sealRelease({ sourceRoot: source, releaseDir: stage, sha, fsApi: identityFs });
  assert.equal(result.status, 'PASS');
  assert.equal(result.sha, sha);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  const manifest = JSON.parse(await fs.readFile(path.join(stage, 'release-manifest.json'), 'utf8'));
  for (const relative of ['src/session-store.js', 'src/bank-device-auth.js', 'src/browser-session-import.js']) {
    assert.ok(manifest.files.some(entry => entry.path === relative && entry.gitBlob));
  }

  const missingRuntimeFile = path.join(stage, 'src', 'cli.js');
  await fs.chmod(path.dirname(missingRuntimeFile), 0o755);
  await fs.unlink(missingRuntimeFile);
  await fs.chmod(path.dirname(missingRuntimeFile), 0o555);
  await assert.rejects(
    () => verifyRelease({ releaseDir: stage, sha, manifestSha256: result.manifestSha256, fsApi: posixTestFs(), runtimeCheck: false }),
    error => error.code === 'INVENTORY_MISMATCH',
  );
});

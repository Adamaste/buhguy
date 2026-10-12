#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FORMAT = 'buhguy-runtime-release-v1';
const MANIFEST = 'release-manifest.json';
const SHA_RE = /^[a-f0-9]{40}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const CODE_ROOTS = ['bin/', 'src/', 'db/migrations/'];
const SOURCE_CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const ALLOWED_DIRECTORIES = new Set(['bin', 'src', 'db', 'db/migrations', 'deploy', 'node_modules']);
const EXACT_CODE_FILES = new Set(['package.json', 'package-lock.json', 'deploy/runtime-release.mjs']);
const SENSITIVE = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|cookie|cookies|auth|session|sessions|profile|profiles|state|backup|backups|dump|dumps|log|logs|cache|browser-profile)([._-]|$)/i;
const NEVER_RELEASE_COMPONENTS = new Set([
  '.env', '.receipt-collector', '.local-browsers', 'ms-playwright',
  'session', 'sessions', 'profile', 'profiles', 'state', 'runtime-state',
  'secret', 'secrets', 'credential', 'credentials', 'token', 'tokens',
  'cookie', 'cookies', 'browser-profile', 'browser-profiles',
]);
const NEVER_RELEASE_SOURCE_BASENAMES = new Set([
  'secret', 'secrets', 'secret-config', 'credential', 'credentials',
  'token', 'tokens', 'cookie', 'cookies', 'session', 'sessions',
  'profile', 'profiles', 'state', 'runtime-state',
]);

export class ReleaseError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new ReleaseError(code); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function comparePaths(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return crypto.createHash('sha1').update(header).update(bytes).digest('hex');
}
function assertSha(value) { if (typeof value !== 'string' || !SHA_RE.test(value)) fail('SHA_INVALID'); }
function assertManifestHash(value) { if (typeof value !== 'string' || !HASH_RE.test(value)) fail('MANIFEST_SHA_INVALID'); }

function sourcePathIsVerified(value, trustedSourcePaths) {
  if (!CODE_ROOTS.some(prefix => value.startsWith(prefix))) return false;
  if (!trustedSourcePaths) return false;
  if (trustedSourcePaths.has(value)) return true;
  return [...trustedSourcePaths].some(file => file.startsWith(`${value}/`));
}

function normalizePath(value, { trustedSourcePaths = null } = {}) {
  if (typeof value !== 'string' || !value || /[\0\r\n\t]/.test(value) || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) fail('PATH_INVALID');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) fail('PATH_TRAVERSAL');
  const lowerParts = parts.map(part => part.toLowerCase());
  if (lowerParts.some(part => part.startsWith('.env') || NEVER_RELEASE_COMPONENTS.has(part))) fail('SENSITIVE_PATH');
  const isSourcePath = sourcePathIsVerified(value, trustedSourcePaths);
  const sourceBase = path.basename(value, path.extname(value)).toLowerCase();
  if (isSourcePath && NEVER_RELEASE_SOURCE_BASENAMES.has(sourceBase)) fail('SENSITIVE_PATH');
  if (parts.some(part => SENSITIVE.test(part)) && !isSourcePath) fail('SENSITIVE_PATH');
  if (isSourcePath && !SOURCE_CODE_EXTENSIONS.has(path.extname(value).toLowerCase()) && trustedSourcePaths.has(value)) fail('SENSITIVE_PATH');
  const allowed = EXACT_CODE_FILES.has(value) || ALLOWED_DIRECTORIES.has(value) || CODE_ROOTS.some(prefix => value.startsWith(prefix)) || value.startsWith('node_modules/');
  if (!allowed) fail('PATH_OUTSIDE_RUNTIME_ALLOWLIST');
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function modeString(mode) { return (mode & 0o777).toString(8).padStart(4, '0'); }
function expectedReadOnlyMode(mode) { return (mode & 0o111) ? 0o555 : 0o444; }

async function ensureRealDirectory(dir, fsApi = fs) {
  const absolute = path.resolve(dir);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  let stat;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    stat = await fsApi.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('DIRECTORY_PATH_NOT_REAL');
  }
  if (!stat) fail('DIRECTORY_NOT_REAL');
  return stat;
}

function assertTrustedReleaseDirectory(stat) {
  if (process.platform === 'linux' && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) fail('RELEASE_ROOT_OWNER_OR_MODE_INVALID');
}

async function walkRelease(root, { fsApi = fs, normalizeModes = false, trustedSourcePaths = null } = {}) {
  const files = [];
  const directories = [];
  const visit = async (directory, relativeDirectory = '') => {
    const children = await fsApi.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => comparePaths(a.name, b.name));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (relative === MANIFEST && !relativeDirectory) continue;
      normalizePath(relative, { trustedSourcePaths });
      const absolute = path.join(directory, child.name);
      const stat = await fsApi.lstat(absolute);
      if (stat.isSymbolicLink()) {
        if (stat.nlink > 1) fail('HARDLINK_NOT_ALLOWED');
        const target = await fsApi.readlink(absolute);
        if (path.isAbsolute(target) || /^[a-z]:/i.test(target) || target.includes('\\') || target.includes('\0')) fail('SYMLINK_TARGET_INVALID');
        const resolved = path.resolve(path.dirname(absolute), target);
        if (!inside(root, resolved)) fail('SYMLINK_ESCAPE');
        let realTarget;
        try { realTarget = await fsApi.realpath(absolute); } catch { fail('SYMLINK_TARGET_MISSING'); }
        if (!inside(root, realTarget)) fail('SYMLINK_ESCAPE');
        files.push({ path: relative, type: 'symlink', target });
        continue;
      }
      if (stat.isDirectory()) {
        if (normalizeModes) await fsApi.chmod(absolute, 0o555);
        const after = await fsApi.lstat(absolute);
        directories.push({ path: relative, mode: modeString(after.mode) });
        await visit(absolute, relative);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1) fail('FILE_TYPE_OR_HARDLINK_UNSUPPORTED');
      const before = stat;
      const bytes = await fsApi.readFile(absolute);
      if (normalizeModes) await fsApi.chmod(absolute, expectedReadOnlyMode(stat.mode));
      const after = await fsApi.lstat(absolute);
      if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) fail('SOURCE_CHANGED_DURING_READ');
      if ((after.mode & 0o222) !== 0) fail('RELEASE_WRITABLE');
      files.push({
        path: relative,
        type: 'file',
        size: bytes.length,
        sha256: sha256(bytes),
        mode: modeString(after.mode),
        gitBlob: gitBlobSha(bytes),
      });
    }
  };
  await visit(root);
  files.sort((a, b) => comparePaths(a.path, b.path));
  directories.sort((a, b) => comparePaths(a.path, b.path));
  return { files, directories };
}

async function readManifest(releaseDir, expectedSha, expectedManifestSha256, fsApi = fs) {
  assertSha(expectedSha);
  assertManifestHash(expectedManifestSha256);
  await ensureRealDirectory(releaseDir, fsApi);
  const manifestPath = path.join(releaseDir, MANIFEST);
  const stat = await fsApi.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || (stat.mode & 0o222) !== 0) fail('MANIFEST_NOT_IMMUTABLE');
  const bytes = await fsApi.readFile(manifestPath);
  if (sha256(bytes) !== expectedManifestSha256) fail('MANIFEST_HASH_MISMATCH');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('MANIFEST_INVALID_JSON'); }
  if (!manifest || manifest.format !== FORMAT || manifest.targetSha !== expectedSha || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) fail('MANIFEST_SCHEMA_INVALID');
  return { manifest, bytes };
}

function validateManifestLists(manifest) {
  const trustedSourcePaths = new Set(manifest.files
    .filter(entry => entry && entry.type === 'file' && typeof entry.path === 'string'
      && typeof entry.gitBlob === 'string' && /^[a-f0-9]{40}$/.test(entry.gitBlob)
      && CODE_ROOTS.some(prefix => entry.path.startsWith(prefix))
      && SOURCE_CODE_EXTENSIONS.has(path.extname(entry.path).toLowerCase()))
    .map(entry => entry.path));
  const paths = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('MANIFEST_ENTRY_INVALID');
    const relative = normalizePath(entry.path, { trustedSourcePaths });
    if (paths.has(relative)) fail('MANIFEST_DUPLICATE_PATH');
    paths.add(relative);
    if (entry.type === 'file') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !HASH_RE.test(entry.sha256) || !['0444', '0555'].includes(entry.mode)) fail('MANIFEST_FILE_ENTRY_INVALID');
      if (entry.gitBlob !== null && (typeof entry.gitBlob !== 'string' || !/^[a-f0-9]{40}$/.test(entry.gitBlob))) fail('MANIFEST_GIT_BLOB_INVALID');
    } else if (entry.type === 'symlink') {
      if (typeof entry.target !== 'string' || !entry.target || path.isAbsolute(entry.target) || /^[a-z]:/i.test(entry.target) || entry.target.includes('\\') || entry.target.includes('\0')) fail('MANIFEST_SYMLINK_INVALID');
      const resolved = path.resolve(path.dirname(path.join('root', ...relative.split('/'))), entry.target);
      if (!inside(path.resolve('root'), resolved)) fail('MANIFEST_SYMLINK_ESCAPE');
    } else fail('MANIFEST_ENTRY_TYPE_INVALID');
  }
  for (const entry of manifest.directories) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.mode !== '0555') fail('MANIFEST_DIRECTORY_ENTRY_INVALID');
    const relative = normalizePath(entry.path, { trustedSourcePaths });
    if (paths.has(relative)) fail('MANIFEST_DUPLICATE_PATH');
    paths.add(relative);
  }
  const ordered = [...paths].sort(comparePaths);
  const actual = [...manifest.files.map(x => x.path), ...manifest.directories.map(x => x.path)].sort(comparePaths);
  if (actual.some((value, index) => value !== ordered[index])) fail('MANIFEST_ORDER_OR_PATH_INVALID');
  for (const required of ['package.json', 'package-lock.json', 'bin/receipt-collector.js', 'src/cli.js', 'deploy/runtime-release.mjs']) {
    if (!manifest.files.some(entry => entry.path === required && entry.type === 'file')) fail('RUNTIME_FILE_MISSING');
  }
  return trustedSourcePaths;
}

function compareInventory(expected, actual) {
  if (expected.files.length !== actual.files.length || expected.directories.length !== actual.directories.length) fail('INVENTORY_MISMATCH');
  for (let i = 0; i < expected.files.length; i += 1) {
    const a = expected.files[i];
    const b = actual.files[i];
    if (a.path !== b.path || a.type !== b.type) fail('INVENTORY_MISMATCH');
    if (a.type === 'file' && (a.size !== b.size || a.sha256 !== b.sha256 || a.mode !== b.mode)) fail('FILE_INTEGRITY_MISMATCH');
    if (a.type === 'file' && a.gitBlob !== null && a.gitBlob !== b.gitBlob) fail('GIT_BLOB_MISMATCH');
    if (a.type === 'symlink' && a.target !== b.target) fail('SYMLINK_TARGET_MISMATCH');
  }
  for (let i = 0; i < expected.directories.length; i += 1) {
    if (expected.directories[i].path !== actual.directories[i].path || expected.directories[i].mode !== actual.directories[i].mode) fail('DIRECTORY_INTEGRITY_MISMATCH');
  }
}

function runImportSmoke(releaseDir) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/cli.js')"], {
    cwd: releaseDir,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    stdio: 'ignore',
    timeout: 20_000,
  });
  if (result.error || result.status !== 0) fail('RUNTIME_IMPORT_FAILED');
}

export async function verifyRelease({ releaseDir, sha, manifestSha256, fsApi = fs, runtimeCheck = true }) {
  const { manifest } = await readManifest(releaseDir, sha, manifestSha256, fsApi);
  const trustedSourcePaths = validateManifestLists(manifest);
  const rootStat = await fsApi.lstat(releaseDir);
  if ((rootStat.mode & 0o222) !== 0) fail('RELEASE_ROOT_WRITABLE');
  const actual = await walkRelease(releaseDir, { fsApi, trustedSourcePaths });
  compareInventory({ files: manifest.files, directories: manifest.directories }, actual);
  if (runtimeCheck) {
    const major = Number(process.versions.node.split('.')[0]);
    if (!Number.isInteger(major) || major < 22) fail('NODE_VERSION_UNSUPPORTED');
    runImportSmoke(releaseDir);
  }
  return { status: 'PASS', sha, manifestSha256, fileCount: manifest.files.length, directoryCount: manifest.directories.length, totalBytes: manifest.files.filter(x => x.type === 'file').reduce((sum, x) => sum + x.size, 0) };
}

function git(sourceRoot, args, options = {}) {
  const result = spawnSync('git', ['-C', sourceRoot, ...args], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) fail('GIT_SOURCE_CHECK_FAILED');
  return result.stdout;
}

function gitPathList(sourceRoot, sha) {
  const output = git(sourceRoot, ['ls-tree', '-r', '-z', '--name-only', sha, '--', 'bin', 'src', 'db/migrations', 'deploy/runtime-release.mjs', 'package.json', 'package-lock.json']);
  return output.toString('utf8').split('\0').filter(Boolean).sort(comparePaths);
}

function isGitRuntimeFile(relative) {
  return EXACT_CODE_FILES.has(relative) || CODE_ROOTS.some(prefix => relative.startsWith(prefix));
}

function gitTreeEntry(sourceRoot, sha, relative) {
  const output = git(sourceRoot, ['ls-tree', '-z', sha, '--', relative]).toString('utf8').split('\0').filter(Boolean);
  if (output.length !== 1) fail('GIT_TREE_ENTRY_INVALID');
  const tab = output[0].indexOf('\t');
  if (tab < 0 || output[0].slice(tab + 1) !== relative) fail('GIT_TREE_ENTRY_INVALID');
  const [mode, type, objectSha] = output[0].slice(0, tab).split(' ');
  if (type !== 'blob' || !['100644', '100755'].includes(mode) || !/^[a-f0-9]{40}$/.test(objectSha)) fail('GIT_TREE_ENTRY_INVALID');
  return { mode, objectSha };
}

async function walkForSeal(root, fsApi = fs, trustedSourcePaths = null) {
  const files = [];
  const directories = [];
  const visit = async (dir, relDir = '') => {
    const children = await fsApi.readdir(dir, { withFileTypes: true });
    children.sort((a, b) => comparePaths(a.name, b.name));
    for (const child of children) {
      const relative = relDir ? `${relDir}/${child.name}` : child.name;
      if (relative === MANIFEST && !relDir) fail('MANIFEST_ALREADY_EXISTS');
      normalizePath(relative, { trustedSourcePaths });
      const absolute = path.join(dir, child.name);
      const stat = await fsApi.lstat(absolute);
      if (stat.isSymbolicLink()) {
        if (stat.nlink > 1) fail('HARDLINK_NOT_ALLOWED');
        const target = await fsApi.readlink(absolute);
        const resolved = path.resolve(path.dirname(absolute), target);
        if (path.isAbsolute(target) || target.includes('\\') || !inside(root, resolved)) fail('SYMLINK_ESCAPE');
        try { if (!inside(root, await fsApi.realpath(absolute))) fail('SYMLINK_ESCAPE'); } catch { fail('SYMLINK_TARGET_MISSING'); }
        files.push({ path: relative, type: 'symlink', target });
        continue;
      }
      if (stat.isDirectory()) { directories.push(relative); await visit(absolute, relative); continue; }
      if (!stat.isFile() || stat.nlink > 1) fail('FILE_TYPE_OR_HARDLINK_UNSUPPORTED');
      const bytes = await fsApi.readFile(absolute);
      const after = await fsApi.lstat(absolute);
      if (after.isSymbolicLink()) fail('SOURCE_PATH_CHANGED_DURING_READ');
      if (stat.dev !== after.dev || stat.ino !== after.ino) fail('SOURCE_IDENTITY_CHANGED_DURING_READ');
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.mode !== after.mode) fail('SOURCE_METADATA_CHANGED_DURING_READ');
      if (bytes.length !== stat.size) fail('SOURCE_READ_LENGTH_MISMATCH');
      files.push({ path: relative, type: 'file', bytes, sourceMode: stat.mode & 0o777 });
    }
  };
  await visit(root);
  return { files, directories };
}

function validatePackageMetadata(releaseDir) {
  let pkg;
  try { pkg = JSON.parse(execFileSync(process.execPath, ['-e', "process.stdout.write(require('fs').readFileSync('package.json'))"], { cwd: releaseDir, encoding: 'utf8' })); }
  catch { fail('PACKAGE_METADATA_INVALID'); }
  if (!pkg.engines?.node || !/^>=\s*22(?:\.0\.0)?(?:\s|$)/.test(String(pkg.engines.node))) fail('NODE_ENGINE_REQUIREMENT_MISSING');
  const npmArgs = ['ls', '--omit=dev', '--all', '--json'];
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npm = process.platform === 'win32'
    ? spawnSync(process.execPath, [npmCli, ...npmArgs], { cwd: releaseDir, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    : spawnSync('npm', npmArgs, { cwd: releaseDir, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  if (npm.error || npm.status !== 0) fail('RUNTIME_DEPENDENCIES_INVALID');
  let tree;
  try { tree = JSON.parse(npm.stdout); } catch { fail('RUNTIME_DEPENDENCIES_INVALID'); }
  if (tree.problems?.length) fail('RUNTIME_DEPENDENCIES_INVALID');
}

export async function sealRelease({ sourceRoot, releaseDir, sha, fsApi = fs }) {
  assertSha(sha);
  const commit = git(sourceRoot, ['rev-parse', '--verify', `${sha}^{commit}`]).toString('utf8').trim();
  if (commit !== sha) fail('GIT_SHA_MISMATCH');
  await ensureRealDirectory(releaseDir, fsApi);
  const expectedCodePaths = gitPathList(sourceRoot, sha);
  const trustedSourcePaths = new Set(expectedCodePaths.filter(relative => CODE_ROOTS.some(prefix => relative.startsWith(prefix)) && SOURCE_CODE_EXTENSIONS.has(path.extname(relative).toLowerCase())));
  const inventory = await walkForSeal(releaseDir, fsApi, trustedSourcePaths);
  const stageCodePaths = inventory.files.filter(entry => isGitRuntimeFile(entry.path)).map(entry => entry.path).sort((a, b) => a.localeCompare(b, 'en'));
  if (stageCodePaths.length !== expectedCodePaths.length || stageCodePaths.some((p, i) => p !== expectedCodePaths[i])) fail('GIT_TREE_CONTENT_MISMATCH');
  for (const entry of inventory.files.filter(item => isGitRuntimeFile(item.path))) {
    if (entry.type !== 'file') fail('GIT_BLOB_MISMATCH');
    const gitEntry = gitTreeEntry(sourceRoot, sha, entry.path);
    const sourceExecutable = (entry.sourceMode & 0o111) !== 0;
    if (sourceExecutable !== (gitEntry.mode === '100755')) fail('GIT_MODE_MISMATCH');
    if (gitBlobSha(entry.bytes) !== gitEntry.objectSha) fail('GIT_BLOB_MISMATCH');
  }
  if (!inventory.files.some(item => item.path === 'node_modules/.package-lock.json' || item.path.startsWith('node_modules/'))) fail('RUNTIME_DEPENDENCIES_MISSING');
  validatePackageMetadata(releaseDir);

  const files = [];
  for (const entry of inventory.files) {
    if (entry.type === 'symlink') {
      files.push({ path: entry.path, type: 'symlink', target: entry.target });
      continue;
    }
    const mode = expectedReadOnlyMode(entry.sourceMode);
    await fsApi.chmod(path.join(releaseDir, ...entry.path.split('/')), mode);
    files.push({
      path: entry.path,
      type: 'file',
      size: entry.bytes.length,
      sha256: sha256(entry.bytes),
      mode: modeString(mode),
      gitBlob: isGitRuntimeFile(entry.path) ? gitBlobSha(entry.bytes) : null,
    });
  }
  const directories = inventory.directories.map(relative => ({ path: relative, mode: '0555' }));
  files.sort((a, b) => comparePaths(a.path, b.path));
  directories.sort((a, b) => comparePaths(a.path, b.path));
  const manifest = { format: FORMAT, targetSha: sha, files, directories };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = path.join(releaseDir, MANIFEST);
  const handle = await fsApi.open(manifestPath, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fsApi.chmod(manifestPath, 0o444);
  for (const directory of [...directories].sort((a, b) => b.path.length - a.path.length)) {
    await fsApi.chmod(path.join(releaseDir, ...directory.path.split('/')), 0o555);
  }
  await fsApi.chmod(releaseDir, 0o555);
  const manifestSha256 = sha256(bytes);
  const verified = await verifyRelease({ releaseDir, sha, manifestSha256, fsApi });
  return { ...verified, manifestSha256 };
}

async function withLock(releaseRoot, action, fsApi = fs) {
  const lockPath = path.join(releaseRoot, '.runtime-release.lock');
  let lock;
  try { lock = await fsApi.open(lockPath, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') fail('RELEASE_LOCK_EXISTS'); throw error; }
  try { return await action(); }
  finally {
    await lock.close();
    await fsApi.unlink(lockPath);
  }
}

function requireLinuxRoot() {
  if (process.platform !== 'linux') fail('MUTATION_REQUIRES_LINUX');
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) fail('MUTATION_REQUIRES_ROOT');
}

async function checkFreeReserve(root, minimumFreeBytes, minimumFreeInodes, fsApi = fs) {
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0 || !Number.isSafeInteger(minimumFreeInodes) || minimumFreeInodes <= 0) fail('RESERVE_REQUIRED');
  if (typeof fsApi.statfs !== 'function') fail('STATFS_UNAVAILABLE');
  const stat = await fsApi.statfs(root);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  const freeInodes = Number(stat.ffree);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < minimumFreeBytes || freeInodes < minimumFreeInodes) fail('FREE_RESERVE_INSUFFICIENT');
  return { freeBytes, freeInodes };
}

export async function publishRelease({ releaseRoot, sha, manifestSha256, minimumFreeBytes, minimumFreeInodes, fsApi = fs }) {
  assertSha(sha);
  assertManifestHash(manifestSha256);
  const root = path.resolve(releaseRoot);
  assertTrustedReleaseDirectory(await ensureRealDirectory(root, fsApi));
  const stage = path.join(root, `.staging-${sha}`);
  const destination = path.join(root, sha);
  await checkFreeReserve(root, minimumFreeBytes, minimumFreeInodes, fsApi);
  return withLock(root, async () => {
    try {
      await fsApi.lstat(destination);
      const verified = await verifyRelease({ releaseDir: destination, sha, manifestSha256, fsApi });
      return { ...verified, status: 'ALREADY_PUBLISHED' };
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const rootStat = await fsApi.stat(root);
    const stageStat = await fsApi.lstat(stage);
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail('STAGE_NOT_REAL_DIRECTORY');
    if (process.platform === 'linux' && rootStat.dev !== stageStat.dev) fail('STAGE_FILESYSTEM_MISMATCH');
    if (process.platform === 'linux' && (stageStat.uid !== 0 || (stageStat.mode & 0o222) !== 0)) fail('STAGE_OWNER_OR_MODE_INVALID');
    await verifyRelease({ releaseDir: stage, sha, manifestSha256, fsApi });
    if (process.platform === 'linux') {
      const manifestResult = await readManifest(stage, sha, manifestSha256, fsApi);
      const trustedSourcePaths = validateManifestLists(manifestResult.manifest);
      const items = await walkRelease(stage, { fsApi, trustedSourcePaths });
      for (const item of [...items.files, ...items.directories]) {
        const relative = item.path;
        const st = await fsApi.lstat(path.join(stage, ...relative.split('/')));
        if (st.uid !== 0 || (item.type !== 'symlink' && (st.mode & 0o222) !== 0)) fail('RELEASE_OWNER_OR_MODE_INVALID');
      }
    }
    await checkFreeReserve(root, minimumFreeBytes, minimumFreeInodes, fsApi);
    await fsApi.rename(stage, destination);
    const published = await verifyRelease({ releaseDir: destination, sha, manifestSha256, fsApi });
    return { ...published, status: 'PUBLISHED' };
  }, fsApi);
}

async function readCurrent(releaseRoot, fsApi = fs) {
  const current = path.join(releaseRoot, 'current');
  let stat;
  try { stat = await fsApi.lstat(current); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isSymbolicLink()) fail('CURRENT_NOT_SYMLINK');
  const target = await fsApi.readlink(current);
  assertSha(target);
  return target;
}

async function syncDirectory(dir, fsApi = fs) {
  const handle = await fsApi.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicSetCurrent(releaseRoot, sha, fsApi = fs) {
  const temporary = path.join(releaseRoot, `.current-${process.pid}-${crypto.randomUUID()}`);
  let renamed = false;
  try {
    await fsApi.symlink(sha, temporary, 'dir');
    await fsApi.rename(temporary, path.join(releaseRoot, 'current'));
    renamed = true;
    try { await syncDirectory(releaseRoot, fsApi); } catch { fail('CURRENT_SWITCH_DURABILITY_UNCONFIRMED'); }
  } catch (error) {
    if (!renamed) {
      try { await fsApi.unlink(temporary); } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') fail('TEMP_POINTER_CLEANUP_FAILED'); }
    }
    throw error;
  }
}

export async function selectRelease({ releaseRoot, sha, manifestSha256, previousManifestSha256 = null, fsApi = fs, selector = null, action = 'activate' }) {
  assertSha(sha);
  assertManifestHash(manifestSha256);
  const root = path.resolve(releaseRoot);
  assertTrustedReleaseDirectory(await ensureRealDirectory(root, fsApi));
  const selected = selector ?? {
    read: () => readCurrent(root, fsApi),
    replace: value => atomicSetCurrent(root, value, fsApi),
  };
  return withLock(root, async () => {
    const releaseDir = path.join(root, sha);
    const verified = await verifyRelease({ releaseDir, sha, manifestSha256, fsApi });
    const previousSha = await selected.read();
    if (previousSha === sha) return { ...verified, status: 'UNCHANGED', previousSha, selectedSha: sha };
    if (previousSha !== null) {
      assertManifestHash(previousManifestSha256);
      await verifyRelease({ releaseDir: path.join(root, previousSha), sha: previousSha, manifestSha256: previousManifestSha256, fsApi });
    }
    await selected.replace(sha);
    const selectedSha = await selected.read();
    if (selectedSha !== sha) fail('CURRENT_SWITCH_NOT_CONFIRMED');
    return { ...verified, status: action === 'rollback' ? 'ROLLED_BACK' : 'ACTIVATED', previousSha, selectedSha };
  }, fsApi);
}

function argumentsMap(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { result._.push(item); continue; }
    const [key, inline] = item.slice(2).split('=', 2);
    if (inline !== undefined) result[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) result[key] = argv[++i];
    else result[key] = true;
  }
  return result;
}

function requiredString(args, name) { if (typeof args[name] !== 'string' || !args[name]) fail('ARGUMENT_REQUIRED'); return args[name]; }
function requiredPositiveInteger(args, name) { const value = Number(args[name]); if (!Number.isSafeInteger(value) || value <= 0) fail('ARGUMENT_INVALID'); return value; }
function safeOutput(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsMap(argv);
  const command = args._[0];
  if (command === 'seal') {
    const result = await sealRelease({ sourceRoot: path.resolve(requiredString(args, 'source-root')), releaseDir: path.resolve(requiredString(args, 'release-dir')), sha: requiredString(args, 'sha') });
    safeOutput(result);
    return 0;
  }
  if (command === 'verify') {
    const result = await verifyRelease({ releaseDir: path.resolve(requiredString(args, 'release-dir')), sha: requiredString(args, 'sha'), manifestSha256: requiredString(args, 'manifest-sha256') });
    safeOutput(result);
    return 0;
  }
  if (command === 'publish') {
    requireLinuxRoot();
    const result = await publishRelease({
      releaseRoot: requiredString(args, 'release-root'), sha: requiredString(args, 'sha'), manifestSha256: requiredString(args, 'manifest-sha256'),
      minimumFreeBytes: requiredPositiveInteger(args, 'minimum-free-bytes'), minimumFreeInodes: requiredPositiveInteger(args, 'minimum-free-inodes'),
    });
    safeOutput(result);
    return 0;
  }
  if (command === 'activate' || command === 'rollback') {
    requireLinuxRoot();
    const result = await selectRelease({ releaseRoot: requiredString(args, 'release-root'), sha: requiredString(args, 'sha'), manifestSha256: requiredString(args, 'manifest-sha256'), previousManifestSha256: args['previous-manifest-sha256'] ?? null, action: command });
    safeOutput(result);
    return 0;
  }
  fail('COMMAND_INVALID');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = error instanceof ReleaseError ? error.code : 'UNEXPECTED_FAILURE';
    process.stderr.write(`${JSON.stringify({ status: 'STOP', code })}\n`);
    process.exitCode = 2;
  });
}


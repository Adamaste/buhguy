#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sensitiveSegments = new Set([
  '.receipt-collector', '.env', 'state', 'sessions', 'profiles', 'browser-profile',
  '.browser', 'secrets', 'secret', 'credentials', 'credential', 'tokens', 'token',
  'backups', 'backup', 'dumps', 'dump', 'logs', 'log', 'financial-data',
  'receipt-data', 'bank-data',
]);
const codeExtensions = new Set(['.js', '.mjs', '.cjs', '.sh', '.sql', '.py', '.node']);
const metadataNames = new Set(['package.json', 'package-lock.json', '.package-lock.json']);
const maxFileBytes = 64 * 1024 * 1024;
const sensitiveName = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|cookie|cookies|auth|session|sessions|profile|profiles|state)([._-]|$)/i;
const posixModesAvailable = process.platform !== 'win32';

function classifyPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) {
    return { kind: 'invalid', code: 'MANIFEST_PATH_INVALID' };
  }
  const normalized = raw.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')) {
    return { kind: 'invalid', code: 'MANIFEST_PATH_ABSOLUTE' };
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(part => part === '.' || part === '..')) {
    return { kind: 'invalid', code: 'MANIFEST_PATH_TRAVERSAL' };
  }
  const lower = segments.map(part => part.toLowerCase());
  if (lower.some(part => sensitiveSegments.has(part) || part === '.env.local' || part.startsWith('.env.') || sensitiveName.test(part))) {
    return { kind: 'sensitive', code: 'SENSITIVE_PATH_NOT_READ' };
  }
  if (lower.some(part => ['.local-browsers', 'ms-playwright', 'chromium-binaries'].includes(part))) {
    return { kind: 'sensitive', code: 'BROWSER_BINARY_NOT_READ' };
  }
  if (lower.some(part => ['.cache', 'chrome-linux', 'chromium-linux', 'firefox-bin', 'webkit-bin'].includes(part))) {
    return { kind: 'sensitive', code: 'BROWSER_OR_CACHE_NOT_READ' };
  }
  const base = lower.at(-1);
  const ext = path.posix.extname(base ?? '');
  if (sensitiveName.test(base ?? '')) return { kind: 'sensitive', code: 'SUSPICIOUS_NAME_NOT_READ' };
  if (metadataNames.has(base) || codeExtensions.has(ext)) return { kind: 'code' };
  return { kind: 'unknown', code: 'PATH_CLASS_UNCONFIRMED' };
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function classifyFsError(error) {
  if (error?.code === 'ENOENT') return 'MISSING_PATH';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'PERMISSION_DENIED';
  if (error?.code === 'EIO') return 'READ_IO_ERROR';
  return 'FILESYSTEM_ERROR';
}

function normalizeMode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value & 0o777;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^(?:0?[0-7]{3}|100[0-7]{3})$/.test(text)) return null;
  return Number.parseInt(text.slice(-3), 8);
}

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(bytes).digest('hex');
}

export async function verifyReleaseManifest({ releaseRoot, expectedTargetSha, fsApi = fs }) {
  const root = path.resolve(releaseRoot);
  const summary = { status: 'UNCONFIRMED', expectedTargetSha, targetSha: null, rootMode: null, total: 0, verified: 0, excludedSensitive: 0, unclassified: 0, failures: 0, entries: [] };
  const add = (relativePath, code, kind = 'failure') => {
    if (kind === 'sensitive') { summary.excludedSensitive += 1; summary.unclassified += 1; }
    else if (kind === 'unclassified') summary.unclassified += 1;
    else if (kind === 'verified') summary.verified += 1;
    else summary.failures += 1;
    summary.entries.push({ path: kind === 'sensitive' ? '<redacted-sensitive-path>' : relativePath, status: code });
  };
  const finish = () => {
    if (summary.failures > 0) summary.status = 'FAIL';
    else if (summary.unclassified > 0 || summary.excludedSensitive > 0 || summary.verified !== summary.total) summary.status = 'UNCONFIRMED';
    else summary.status = 'PASS';
    return summary;
  };
  const addFsError = (relativePath, error) => {
    const code = classifyFsError(error);
    add(relativePath, code, ['PERMISSION_DENIED', 'READ_IO_ERROR', 'FILESYSTEM_ERROR'].includes(code) ? 'unclassified' : 'failure');
  };

  let unsafeRoot = false;
  let parent = path.parse(root).root;
  for (const part of root.slice(parent.length).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    let itemStat;
    try { itemStat = await fsApi.lstat(parent); }
    catch (error) { addFsError('.', error); return finish(); }
    if (itemStat.isSymbolicLink()) { add('.', 'ROOT_PATH_SYMLINK', 'unclassified'); return finish(); }
    if (posixModesAvailable && (itemStat.mode & 0o022) !== 0) {
      add('.', 'WORLD_WRITABLE_RELEASE_PATH_COMPONENT');
      unsafeRoot = true;
    }
  }
  let rootStat;
  try { rootStat = await fsApi.lstat(root); }
  catch (error) { addFsError('.', error); return finish(); }
  if (rootStat.isSymbolicLink()) { add('.', 'RELEASE_ROOT_SYMLINK', 'unclassified'); return finish(); }
  if (!rootStat.isDirectory()) { add('.', 'RELEASE_ROOT_NOT_DIRECTORY'); return finish(); }
  summary.rootMode = posixModesAvailable ? (rootStat.mode & 0o777).toString(8).padStart(4, '0') : 'UNCONFIRMED_WINDOWS';
  if (!posixModesAvailable) add('.', 'POSIX_MODE_UNCONFIRMED', 'unclassified');
  else if ((rootStat.mode & 0o022) !== 0) {
    add('.', 'WORLD_WRITABLE_RELEASE_ROOT');
    unsafeRoot = true;
  }
  if (unsafeRoot) return finish();

  const manifestPath = path.join(root, 'release-manifest.json');
  let manifestStat;
  try { manifestStat = await fsApi.lstat(manifestPath); }
  catch (error) { addFsError('release-manifest.json', error); return finish(); }
  if (manifestStat.isSymbolicLink()) { add('release-manifest.json', 'MANIFEST_SYMLINK', 'unclassified'); return finish(); }
  if (!manifestStat.isFile()) { add('release-manifest.json', 'MANIFEST_NOT_REGULAR_FILE'); return finish(); }
  if (posixModesAvailable && (manifestStat.mode & 0o022) !== 0) add('release-manifest.json', 'WORLD_WRITABLE_MANIFEST');
  if (manifestStat.size > 10 * 1024 * 1024) { add('release-manifest.json', 'MANIFEST_SIZE_LIMIT_UNCONFIRMED', 'unclassified'); return finish(); }
  let manifest;
  try { manifest = JSON.parse((await fsApi.readFile(manifestPath, 'utf8'))); }
  catch (error) {
    if (error instanceof SyntaxError) add('release-manifest.json', 'MANIFEST_INVALID_JSON');
    else addFsError('release-manifest.json', error);
    return finish();
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      typeof manifest.targetSha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(manifest.targetSha) ||
      !Array.isArray(manifest.files) || manifest.files.length === 0 || !Number.isInteger(manifest.fileCount)) {
    add('release-manifest.json', 'MANIFEST_SCHEMA_UNSUPPORTED');
    return finish();
  }
  if (manifest.format !== undefined && manifest.format !== 'buhguy-runtime-manifest-v1') {
    add('release-manifest.json', 'MANIFEST_FORMAT_UNSUPPORTED', 'unclassified');
    return finish();
  }
  summary.targetSha = manifest.targetSha.toLowerCase();
  summary.total = manifest.files.length;
  if (manifest.fileCount !== manifest.files.length) add('release-manifest.json', 'FILE_COUNT_MISMATCH');
  if (expectedTargetSha && summary.targetSha !== expectedTargetSha.toLowerCase()) {
    add('release-manifest.json', 'TARGET_SHA_MISMATCH');
  }
  const rootName = path.basename(root).toLowerCase();
  if (/^[0-9a-f]{40,64}$/.test(rootName) && rootName !== summary.targetSha) {
    add('release-manifest.json', 'RELEASE_PATH_TARGET_SHA_MISMATCH');
  }

  if (manifest.files.length > 10000) {
    add('release-manifest.json', 'MANIFEST_ENTRY_LIMIT_UNCONFIRMED', 'unclassified');
    return finish();
  }
  const seenPaths = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      add('<entry>', 'MANIFEST_ENTRY_INVALID');
      continue;
    }
    const rel = entry.path;
    const classification = classifyPath(rel);
    if (classification.kind === 'sensitive') { add(rel, classification.code, 'sensitive'); continue; }
    if (classification.kind === 'unknown') { add(rel, classification.code, 'unclassified'); continue; }
    if (classification.kind === 'invalid') { add(rel, classification.code); continue; }
    const canonicalRel = rel.replaceAll('\\', '/');
    if (seenPaths.has(canonicalRel)) { add(rel, 'DUPLICATE_MANIFEST_PATH'); continue; }
    seenPaths.add(canonicalRel);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/i.test(entry.sha256 ?? '')) {
      add(rel, 'MANIFEST_ENTRY_SCHEMA_INVALID');
      continue;
    }
    const target = path.resolve(root, ...rel.replaceAll('\\', '/').split('/'));
    if (!within(root, target)) { add(rel, 'MANIFEST_PATH_ESCAPE'); continue; }

    let current = root;
    let blocked = false;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let itemStat;
      try { itemStat = await fsApi.lstat(current); }
      catch (error) { addFsError(rel, error); blocked = true; break; }
      if (itemStat.isSymbolicLink()) {
        let linkTarget;
        try { linkTarget = await fsApi.readlink(current); }
        catch (error) { addFsError(rel, error); blocked = true; break; }
        const resolvedLink = path.resolve(path.dirname(current), linkTarget);
        const escapes = !within(root, resolvedLink);
        add(rel, escapes ? 'SYMLINK_ESCAPE' : 'SYMLINK_NOT_VERIFIED', escapes ? 'failure' : 'unclassified');
        blocked = true;
        break;
      }
      if (current !== target && !itemStat.isDirectory()) {
        add(rel, 'NON_DIRECTORY_PATH_COMPONENT'); blocked = true; break;
      }
      if (posixModesAvailable && current !== target && (itemStat.mode & 0o022) !== 0) {
        add(rel, 'WORLD_WRITABLE_DIRECTORY_COMPONENT'); blocked = true; break;
      }
      if (current === target && !itemStat.isFile()) {
        add(rel, 'NOT_REGULAR_FILE'); blocked = true; break;
      }
    }
    if (blocked) continue;

    try {
      const actualStat = await fsApi.stat(target);
      if (actualStat.size !== entry.size) { add(rel, 'SIZE_MISMATCH'); continue; }
      if (actualStat.size > maxFileBytes) { add(rel, 'FILE_SIZE_LIMIT_UNCONFIRMED', 'unclassified'); continue; }
      if (entry.mode !== undefined) {
        const expectedMode = normalizeMode(entry.mode);
        if (expectedMode === null) { add(rel, 'MODE_FORMAT_UNCONFIRMED', 'unclassified'); continue; }
        if (!posixModesAvailable) add(rel, 'POSIX_MODE_UNCONFIRMED', 'unclassified');
        else if ((actualStat.mode & 0o777) !== expectedMode) { add(rel, 'MODE_MISMATCH'); continue; }
      }
      if (posixModesAvailable && (actualStat.mode & 0o022) !== 0) { add(rel, 'WORLD_WRITABLE_CODE_FILE'); continue; }
      const bytes = await fsApi.readFile(target);
      if (bytes.length !== entry.size) { add(rel, 'SIZE_MISMATCH'); continue; }
      const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== entry.sha256.toLowerCase()) { add(rel, 'SHA256_MISMATCH'); continue; }
      if (entry.gitBlobSha !== undefined && gitBlobSha(bytes) !== String(entry.gitBlobSha).toLowerCase()) {
        add(rel, 'GIT_BLOB_SHA_MISMATCH'); continue;
      }
      add(rel, 'PASS', 'verified');
    } catch (error) { addFsError(rel, error); }
  }

  return finish();
}

function report(summary) {
  console.log(JSON.stringify({
    status: summary.status,
    targetSha: summary.targetSha,
    rootMode: summary.rootMode,
    counts: { total: summary.total, verified: summary.verified, excludedSensitive: summary.excludedSensitive, unclassified: summary.unclassified, failures: summary.failures },
    entries: summary.entries,
  }));
}

async function selfTest() {
  const base = await fs.mkdtemp(path.join(process.cwd(), '.manifest-verifier-test-'));
  const expected = 'fe7a1db727c0dd4bc135cd2ed2b9043659e6964e';
  const results = {};
  const fileRel = 'bin/entry.js';
  const payload = Buffer.from('synthetic-code-only');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const blob = bytes => gitBlobSha(bytes);
  async function makeFixture({ body = payload, rel = fileRel, size, targetSha = expected, format = 'buhguy-runtime-manifest-v1' } = {}) {
    await fs.rm(base, { recursive: true, force: true });
    await fs.mkdir(path.join(base, 'bin'), { recursive: true });
    const normalizedRel = String(rel).replaceAll('\\', '/');
    const safeFixturePath = !normalizedRel.startsWith('/') && !/^[a-z]:\//i.test(normalizedRel) && !normalizedRel.split('/').includes('..');
    const fixturePath = safeFixturePath ? path.join(base, ...normalizedRel.split('/').filter(Boolean)) : path.join(base, 'bin', 'entry.js');
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await fs.writeFile(fixturePath, body);
    const st = await fs.stat(fixturePath);
    const entry = { path: rel, size: size ?? body.length, sha256: hash(body), gitBlobSha: blob(body), ...(posixModesAvailable ? { mode: (st.mode & 0o777).toString(8).padStart(4, '0') } : {}) };
    await fs.writeFile(path.join(base, 'release-manifest.json'), JSON.stringify({ ...(format ? { format } : {}), targetSha, fileCount: 1, files: [entry] }));
    return entry;
  }
  async function expect(name, summary, wanted) { results[name] = summary.status === wanted ? 'PASS' : `FAIL:${summary.status}`; }
  try {
    await makeFixture();
    const validResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected });
    await expect('valid', validResult, posixModesAvailable ? 'PASS' : 'UNCONFIRMED');
    results.validHashVerified = validResult.verified === 1 ? 'PASS' : 'FAIL';
    await makeFixture({ format: '' });
    const legacyResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected });
    results.legacyTargetShaManifest = legacyResult.verified === 1 && legacyResult.targetSha === expected && legacyResult.status === (posixModesAvailable ? 'PASS' : 'UNCONFIRMED') ? 'PASS' : 'FAIL';
    await makeFixture(); await fs.unlink(path.join(base, 'bin', 'entry.js')); await expect('missing', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected }), 'FAIL');
    await makeFixture({ size: payload.length + 1 }); await expect('sizeMismatch', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected }), 'FAIL');
    const changed = Buffer.from(payload); changed[0] ^= 1; await makeFixture({ body: changed });
    let manifest = JSON.parse(await fs.readFile(path.join(base, 'release-manifest.json'), 'utf8')); manifest.files[0].sha256 = hash(payload);
    await fs.writeFile(path.join(base, 'release-manifest.json'), JSON.stringify(manifest));
    await expect('hashMismatch', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected }), 'FAIL');
    await makeFixture({ rel: '../outside.js' });
    await expect('traversal', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected }), 'FAIL');
    await makeFixture();
    let badSchema = JSON.parse(await fs.readFile(path.join(base, 'release-manifest.json'), 'utf8'));
    badSchema.fileCount = 2;
    await fs.writeFile(path.join(base, 'release-manifest.json'), JSON.stringify(badSchema));
    await expect('schema', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected }), 'FAIL');
    await makeFixture({ format: 'unsupported' });
    await expect('unsupportedFormat', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected }), 'UNCONFIRMED');
    await makeFixture();
    await fs.writeFile(path.join(base, 'release-manifest.json'), '{');
    await expect('invalidJson', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected }), 'FAIL');
    await makeFixture();
    await fs.unlink(path.join(base, 'release-manifest.json'));
    await expect('missingManifest', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected }), 'FAIL');
    await makeFixture();
    await expect('targetShaMismatch', await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: '0'.repeat(40) }), 'FAIL');
    await makeFixture({ rel: 'state/private.json' });
    let nonManifestReads = 0;
    const sensitiveFs = { lstat: fs.lstat.bind(fs), stat: fs.stat.bind(fs), readlink: fs.readlink.bind(fs), readFile: async (p, encoding) => {
      if (!String(p).endsWith('release-manifest.json')) nonManifestReads += 1;
      return fs.readFile(p, encoding);
    } };
    const sensitiveResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected, fsApi: sensitiveFs });
    results.sensitiveExcludedWithoutHash = sensitiveResult.status === 'UNCONFIRMED' && sensitiveResult.excludedSensitive === 1 && nonManifestReads === 0 ? 'PASS' : 'FAIL';
    await makeFixture({ rel: 'src/tokenizer.js' });
    const codeNameResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected });
    results.codeNameNotOverExcluded = codeNameResult.verified === 1 && !codeNameResult.entries.some(e => e.status === 'SUSPICIOUS_NAME_NOT_READ') ? 'PASS' : 'FAIL';
    await makeFixture({ rel: 'src/api-token.js' });
    let suspiciousReads = 0;
    const suspiciousFs = { lstat: fs.lstat.bind(fs), stat: fs.stat.bind(fs), readlink: fs.readlink.bind(fs), readFile: async (p, encoding) => {
      if (!String(p).endsWith('release-manifest.json')) suspiciousReads += 1;
      return fs.readFile(p, encoding);
    } };
    const suspiciousResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected, fsApi: suspiciousFs });
    results.suspiciousNameNotRead = suspiciousResult.status === 'UNCONFIRMED' && suspiciousResult.excludedSensitive === 1 && suspiciousResult.entries.some(e => ['SUSPICIOUS_NAME_NOT_READ', 'SENSITIVE_PATH_NOT_READ'].includes(e.status)) && suspiciousReads === 0 ? 'PASS' : 'FAIL';
    await makeFixture({ rel: 'assets/unknown.dat' });
    const unknownResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected });
    results.unknownNotRead = unknownResult.status === 'UNCONFIRMED' && unknownResult.entries.some(e => e.status === 'PATH_CLASS_UNCONFIRMED') ? 'PASS' : 'FAIL';

    await makeFixture();
    const injectedPermissionFs = { lstat: fs.lstat.bind(fs), stat: fs.stat.bind(fs), readlink: fs.readlink.bind(fs), readFile: async (p, encoding) => String(p).endsWith(path.join('bin', 'entry.js')) ? Promise.reject(Object.assign(new Error(), { code: 'EACCES' })) : fs.readFile(p, encoding) };
    const permissionResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected, fsApi: injectedPermissionFs });
    results.permissionInjected = permissionResult.entries.some(e => e.status === 'PERMISSION_DENIED') ? 'PASS' : 'FAIL';
    const injectedIoFs = { lstat: fs.lstat.bind(fs), stat: fs.stat.bind(fs), readlink: fs.readlink.bind(fs), readFile: async (p, encoding) => String(p).endsWith(path.join('bin', 'entry.js')) ? Promise.reject(Object.assign(new Error(), { code: 'EIO' })) : fs.readFile(p, encoding) };
    const ioResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected, fsApi: injectedIoFs });
    results.executionErrorInjected = ioResult.entries.some(e => e.status === 'READ_IO_ERROR') ? 'PASS' : 'FAIL';

    await makeFixture();
    const cli = spawnSync(process.execPath, [fileURLToPath(import.meta.url), base, expected], { encoding: 'utf8', timeout: 5000 });
    let cliResult;
    try { cliResult = JSON.parse(cli.stdout); } catch { cliResult = null; }
    const expectedCliStatus = posixModesAvailable ? 'PASS' : 'UNCONFIRMED';
    const expectedCliExit = posixModesAvailable ? 0 : 2;
    results.cliInvocation = cli.status === expectedCliExit && cliResult?.status === expectedCliStatus ? 'PASS' : 'FAIL';
    const sourceForStdin = await fs.readFile(fileURLToPath(import.meta.url), 'utf8');
    const stdinCli = spawnSync(process.execPath, ['--input-type=module', '-', base, expected], { input: sourceForStdin, encoding: 'utf8', timeout: 5000 });
    let stdinCliResult;
    try { stdinCliResult = JSON.parse(stdinCli.stdout); } catch { stdinCliResult = null; }
    results.stdinInvocation = stdinCli.status === expectedCliExit && stdinCliResult?.status === expectedCliStatus ? 'PASS' : 'FAIL';
    await makeFixture();
    const cliFailure = spawnSync(process.execPath, [fileURLToPath(import.meta.url), base, '0'.repeat(40)], { encoding: 'utf8', timeout: 5000 });
    let cliFailureResult;
    try { cliFailureResult = JSON.parse(cliFailure.stdout); } catch { cliFailureResult = null; }
    results.cliFailExitCode = cliFailure.status === 1 && cliFailureResult?.status === 'FAIL' ? 'PASS' : 'FAIL';
    await makeFixture({ rel: 'assets/unknown.dat' });
    const cliUnconfirmed = spawnSync(process.execPath, [fileURLToPath(import.meta.url), base, expected], { encoding: 'utf8', timeout: 5000 });
    let cliUnconfirmedResult;
    try { cliUnconfirmedResult = JSON.parse(cliUnconfirmed.stdout); } catch { cliUnconfirmedResult = null; }
    results.cliUnconfirmedExitCode = cliUnconfirmed.status === 2 && cliUnconfirmedResult?.status === 'UNCONFIRMED' ? 'PASS' : 'FAIL';
    const cliUsage = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 5000 });
    results.cliUsageExitCode = cliUsage.status === 2 ? 'PASS' : 'FAIL';

    await makeFixture();
    const linkPath = path.join(base, 'bin', 'entry.js');
    try {
      await fs.unlink(linkPath);
      await fs.symlink(path.join(path.dirname(base), 'outside-synthetic.js'), linkPath);
      results.symlinkEscape = (await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected })).entries.some(e => e.status === 'SYMLINK_ESCAPE') ? 'PASS_OS' : 'FAIL_OS';
    } catch (error) {
      const mockFs = {
        lstat: async p => String(p) === linkPath ? { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false } : fs.lstat(p),
        stat: fs.stat.bind(fs), readFile: fs.readFile.bind(fs),
        readlink: async p => String(p) === linkPath ? path.join(path.dirname(base), 'outside-synthetic.js') : fs.readlink(p),
      };
      const symlinkResult = await verifyReleaseManifest({ releaseRoot: base, expectedTargetSha: expected, fsApi: mockFs });
      results.symlinkEscape = symlinkResult.entries.some(e => e.status === 'SYMLINK_ESCAPE') ? `PASS_INJECTED_OS_NOT_RUN_${error.code ?? 'UNAVAILABLE'}` : 'FAIL_INJECTED';
    }
    results.harnessExceptions = Object.values(results).every(v => v.startsWith('PASS')) ? 'PASS' : 'FAIL';
    console.log(JSON.stringify({ tests: results, overall: Object.values(results).every(v => v.startsWith('PASS')) ? 'PASS' : 'FAIL', realSymlinkOsTest: results.symlinkEscape?.startsWith('PASS_OS') ? 'PASS' : 'NOT_RUN_IF_INJECTED' }));
    if (Object.values(results).some(v => !v.startsWith('PASS'))) process.exitCode = 1;
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] === '-' || (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url);
if (invoked) {
  try {
    if (process.argv[2] === '--self-test') await selfTest();
    else if (process.argv.length === 4) {
      const result = await verifyReleaseManifest({ releaseRoot: process.argv[2], expectedTargetSha: process.argv[3] });
      report(result);
      process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 2;
    }
    else {
      console.error('Usage: node verify-release-manifest-readonly.mjs --self-test | <release-root> <expected-target-sha>');
      process.exitCode = 2;
    }
  } catch {
    console.log(JSON.stringify({ status: 'FAIL', error: 'VERIFIER_INTERNAL_ERROR' }));
    process.exitCode = 1;
  }
}

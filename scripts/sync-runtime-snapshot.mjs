#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';

const FORMAT = 'buhguy-sync-code-snapshot-v1';
const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const PACKAGE_METADATA = new Set(['package.json', 'package-lock.json', '.package-lock.json']);
const SENSITIVE_SEGMENT = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|cookie|cookies|auth|session|sessions|profile|profiles|state|backup|backups|dump|dumps|log|logs)([._-]|$)/i;
const SENSITIVE_DIRECTORY = new Set([
  '.receipt-collector', '.browser', 'browser-profile', 'profiles', 'sessions', 'state',
  'secrets', 'credentials', 'tokens', 'logs', 'backups', 'dumps', 'financial-data',
  'receipt-data', 'bank-data', '.cache', '.local-browsers', 'ms-playwright',
]);
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const INSPECT_LIMITATIONS = Object.freeze([
  'STATIC_IMPORTS_ONLY',
  'RUNTIME_LOADED_FILES_NOT_DISCOVERED',
  'PLUGINS_NOT_DISCOVERED',
  'NATIVE_MODULES_NOT_DISCOVERED',
  'CHILD_PROCESSES_NOT_DISCOVERED',
  'FULL_RUNTIME_CLOSURE_REQUIRES_SEPARATE_EVIDENCE',
]);

export class SnapshotError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) { throw new SnapshotError(code); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonicalJson(value) { return JSON.stringify(value); }
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function normalizeRelative(raw, { allowExtensionless = false } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) fail('PATH_INVALID');
  const value = raw.replaceAll('\\', '/');
  if (value.startsWith('/') || value.startsWith('//') || /^[a-z]:/i.test(value)) fail('PATH_ABSOLUTE');
  const segments = value.split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) fail('PATH_TRAVERSAL_OR_NONCANONICAL');
  const lower = segments.map(part => part.toLowerCase());
  if (lower.some(part => SENSITIVE_DIRECTORY.has(part) || part.startsWith('.env') || SENSITIVE_SEGMENT.test(part))) fail('SENSITIVE_PATH_NOT_READ');
  const base = lower.at(-1);
  const extension = path.posix.extname(base);
  if (base.startsWith('.env.') || base === '.env') fail('SENSITIVE_PATH_NOT_READ');
  if (!ALLOWED_EXTENSIONS.has(extension) && !PACKAGE_METADATA.has(base)) {
    if (!extension && allowExtensionless) return segments.join('/');
    fail('PATH_CLASS_UNCONFIRMED');
  }
  return segments.join('/');
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '/' && source[i + 1] === '/') { i += 2; while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) fail('SOURCE_LEXICAL_ERROR');
      i = end + 2;
      continue;
    }
    if (ch === '/') {
      const previous = tokens.at(-1);
      const regexAfterKeyword = new Set(['return', 'throw', 'case', 'delete', 'typeof', 'void', 'instanceof', 'in', 'of', 'yield', 'await']);
      const regexMayStart = !previous ||
        (previous.type === 'punct' && ['(', '{', '[', ',', ';', ':', '=', '!', '?', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>'].includes(previous.value)) ||
        (previous.type === 'id' && regexAfterKeyword.has(previous.value));
      if (regexMayStart) {
        i += 1;
        let inClass = false;
        let closed = false;
        while (i < source.length && source[i] !== '\n' && source[i] !== '\r') {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') inClass = true;
          else if (source[i] === ']') inClass = false;
          else if (source[i] === '/' && !inClass) { i += 1; closed = true; break; }
          i += 1;
        }
        if (!closed) fail('SOURCE_LEXICAL_ERROR');
        while (i < source.length && /[A-Za-z]/.test(source[i])) i += 1;
        tokens.push({ type: 'regex', value: null });
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = ++i;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          if (i + 1 >= source.length) fail('SOURCE_LEXICAL_ERROR');
          value += source.slice(i, i + 2);
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (source[i] !== quote) fail('SOURCE_LEXICAL_ERROR');
      tokens.push({ type: 'string', value, escaped: source.slice(start, i).includes('\\') });
      i += 1;
      continue;
    }
    if (ch === '`') {
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') fail('TEMPLATE_EXPRESSION_UNSUPPORTED');
        if (source[i] === '`') { i += 1; closed = true; break; }
        i += 1;
      }
      if (!closed) fail('SOURCE_LEXICAL_ERROR');
      tokens.push({ type: 'template', value: null });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      tokens.push({ type: 'id', value: source.slice(start, i) });
      continue;
    }
    tokens.push({ type: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

function staticImports(source) {
  const tokens = tokenize(source);
  const result = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'id') continue;
    if (token.value === 'eval' && tokens[i + 1]?.value === '(') fail('DYNAMIC_CODE_UNSUPPORTED');
    if (token.value === 'createRequire') fail('DYNAMIC_REQUIRE_UNSUPPORTED');
    if (token.value === 'import') {
      if (tokens[i + 1]?.value === '.') continue;
      if (tokens[i + 1]?.value === '(') {
        const specifier = tokens[i + 2];
        if (specifier?.type !== 'string' || specifier.escaped || tokens[i + 3]?.value !== ')') fail('DYNAMIC_IMPORT_UNSUPPORTED');
        result.push({ specifier: specifier.value, kind: 'import' });
      } else if (tokens[i + 1]?.type === 'string') {
        if (tokens[i + 1].escaped) fail('IMPORT_SPECIFIER_ESCAPE_UNSUPPORTED');
        result.push({ specifier: tokens[i + 1].value, kind: 'import' });
      } else {
        let found = false;
        for (let j = i + 1; j < tokens.length && tokens[j].value !== ';'; j += 1) {
          if (tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
            if (tokens[j + 1].escaped) fail('IMPORT_SPECIFIER_ESCAPE_UNSUPPORTED');
            result.push({ specifier: tokens[j + 1].value, kind: 'import' });
            found = true;
            break;
          }
        }
        if (!found) fail('IMPORT_SYNTAX_UNCONFIRMED');
      }
    }
    if (token.value === 'export') {
      for (let j = i + 1; j < tokens.length && tokens[j].value !== ';'; j += 1) {
        if (tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
          if (tokens[j + 1].escaped) fail('IMPORT_SPECIFIER_ESCAPE_UNSUPPORTED');
          result.push({ specifier: tokens[j + 1].value, kind: 'import' });
          break;
        }
      }
    }
    if (token.value === 'require' && tokens[i - 1]?.value !== '.' && tokens[i + 1]?.value === '(') {
      const specifier = tokens[i + 2];
      if (specifier?.type !== 'string' || specifier.escaped || tokens[i + 3]?.value !== ')') fail('DYNAMIC_REQUIRE_UNSUPPORTED');
      result.push({ specifier: specifier.value, kind: 'require' });
    }
  }
  return result;
}

async function lstatRegularPath(root, relative, fsApi) {
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!isInside(root, absolute)) fail('PATH_ESCAPE');
  const parsed = path.parse(root);
  let rootPart = parsed.root;
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    rootPart = path.join(rootPart, part);
    const component = await fsApi.lstat(rootPart);
    if (component.isSymbolicLink()) fail('SOURCE_ROOT_PATH_SYMLINK');
    if (rootPart !== root && !component.isDirectory()) fail('SOURCE_ROOT_PATH_NOT_DIRECTORY');
  }
  const rootStat = await fsApi.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('SOURCE_ROOT_NOT_REAL_DIRECTORY');
  let current = root;
  let stat;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    stat = await fsApi.lstat(current);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED');
    if (index < parts.length - 1 && !stat.isDirectory()) fail('PATH_COMPONENT_NOT_DIRECTORY');
    if (index === parts.length - 1 && !stat.isFile()) fail('FILE_NOT_REGULAR');
  }
  if (stat.nlink > 1) fail('HARDLINK_NOT_ALLOWED');
  return { absolute, stat };
}

function packageNameAndSubpath(specifier) {
  if (specifier.startsWith('#')) fail('PACKAGE_IMPORTS_UNSUPPORTED');
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (parts.length < 2) fail('PACKAGE_SPECIFIER_INVALID');
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.' };
  }
  return { name: parts[0], subpath: parts.length > 1 ? `./${parts.slice(1).join('/')}` : '.' };
}

function selectExportTarget(exportsField, subpath, kind) {
  let selected = exportsField;
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const keys = Object.keys(exportsField);
    if (keys.some(key => key.startsWith('.'))) {
      if (keys.some(key => !key.startsWith('.') || key.includes('*'))) fail('PACKAGE_EXPORT_UNSUPPORTED');
      if (!Object.hasOwn(exportsField, subpath)) fail('PACKAGE_EXPORT_UNRESOLVED');
      selected = exportsField[subpath];
    } else if (subpath !== '.') fail('PACKAGE_EXPORT_UNRESOLVED');
  } else if (subpath !== '.') fail('PACKAGE_EXPORT_UNRESOLVED');
  const resolveTarget = target => {
    if (typeof target === 'string') {
      if (!target.startsWith('./') || target.includes('\\') || target.includes('%') || target.includes('*') ||
          target.slice(2).split('/').some(part => !part || part === '.' || part === '..' || part === 'node_modules')) fail('PACKAGE_EXPORT_UNSUPPORTED');
      return target;
    }
    if (target === null) return null;
    if (!target || typeof target !== 'object' || Array.isArray(target)) fail('PACKAGE_EXPORT_UNSUPPORTED');
    const keys = Object.keys(target);
    // Do not guess custom/addon/module-sync conditions or array fallback semantics.
    if (keys.some(key => !['node', 'import', 'require', 'default'].includes(key))) fail('PACKAGE_EXPORT_UNSUPPORTED');
    for (const key of keys) {
      if (key !== 'node' && key !== kind && key !== 'default') continue;
      const resolved = resolveTarget(target[key]);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  };
  const target = resolveTarget(selected);
  if (typeof target !== 'string') fail('PACKAGE_EXPORT_UNRESOLVED');
  return target;
}

async function lstatDirectoryPath(root, relative, fsApi) {
  const rel = normalizeRelative(relative, { allowExtensionless: true });
  const absolute = path.resolve(root, ...rel.split('/'));
  if (!isInside(root, absolute)) fail('PATH_ESCAPE');
  let current = root;
  const rootStat = await fsApi.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('SOURCE_ROOT_NOT_REAL_DIRECTORY');
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    const stat = await fsApi.lstat(current);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED');
    if (!stat.isDirectory()) fail('PATH_COMPONENT_NOT_DIRECTORY');
  }
  return { absolute, stat: await fsApi.lstat(absolute) };
}

async function resolveFile(root, baseRelative, fsApi, { allowDirectory = false, readJson = null, exact = false } = {}) {
  const candidates = exact ? [baseRelative] : [baseRelative, ...['.js', '.mjs', '.cjs'].map(extension => `${baseRelative}${extension}`)];
  const hasExplicitExtension = path.posix.extname(baseRelative) !== '';
  for (const candidate of candidates) {
    try {
      const rel = normalizeRelative(candidate);
      const { stat } = await lstatRegularPath(root, rel, fsApi);
      return rel;
    } catch (error) {
      const extensionFallback = !hasExplicitExtension && error instanceof SnapshotError && error.code === 'PATH_CLASS_UNCONFIRMED';
      if (error?.code !== 'ENOENT' && !extensionFallback) throw error;
    }
  }
  if (allowDirectory) {
    try {
      const directory = await lstatDirectoryPath(root, baseRelative, fsApi);
      if (directory.stat.isDirectory()) {
        const packageJsonPath = `${baseRelative}/package.json`;
        let packageJson;
        try { packageJson = await readJson(packageJsonPath); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (packageJson?.main) {
          const mainPath = path.posix.normalize(path.posix.join(baseRelative, packageJson.main));
          return resolveFile(root, mainPath, fsApi, { readJson });
        }
        for (const extension of ['index.js', 'index.mjs', 'index.cjs']) {
          try { return await resolveFile(root, `${baseRelative}/${extension}`, fsApi, { readJson }); }
          catch (error) { if (!(error instanceof SnapshotError) || error.code !== 'DEPENDENCY_MISSING') throw error; }
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SnapshotError && ['PATH_CLASS_UNCONFIRMED', 'PATH_COMPONENT_NOT_DIRECTORY'].includes(error.code))) throw error;
    }
  }
  fail('DEPENDENCY_MISSING');
}

async function findPackageRoot(root, fromRelative, packageName, fsApi) {
  let parent = path.posix.dirname(fromRelative);
  for (;;) {
    const candidate = path.posix.join(parent === '.' ? '' : parent, 'node_modules', packageName);
    const absolute = path.resolve(root, ...candidate.split('/'));
    if (!isInside(root, absolute)) fail('PATH_ESCAPE');
    try {
      const stat = await fsApi.lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('PACKAGE_PATH_NOT_REAL_DIRECTORY');
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (parent === '.') break;
    const next = path.posix.dirname(parent);
    parent = next === parent ? '.' : next;
  }
  fail('DEPENDENCY_MISSING');
}

function ownerPackageJsonPath(importer) {
  const parts = path.posix.dirname(importer).split('/').filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] !== 'node_modules' || !parts[index + 1]) continue;
    const end = parts[index + 1].startsWith('@') ? index + 3 : index + 2;
    if (!parts[end - 1]) continue;
    return `${parts.slice(0, end).join('/')}/package.json`;
  }
  return 'package.json';
}

function optionalDependencyDeclared(packageJson, name) {
  return Object.hasOwn(packageJson.optionalDependencies ?? {}, name) || packageJson.peerDependenciesMeta?.[name]?.optional === true;
}

async function resolveImport(root, importer, specifier, kind, fsApi, readJson) {
  if (BUILTINS.has(specifier)) return null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const raw = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    return resolveFile(root, raw, fsApi, { allowDirectory: kind === 'require', readJson });
  }
  if (specifier.startsWith('/') || /^[a-z]:/i.test(specifier) || specifier.includes('\\')) fail('IMPORT_PATH_UNSUPPORTED');
  const { name, subpath } = packageNameAndSubpath(specifier);
  let packageRoot;
  try { packageRoot = await findPackageRoot(root, importer, name, fsApi); }
  catch (error) {
    if (!(error instanceof SnapshotError) || error.code !== 'DEPENDENCY_MISSING') throw error;
    const ownerJson = await readJson(ownerPackageJsonPath(importer));
    if (optionalDependencyDeclared(ownerJson, name)) return { optionalMissing: name, declaredBy: ownerPackageJsonPath(importer) };
    throw error;
  }
  const packageJsonRel = `${packageRoot}/package.json`;
  const packageJson = await readJson(packageJsonRel);
  let target;
  const usesExports = packageJson.exports !== undefined;
  if (usesExports) target = selectExportTarget(packageJson.exports, subpath, kind);
  else if (subpath !== '.') target = subpath;
  else target = packageJson.main ?? 'index.js';
  if (!usesExports && !target.startsWith('./')) target = `./${target}`;
  if (typeof target !== 'string' || !target.startsWith('./') && !target.startsWith('/')) {
    if (target === 'index.js') target = `./${target}`;
    else fail('PACKAGE_ENTRY_UNRESOLVED');
  }
  if (target.startsWith('/')) fail('PACKAGE_EXPORT_ESCAPE');
  const rel = path.posix.normalize(path.posix.join(packageRoot, target));
  if (!isInside(path.resolve(root, packageRoot), path.resolve(root, ...rel.split('/')))) fail('PACKAGE_EXPORT_ESCAPE');
  return resolveFile(root, rel, fsApi, { allowDirectory: !usesExports && kind === 'require', readJson, exact: usesExports });
}

async function inspectClosure({ sourceRoot, entrypoint, fsApi = fs }) {
  const root = path.resolve(sourceRoot);
  const entry = normalizeRelative(entrypoint);
  const visited = new Map();
  const edges = [];
  const optionalMissing = new Set();
  const jsonCache = new Map();
  const readFile = async relative => {
    const rel = normalizeRelative(relative);
    const { absolute, stat: before } = await lstatRegularPath(root, rel, fsApi);
    const ext = path.posix.extname(rel).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && path.posix.basename(rel) !== 'package.json') fail('PATH_CLASS_UNCONFIRMED');
    const bytes = await fsApi.readFile(absolute);
    const after = await fsApi.lstat(absolute);
    if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode || bytes.length !== before.size) fail('SOURCE_CHANGED_DURING_READ');
    const mode = before.mode & 0o777;
    if ((mode & 0o022) !== 0) {
      // World-writable historical source is fingerprinted, never trusted as a commit identity.
    }
    return { rel, absolute, bytes, mode };
  };
  const readJson = async relative => {
    const rel = normalizeRelative(relative);
    if (jsonCache.has(rel)) return jsonCache.get(rel);
    if (path.posix.basename(rel) !== 'package.json') fail('PACKAGE_METADATA_PATH_INVALID');
    const file = await readFile(rel);
    let parsed;
    try { parsed = JSON.parse(file.bytes.toString('utf8')); } catch { fail('PACKAGE_METADATA_INVALID'); }
    jsonCache.set(rel, parsed);
    visited.set(rel, file);
    return parsed;
  };
  const queue = [entry];
  while (queue.length) {
    if (visited.size >= MAX_FILES) fail('FILE_LIMIT_EXCEEDED');
    const relative = queue.shift();
    if (visited.has(relative)) continue;
    const file = await readFile(relative);
    visited.set(relative, file);
    if (visited.size > MAX_FILES) fail('FILE_LIMIT_EXCEEDED');
    if (ALLOWED_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) {
      const imports = staticImports(file.bytes.toString('utf8'));
      for (const item of imports) {
        const resolved = await resolveImport(root, relative, item.specifier, item.kind, fsApi, readJson);
        if (typeof resolved === 'string') {
          edges.push({ from: relative, to: resolved, kind: item.kind });
          if (!visited.has(resolved)) queue.push(resolved);
        } else if (resolved?.optionalMissing) {
          optionalMissing.add(resolved.optionalMissing);
          edges.push({ from: relative, optionalMissing: resolved.optionalMissing, declaredBy: resolved.declaredBy, kind: item.kind });
        }
      }
    }
  }

  for (const metadata of ['package.json', 'package-lock.json']) {
    try {
      const { absolute, stat } = await lstatRegularPath(root, metadata, fsApi);
      if (stat.size > MAX_BYTES) fail('FILE_SIZE_LIMIT_EXCEEDED');
      const bytes = await fsApi.readFile(absolute);
      const after = await fsApi.lstat(absolute);
      if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) fail('SOURCE_CHANGED_DURING_READ');
      visited.set(metadata, { rel: metadata, absolute, bytes, mode: stat.mode & 0o777 });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const files = [...visited.values()].sort((a, b) => a.rel.localeCompare(b.rel, 'en'));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (totalBytes > MAX_BYTES) fail('TOTAL_SIZE_LIMIT_EXCEEDED');
  return { root, entrypoint: entry, files, edges, optionalMissing: [...optionalMissing].sort(), totalBytes };
}

async function recheckSources(closure, fsApi) {
  for (const file of closure.files) {
    const current = await lstatRegularPath(closure.root, file.rel, fsApi);
    if (current.stat.size !== file.bytes.length || (current.stat.mode & 0o777) !== file.mode) fail('SOURCE_CHANGED_BEFORE_PUBLISH');
    const bytes = await fsApi.readFile(current.absolute);
    const after = await fsApi.lstat(current.absolute);
    if (after.isSymbolicLink() || current.stat.dev !== after.dev || current.stat.ino !== after.ino || current.stat.size !== after.size || current.stat.mtimeMs !== after.mtimeMs || current.stat.ctimeMs !== after.ctimeMs || current.stat.mode !== after.mode || !crypto.timingSafeEqual(crypto.createHash('sha256').update(bytes).digest(), crypto.createHash('sha256').update(file.bytes).digest())) fail('SOURCE_CHANGED_BEFORE_PUBLISH');
  }
}

function snapshotFileRecords(files, entrypoint) {
  return files.map(file => ({
    path: file.rel,
    size: file.bytes.length,
    sha256: sha256(file.bytes),
    sourceMode: file.mode.toString(8).padStart(4, '0'),
    mode: (file.mode & 0o111 ? 0o755 : 0o644).toString(8).padStart(4, '0'),
    role: file.rel === entrypoint ? 'entrypoint' : path.posix.basename(file.rel) === 'package.json' || path.posix.basename(file.rel) === 'package-lock.json' ? 'package-metadata' : 'static-import-closure',
  }));
}

function fingerprintFor(files) {
  return sha256(Buffer.from(canonicalJson(files.map(({ path: rel, size, sha256: hash, sourceMode, mode, role }) => ({ path: rel, size, sha256: hash, sourceMode, mode, role })))));
}

function safeInspectStopCode(error) {
  if (error instanceof SnapshotError) return error.code;
  if (error?.code === 'ENOENT') return 'SOURCE_PATH_NOT_FOUND';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'SOURCE_ACCESS_DENIED';
  if (error?.code === 'ELOOP') return 'SYMLINK_NOT_ALLOWED';
  if (error?.code === 'ENOTDIR') return 'PATH_COMPONENT_NOT_DIRECTORY';
  if (error?.code === 'EIO') return 'SOURCE_IO_ERROR';
  return 'INSPECT_INTERNAL_ERROR';
}

function inspectStopReport(code) {
  return {
    status: 'STOP',
    staticClosure: 'STOP',
    fullRuntimeClosure: 'UNCONFIRMED',
    stableReadPasses: 0,
    fileCount: null,
    totalBytes: null,
    fingerprint: null,
    optionalDependencyCount: null,
    moduleEdgeCount: null,
    limitations: [...INSPECT_LIMITATIONS],
    stopCodes: [code],
  };
}

export async function inspectRuntimeClosure({ sourceRoot, entrypoint, fsApi = fs }) {
  const closure = await inspectClosure({ sourceRoot, entrypoint, fsApi });
  await recheckSources(closure, fsApi);
  const records = snapshotFileRecords(closure.files, closure.entrypoint);
  return {
    status: 'PASS',
    staticClosure: 'PASS',
    fullRuntimeClosure: 'UNCONFIRMED',
    stableReadPasses: 2,
    fileCount: records.length,
    totalBytes: closure.totalBytes,
    fingerprint: fingerprintFor(records),
    optionalDependencyCount: closure.optionalMissing.length,
    moduleEdgeCount: closure.edges.length,
    limitations: [...INSPECT_LIMITATIONS],
    stopCodes: [],
  };
}

async function ensureRealPrivateParent(parent, fsApi) {
  const absolute = path.resolve(parent);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fsApi.lstat(current);
    if (stat.isSymbolicLink()) fail('DESTINATION_PARENT_SYMLINK');
    if (!stat.isDirectory()) fail('DESTINATION_PARENT_NOT_DIRECTORY');
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
      const stickyProtectedAncestor = current !== absolute && (stat.mode & 0o1000) !== 0;
      if (!stickyProtectedAncestor) fail('DESTINATION_PARENT_WRITABLE_BY_OTHERS');
    }
  }
  return absolute;
}

async function availableBytes(parent, fsApi) {
  if (typeof fsApi.statfs !== 'function') fail('FILESYSTEM_CAPACITY_UNAVAILABLE');
  const stat = await fsApi.statfs(parent);
  const inodes = Number(stat.ffree);
  if (!Number.isSafeInteger(inodes) || inodes < 0) fail('FILESYSTEM_INODE_DATA_UNAVAILABLE');
  return { bytes: Number(stat.bavail) * Number(stat.bsize), inodes, blockSize: Number(stat.bsize) };
}

function estimateAllocation(records, manifestBytes, blockSize) {
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) fail('FILESYSTEM_BLOCK_SIZE_UNAVAILABLE');
  let dataBlocks = records.reduce((sum, record) => sum + Math.ceil(record.size / blockSize), 0);
  dataBlocks += Math.ceil(manifestBytes / blockSize);
  const directories = new Set(['.']);
  for (const record of records) {
    const parts = record.path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      directories.add(current);
    }
  }
  const estimatedInodes = records.length + 1 + directories.size + 1;
  const allocatedBytes = (dataBlocks + directories.size * 2 + 1) * blockSize;
  return { allocatedBytes, estimatedInodes };
}

async function writeSnapshotTree(tempRoot, records, filesByPath, manifest, fsApi) {
  for (const record of records) {
    const destination = path.join(tempRoot, ...record.path.split('/'));
    await fsApi.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await fsApi.writeFile(destination, filesByPath.get(record.path).bytes, { flag: 'wx', mode: Number.parseInt(record.mode, 8) });
    await fsApi.chmod(destination, Number.parseInt(record.mode, 8));
  }
  const manifestPath = path.join(tempRoot, 'sync-snapshot-manifest.json');
  await fsApi.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  await fsApi.chmod(manifestPath, 0o644);
}

async function walkFiles(root, fsApi, rel = '') {
  const absolute = rel ? path.join(root, ...rel.split('/')) : root;
  const entries = await fsApi.readdir(absolute, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childPath = path.join(absolute, entry.name);
    const stat = await fsApi.lstat(childPath);
    if (stat.isSymbolicLink()) fail('SNAPSHOT_SYMLINK_PRESENT');
    if (stat.isDirectory()) {
      if ((stat.mode & 0o022) !== 0) fail('SNAPSHOT_DIRECTORY_MODE_UNSAFE');
      output.push(...await walkFiles(root, fsApi, childRel));
    } else if (stat.isFile()) {
      if ((stat.mode & 0o022) !== 0) fail('SNAPSHOT_FILE_MODE_UNSAFE');
      output.push(childRel);
    } else fail('SNAPSHOT_SPECIAL_FILE_PRESENT');
  }
  return output;
}

export async function verifySnapshot({ snapshotRoot, fsApi = fs, operationId = null }) {
  const root = path.resolve(snapshotRoot);
  const rootStat = await fsApi.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (process.platform !== 'win32' && (rootStat.mode & 0o022) !== 0)) fail('SNAPSHOT_ROOT_UNSAFE');
  const manifestPath = path.join(root, 'sync-snapshot-manifest.json');
  const manifestStat = await fsApi.lstat(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || (process.platform !== 'win32' && (manifestStat.mode & 0o022) !== 0)) fail('SNAPSHOT_MANIFEST_UNSAFE');
  let manifest;
  try { manifest = JSON.parse(await fsApi.readFile(manifestPath, 'utf8')); } catch { fail('SNAPSHOT_MANIFEST_INVALID'); }
  if (!manifest || manifest.format !== FORMAT || typeof manifest.entrypoint !== 'string' || !Array.isArray(manifest.files) || !Array.isArray(manifest.moduleEdges) || !Array.isArray(manifest.optionalDependenciesMissing) || !/^[0-9a-f]{64}$/.test(manifest.fingerprint ?? '')) fail('SNAPSHOT_MANIFEST_SCHEMA_INVALID');
  const seen = new Set();
  for (const record of manifest.files) {
    if (!record || typeof record.path !== 'string' || !Number.isSafeInteger(record.size) || record.size < 0 || !/^[0-9a-f]{64}$/.test(record.sha256 ?? '') || !['0644', '0755'].includes(record.mode)) fail('SNAPSHOT_RECORD_INVALID');
    const relative = normalizeRelative(record.path);
    if (seen.has(relative)) fail('SNAPSHOT_DUPLICATE_PATH');
    seen.add(relative);
    const target = path.resolve(root, ...relative.split('/'));
    if (!isInside(root, target)) fail('SNAPSHOT_PATH_ESCAPE');
    let inspected;
    try { inspected = await lstatRegularPath(root, relative, fsApi); }
    catch (error) {
      if (error instanceof SnapshotError && error.code === 'SYMLINK_NOT_ALLOWED') fail('SNAPSHOT_SYMLINK_PRESENT');
      if (error?.code === 'ENOENT') fail('SNAPSHOT_FILE_MISSING_OR_LINK');
      throw error;
    }
    const { stat } = inspected;
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== Number.parseInt(record.mode, 8)) fail('SNAPSHOT_MODE_MISMATCH');
    const bytes = await fsApi.readFile(inspected.absolute);
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) fail('SNAPSHOT_CONTENT_MISMATCH');
  }
  if (!seen.has(manifest.entrypoint)) fail('SNAPSHOT_ENTRYPOINT_MISSING');
  const closure = await inspectClosure({ sourceRoot: root, entrypoint: manifest.entrypoint, fsApi });
  const closurePaths = closure.files.map(file => file.rel).sort((a, b) => a.localeCompare(b, 'en'));
  if (closurePaths.join('\n') !== [...seen].sort((a, b) => a.localeCompare(b, 'en')).join('\n')) fail('SNAPSHOT_CLOSURE_MISMATCH');
  if (canonicalJson(closure.optionalMissing) !== canonicalJson(manifest.optionalDependenciesMissing)) fail('SNAPSHOT_OPTIONAL_DEPENDENCY_MISMATCH');
  if (canonicalJson(closure.edges) !== canonicalJson(manifest.moduleEdges)) fail('SNAPSHOT_MODULE_GRAPH_MISMATCH');
  const actual = await walkFiles(root, fsApi);
  const markerRel = '.snapshot-operation-id';
  if (actual.includes(markerRel)) {
    if (!operationId || await fsApi.readFile(path.join(root, markerRel), 'utf8') !== operationId) fail('SNAPSHOT_OPERATION_MARKER_INVALID');
  } else if (operationId) fail('SNAPSHOT_OPERATION_MARKER_MISSING');
  const expected = [...seen, 'sync-snapshot-manifest.json', ...(operationId ? [markerRel] : [])].sort();
  if (actual.sort().join('\n') !== expected.join('\n')) fail('SNAPSHOT_UNEXPECTED_FILE');
  if (fingerprintFor(manifest.files) !== manifest.fingerprint) fail('SNAPSHOT_FINGERPRINT_MISMATCH');
  return { status: process.platform === 'win32' ? 'UNCONFIRMED' : 'PASS', posixModesVerified: process.platform !== 'win32', fingerprint: manifest.fingerprint, fileCount: manifest.files.length, totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), entrypoint: manifest.entrypoint, gitCommit: null };
}

export async function createSnapshot({ sourceRoot, entrypoint, destinationParent, minimumFreeBytes, minimumFreeInodes, quiesced, fsApi = fs, hooks = {} }) {
  if (process.platform === 'win32') fail('POSIX_RUNTIME_REQUIRED');
  if (quiesced !== true) fail('SYNC_QUIESCENCE_REQUIRED');
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) fail('POSITIVE_RESERVE_REQUIRED');
  if (!Number.isSafeInteger(minimumFreeInodes) || minimumFreeInodes <= 0) fail('POSITIVE_INODE_RESERVE_REQUIRED');
  const parent = await ensureRealPrivateParent(destinationParent, fsApi);
  if ((await fsApi.readdir(parent)).some(name => name.startsWith('.sync-rollback-tmp-'))) fail('STALE_OR_ACTIVE_TEMP_PRESENT');
  const closure = await inspectClosure({ sourceRoot, entrypoint, fsApi });
  await hooks.afterInitialRead?.(closure);
  await recheckSources(closure, fsApi);
  const records = snapshotFileRecords(closure.files, closure.entrypoint);
  const fingerprint = fingerprintFor(records);
  const sourceRootMode = ((await fsApi.lstat(closure.root)).mode & 0o777).toString(8).padStart(4, '0');
  const manifest = {
    format: FORMAT,
    identity: 'code-only fingerprint of mutable runtime; not a Git commit or historical provenance claim',
    gitCommit: null,
    entrypoint: closure.entrypoint,
    fingerprint,
    fileCount: records.length,
    totalBytes: closure.totalBytes,
    sourceRootMode,
    closureMethod: 'static ESM/CommonJS import closure; dynamic or unresolved imports fail closed',
    optionalDependenciesMissing: closure.optionalMissing,
    moduleEdges: closure.edges,
    files: records,
  };
  const capacity = await availableBytes(parent, fsApi);
  const manifestBytesEstimate = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`);
  const allocation = estimateAllocation(records, manifestBytesEstimate, capacity.blockSize);
  if (capacity.bytes < allocation.allocatedBytes + minimumFreeBytes) fail('DISK_RESERVE_INSUFFICIENT');
  if (capacity.inodes < allocation.estimatedInodes + minimumFreeInodes) fail('INODE_RESERVE_INSUFFICIENT');
  const finalRoot = path.join(parent, `sync-rollback-${fingerprint.slice(0, 16)}`);
  try { await fsApi.lstat(finalRoot); fail('SNAPSHOT_DESTINATION_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporaryRoot = path.join(parent, `.sync-rollback-tmp-${crypto.randomUUID()}`);
  await fsApi.mkdir(temporaryRoot, { mode: 0o700 });
  const marker = path.join(temporaryRoot, '.snapshot-operation-id');
  const operationId = crypto.randomUUID();
  try {
    await fsApi.writeFile(marker, operationId, { flag: 'wx', mode: 0o600 });
    await fsApi.chmod(temporaryRoot, 0o755);
    const dataByPath = new Map(closure.files.map(file => [file.rel, file]));
    await writeSnapshotTree(temporaryRoot, records, dataByPath, manifest, fsApi);
    await verifySnapshot({ snapshotRoot: temporaryRoot, fsApi, operationId });
    await recheckSources(closure, fsApi);
    await hooks.beforePublish?.({ temporaryRoot, finalRoot, closure });
    await fsApi.rename(temporaryRoot, finalRoot);
    await hooks.afterPublishBeforeVerify?.({ finalRoot, closure });
    const verifiedBeforeMarkerRemoval = await verifySnapshot({ snapshotRoot: finalRoot, fsApi, operationId });
    await fsApi.unlink(path.join(finalRoot, '.snapshot-operation-id'));
    const verified = await verifySnapshot({ snapshotRoot: finalRoot, fsApi });
    return { ...verified, path: finalRoot, sourceFingerprint: fingerprint, sourceRootMode: manifest.sourceRootMode, gitCommit: null, estimatedAllocatedBytes: allocation.allocatedBytes, estimatedInodes: allocation.estimatedInodes, publishCheckFingerprint: verifiedBeforeMarkerRemoval.fingerprint };
  } catch (error) {
    for (const candidate of [temporaryRoot, finalRoot]) {
      try {
        const candidateMarker = path.join(candidate, '.snapshot-operation-id');
        const markerValue = await fsApi.readFile(candidateMarker, 'utf8');
        if (markerValue === operationId) await fsApi.rm(candidate, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
}

export async function buildRollbackPlan({ snapshotRoot, originalExecStart, originalWorkingDirectory, originalEntrypoint, fsApi = fs }) {
  if (!Array.isArray(originalExecStart) || originalExecStart.length < 2 || originalExecStart.some(part => typeof part !== 'string')) fail('EXECSTART_METADATA_INVALID');
  if (typeof originalWorkingDirectory !== 'string' || !path.isAbsolute(originalWorkingDirectory)) fail('WORKING_DIRECTORY_METADATA_INVALID');
  const verified = await verifySnapshot({ snapshotRoot, fsApi });
  if (verified.status !== 'PASS') fail('POSIX_MODE_UNCONFIRMED');
  const oldEntry = path.resolve(originalEntrypoint);
  const index = originalExecStart.findIndex(arg => path.resolve(arg) === oldEntry);
  if (index < 0 || originalExecStart.findIndex((arg, i) => i !== index && path.resolve(arg) === oldEntry) >= 0) fail('ORIGINAL_ENTRYPOINT_NOT_UNIQUE');
  const snapshotEntrypoint = path.join(path.resolve(snapshotRoot), ...verified.entrypoint.split('/'));
  const replacement = [...originalExecStart];
  replacement[index] = snapshotEntrypoint;
  const beforeHash = sha256(Buffer.from(canonicalJson(originalExecStart)));
  const afterHash = sha256(Buffer.from(canonicalJson(replacement)));
  const preserved = originalExecStart.filter((_, i) => i !== index).join('\0') === replacement.filter((_, i) => i !== index).join('\0');
  if (!preserved || beforeHash === afterHash) fail('ROLLBACK_PLAN_VALIDATION_FAILED');
  return {
    status: 'PASS',
    snapshotFingerprint: verified.fingerprint,
    entrypointIndex: index,
    replacementEntrypoint: snapshotEntrypoint,
    originalExecStartSha256: beforeHash,
    rollbackExecStartSha256: afterHash,
    nonEntrypointArgumentsPreserved: true,
    workingDirectoryUnchanged: originalWorkingDirectory,
    stateBehavior: 'WorkingDirectory is unchanged; mutable state is not copied or rolled back',
  };
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  const options = new Map();
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--') || i + 1 >= args.length) fail('USAGE');
    options.set(args[i].slice(2), args[++i]);
  }
  if (command === 'inspect') {
    const allowed = new Set(['source-root', 'entrypoint']);
    if ([...options.keys()].some(key => !allowed.has(key)) || options.size !== 2 || !options.has('source-root') || !options.has('entrypoint')) fail('USAGE');
    const result = await inspectRuntimeClosure({ sourceRoot: options.get('source-root'), entrypoint: options.get('entrypoint') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'create') {
    const allowed = new Set(['source-root', 'entrypoint', 'destination-parent', 'minimum-free-bytes', 'minimum-free-inodes', 'sync-quiesced']);
    if ([...options.keys()].some(key => !allowed.has(key)) || ['source-root', 'entrypoint', 'destination-parent', 'minimum-free-bytes', 'minimum-free-inodes'].some(key => !options.has(key))) fail('USAGE');
    const result = await createSnapshot({
      sourceRoot: options.get('source-root'),
      entrypoint: options.get('entrypoint'),
      destinationParent: options.get('destination-parent'),
      minimumFreeBytes: Number(options.get('minimum-free-bytes')),
      minimumFreeInodes: Number(options.get('minimum-free-inodes')),
      quiesced: options.get('sync-quiesced') === 'yes',
    });
    process.stdout.write(`${JSON.stringify({ status: 'PASS', path: result.path, fingerprint: result.fingerprint, fileCount: result.fileCount, totalBytes: result.totalBytes, estimatedAllocatedBytes: result.estimatedAllocatedBytes, estimatedInodes: result.estimatedInodes, gitCommit: null })}\n`);
    return;
  }
  if (command === 'verify') {
    if (options.size !== 1 || !options.has('snapshot-root')) fail('USAGE');
    const result = await verifySnapshot({ snapshotRoot: options.get('snapshot-root') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'rollback-plan') {
    if (options.size !== 2 || options.get('unit-metadata-stdin') !== 'yes' || !options.has('snapshot-root')) fail('USAGE');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 64 * 1024) fail('UNIT_METADATA_TOO_LARGE');
    }
    let metadata;
    try { metadata = JSON.parse(input); } catch { fail('UNIT_METADATA_INVALID'); }
    const result = await buildRollbackPlan({
      snapshotRoot: options.get('snapshot-root'),
      originalExecStart: metadata.execStart,
      originalWorkingDirectory: metadata.workingDirectory,
      originalEntrypoint: metadata.originalEntrypoint,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  fail('USAGE');
}

if (process.argv[1] === '-' || (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)) {
  try { await cli(); }
  catch (error) {
    if (process.argv[2] === 'inspect') {
      const code = safeInspectStopCode(error);
      process.stderr.write(`${JSON.stringify(inspectStopReport(code))}\n`);
      process.exitCode = code === 'INSPECT_INTERNAL_ERROR' ? 1 : 2;
    } else {
      const code = error instanceof SnapshotError ? error.code : 'SNAPSHOT_INTERNAL_ERROR';
      process.stderr.write(`${JSON.stringify({ status: 'STOP', code })}\n`);
      process.exitCode = 1;
    }
  }
}

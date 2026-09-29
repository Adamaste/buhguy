import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MIGRATIONS_DIR } from '../src/database.js';

test('migration wrapper resolves repository migrations independently of caller cwd', () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const originalCwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    assert.equal(path.resolve(DEFAULT_MIGRATIONS_DIR), path.join(repositoryRoot, 'db', 'migrations'));
  } finally {
    process.chdir(originalCwd);
  }
});

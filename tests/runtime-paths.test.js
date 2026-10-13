import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onboardingFinishInvocation } from '../src/runtime-paths.js';

test('FNS child entrypoint follows the immutable release while cwd keeps legacy state paths', async t => {
  const originalCwd = process.cwd();
  const legacyCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'buhguy-legacy-cwd-'));
  t.after(async () => { process.chdir(originalCwd); await fs.rm(legacyCwd, { recursive: true, force: true }); });
  process.chdir(legacyCwd);
  const invocation = onboardingFinishInvocation('synthetic-source');
  assert.equal(invocation.cwd, legacyCwd);
  const helperPath = fileURLToPath(new URL('../src/runtime-paths.js', import.meta.url));
  assert.equal(invocation.args[0], path.resolve(path.dirname(helperPath), '../bin/receipt-collector.js'));
  assert.equal(path.basename(path.dirname(invocation.args[0])), 'bin');
  assert.equal(process.cwd(), legacyCwd);
});


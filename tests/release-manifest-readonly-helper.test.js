import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('saved targetSha verifier passes its synthetic security matrix without leaking raw paths', () => {
  const helper = fileURLToPath(new URL('../local-tools/verify-release-manifest-readonly.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [helper, '--self-test'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.overall, 'PASS');
  assert.equal(result.tests.valid, 'PASS');
  assert.equal(result.tests.traversal, 'PASS');
  assert.equal(result.tests.symlinkEscape.startsWith('PASS'), true);
  assert.equal(run.stdout.includes('private.json'), false);
});

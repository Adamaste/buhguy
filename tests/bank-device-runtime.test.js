import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runBankDeviceCommand } from '../src/cli.js';

const root = new URL('..', import.meta.url);

test('bank ingestion server and bank-device CLI do not run migrations at runtime', async () => {
  const serverSource = await readFile(new URL('bin/bank-ingestion-server.js', root), 'utf8');
  const cliSource = await readFile(new URL('src/cli.js', root), 'utf8');
  const bankDeviceBranch = cliSource.slice(cliSource.indexOf("if (command === 'bank-device')"), cliSource.indexOf("if (command === 'show')"));
  assert.doesNotMatch(serverSource, /migrate\s*\(/);
  assert.doesNotMatch(bankDeviceBranch, /migrate\s*\(/);
});

test('bank-device CLI uses only DML and exposes secrets only in create output', async () => {
  const calls = [];
  const row = { id: 7, credential_key: 'cred-key-1', bank_source_id: 3, display_name: 'Phone', enabled: true, created_at: 'now', last_used_at: null, revoked_at: null, source_key: 'android-phone-1' };
  const pool = {
    async query(sql) {
      calls.push(sql);
      assert.doesNotMatch(sql, /\b(CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
      if (/INSERT INTO bank_device_credentials/i.test(sql)) return { rows: [{ ...row, token: 'bg1.cred-key-1.secret' }], rowCount: 1 };
      if (/SELECT c\.id,c\.credential_key/i.test(sql)) return { rows: [row], rowCount: 1 };
      if (/UPDATE bank_device_credentials/i.test(sql)) return { rows: [{ id: 7, credential_key: row.credential_key, enabled: false, revoked_at: 'now' }], rowCount: 1 };
      if (/SELECT id FROM bank_sources/i.test(sql)) return { rows: [{ id: 3 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const outputs = [];
  await runBankDeviceCommand({ _: ['create', 'android-phone-1', 'Phone'] }, { pool, write: (value) => outputs.push(value) });
  await runBankDeviceCommand({ _: ['list'] }, { pool, write: (value) => outputs.push(value) });
  await runBankDeviceCommand({ _: ['revoke', 'cred-key-1'] }, { pool, write: (value) => outputs.push(value) });
  assert.match(outputs[0].token, /^bg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(outputs[1].credentials[0], 'token'), false);
  assert.equal(Object.hasOwn(outputs[1].credentials[0], 'secret_hash'), false);
  assert.equal(Object.hasOwn(outputs[2].credential, 'token'), false);
  assert.equal(Object.hasOwn(outputs[2].credential, 'secret_hash'), false);
  assert.ok(calls.length >= 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runBankSourceCommand } from '../src/cli.js';
import { BankSourceProvisioningError, createProvisionedBankSource, linkProvisionedBankSourcePerson, listProvisionedBankSources, setProvisionedBankSourceEnabled } from '../src/bank-source-provisioning.js';

function fakePool() {
  const calls = [];
  const source = { id: 7, source_key: 'android-phone-1', source_type: 'ANDROID_NOTIFICATION', display_name: 'Android phone', enabled: true, created_at: 'now', updated_at: 'now' };
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      assert.doesNotMatch(sql, /\b(CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
      if (/INSERT INTO bank_sources/i.test(sql)) return { rows: [source], rowCount: 1 };
      if (/UPDATE bank_sources/i.test(sql)) return { rows: [{ ...source, enabled: params[1] }], rowCount: 1 };
      if (/FROM bank_sources s/i.test(sql)) return { rows: [{ ...source, person_key: 'constantine', person_display_name: 'Constantine', relation_type: 'OWNER' }], rowCount: 1 };
      if (/SELECT id FROM bank_sources/i.test(sql)) return { rows: [{ id: source.id }], rowCount: 1 };
      if (/FROM persons p/i.test(sql)) return { rows: [{ id: 19, person_key: 'constantine', display_name: 'Constantine' }], rowCount: 1 };
      if (/INSERT INTO bank_source_person/i.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test('bank-source create defaults type and never upserts', async () => {
  const pool = fakePool();
  const result = await createProvisionedBankSource(pool, { sourceKey: 'android-phone-1', displayName: 'Android phone' });
  assert.equal(result.source_type, 'ANDROID_NOTIFICATION');
  assert.match(pool.calls[0].sql, /INSERT INTO bank_sources/);
  assert.doesNotMatch(pool.calls[0].sql, /ON CONFLICT/);
  const duplicatePool = { query: async () => { throw { code: '23505' }; } };
  await assert.rejects(() => createProvisionedBankSource(duplicatePool, { sourceKey: 'android-phone-1', displayName: 'Changed' }), (error) => error.code === 'SOURCE_ALREADY_EXISTS');
});

test('bank-source validates explicit types and safe keys', async () => {
  const pool = fakePool();
  for (const sourceType of ['BANK_API', 'MANUAL_IMPORT']) await createProvisionedBankSource(pool, { sourceKey: `source-${sourceType}`, displayName: 'Source', sourceType });
  await assert.rejects(() => createProvisionedBankSource(pool, { sourceKey: 'bad key', displayName: 'Source' }), (error) => error.code === 'INVALID_SOURCE_KEY');
  await assert.rejects(() => createProvisionedBankSource(pool, { sourceKey: 'source', displayName: 'Source', sourceType: 'NOPE' }), (error) => error.code === 'INVALID_SOURCE_TYPE');
});

test('bank-source list is safe, enable/disable are explicit, and link-person is idempotent', async () => {
  const pool = fakePool();
  const outputs = [];
  await runBankSourceCommand({ _: ['list'] }, { pool, write: (value) => outputs.push(value) });
  await runBankSourceCommand({ _: ['disable'], 'source-key': 'android-phone-1' }, { pool, write: (value) => outputs.push(value) });
  await runBankSourceCommand({ _: ['enable'], 'source-key': 'android-phone-1' }, { pool, write: (value) => outputs.push(value) });
  await runBankSourceCommand({ _: ['link-person'], 'source-key': 'android-phone-1', 'person-key': 'constantine' }, { pool, write: (value) => outputs.push(value) });
  assert.deepEqual(outputs[0].sources[0].persons[0], { person_key: 'constantine', display_name: 'Constantine', relation_type: 'OWNER' });
  assert.equal(outputs[1].source.enabled, false);
  assert.equal(outputs[2].source.enabled, true);
  assert.equal(outputs[3].link.relationType, 'OWNER');
  assert.ok(pool.calls.some(({ sql }) => /ON CONFLICT DO NOTHING/.test(sql)));
});

test('bank-source maps missing entities to stable operational errors', async () => {
  const missingPool = { query: async (sql) => /UPDATE bank_sources/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 } };
  await assert.rejects(() => setProvisionedBankSourceEnabled(missingPool, { sourceKey: 'missing', enabled: true }), (error) => error.code === 'SOURCE_NOT_FOUND');
  await assert.rejects(() => linkProvisionedBankSourcePerson(missingPool, { sourceKey: 'missing', personKey: 'person' }), (error) => error.code === 'SOURCE_NOT_FOUND');
  assert.equal(BankSourceProvisioningError.prototype.constructor.name, 'BankSourceProvisioningError');
});

test('bank-source commands do not invoke migrations or DDL', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));
  const branch = source.match(/if \(command === 'bank-source'\) \{[\s\S]*?\n  \}\r?\n\r?\n  if \(command === 'show'/)?.[0] ?? '';
  assert.notEqual(branch, '');
  assert.doesNotMatch(branch, /migrate\s*\(/);
  assert.doesNotMatch(branch, /\b(CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
});

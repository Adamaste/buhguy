import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, runBankAccountCommand } from '../src/cli.js';
import { runAccountingCatchup } from '../src/accounting-pipeline.js';

test('normalizePhone accepts common Russian formats', () => {
  assert.equal(normalizePhone('+7 919 724-84-51'), '79197248451');
  assert.equal(normalizePhone('8 (919) 724-84-51'), '79197248451');
  assert.equal(normalizePhone('79197248451'), '79197248451');
});

test('accounting catch-up is exposed as a scope-wide CLI pipeline', () => {
  assert.equal(typeof runAccountingCatchup, 'function');
});

test('bank account CLI requires an explicit reason for manual resolution', async () => {
  await assert.rejects(
    () => runBankAccountCommand({ _: ['resolve-manual'], 'transaction-id': '1', 'account-id': '2' }, { pool: {} }),
    /Manual resolution requires --reason/,
  );
});

test('bank account CLI does not expose an exact manual subcommand', async () => {
  await assert.rejects(
    () => runBankAccountCommand({ _: ['resolve-exact'], 'transaction-id': '1', 'account-id': '2' }, { pool: {} }),
    /must be create, list, link-person, add-instrument, add-reference, resolve-reference, resolve-manual or coverage/,
  );
});

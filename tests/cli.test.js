import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../src/cli.js';

test('normalizePhone accepts common Russian formats', () => {
  assert.equal(normalizePhone('+7 919 724-84-51'), '79197248451');
  assert.equal(normalizePhone('8 (919) 724-84-51'), '79197248451');
  assert.equal(normalizePhone('79197248451'), '79197248451');
});

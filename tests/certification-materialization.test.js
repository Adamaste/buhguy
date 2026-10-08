import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeCurrentCertification } from '../src/certification-materialization.js';

test('public materialization API is exported and requires an explicit scope default', async () => {
  assert.equal(typeof materializeCurrentCertification, 'function');
  assert.equal(materializeCurrentCertification.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReceiptDetail } from '../src/normalize.js';

test('same fiscal document number with distinct fiscal identities keeps distinct list keys', () => {
  const a = normalizeReceiptDetail({ fiscalDocumentNumber: '123', fiscalDriveNumber: 'D1', fiscalSign: 'S1' }, { sourceId: 'K1' });
  const b = normalizeReceiptDetail({ fiscalDocumentNumber: '123', fiscalDriveNumber: 'D2', fiscalSign: 'S2' }, { sourceId: 'K2' });
  assert.equal(a.id, 'K1');
  assert.equal(b.id, 'K2');
  assert.notEqual(a.id, b.id);
  assert.notEqual(`${a.id}|${a.id}`, `${b.id}|${b.id}`);
});

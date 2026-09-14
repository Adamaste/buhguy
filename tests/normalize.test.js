import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItems, normalizeOperationType, normalizeReceiptDetail, normalizeReceiptListItem } from '../src/normalize.js';

test('normalize operation type preserves FNS fiscal semantics', () => {
  assert.equal(normalizeOperationType(1), 1);
  assert.equal(normalizeOperationType(2), 2);
  assert.equal(normalizeOperationType(3), 3);
  assert.equal(normalizeOperationType(4), 4);
  assert.equal(normalizeOperationType(undefined), null);
  assert.equal(normalizeOperationType(0), null);
  assert.equal(normalizeOperationType(5), null);
  assert.equal(normalizeOperationType('unexpected'), null);
});

test('normalize list receipt', () => {
  const normalized = normalizeReceiptListItem({
    key: 'abc',
    createdDate: '2026-09-04T10:00:00Z',
    kktOwner: 'Shop',
    kktOwnerInn: '7700000000',
    totalSum: '123.45',
    currency: 'RUB',
  });

  assert.deepEqual(normalized, {
    id: 'abc',
    dateTime: '2026-09-04T10:00:00Z',
    seller: 'Shop',
    sellerInn: '7700000000',
    totalSum: 123.45,
    currency: 'RUB',
  });
});

test('normalize receipt detail', () => {
  const normalized = normalizeReceiptDetail({
    key: 'r1',
    dateTime: '2026-09-04T10:00:00Z',
    user: 'Seller',
    userInn: '7700000000',
    totalSum: 100,
    items: [
      { name: 'Milk', quantity: '2', price: '30', sum: '60' },
      { productName: 'Bread', amount: '1', itemPrice: '40', total: '40' },
    ],
  });

  assert.deepEqual(normalized, {
    id: 'r1',
    dateTime: '2026-09-04T10:00:00Z',
    seller: 'Seller',
    sellerInn: '7700000000',
    totalSum: 100,
    currency: null,
    operationType: null,
    items: [
      { name: 'Milk', quantity: 2, price: 30, sum: 60 },
      { name: 'Bread', quantity: 1, price: 40, sum: 40 },
    ],
  });
});

test('detail normalization preserves list source key when detail omits key', () => {
  const normalized = normalizeReceiptDetail({ fiscalDocumentNumber: '123', fiscalDriveNumber: 'D1', fiscalSign: 'S1' }, { sourceId: 'K1' });
  assert.equal(normalized.id, 'K1');
});

test('missing source key never falls back to fiscalDocumentNumber', () => {
  const normalized = normalizeReceiptDetail({ fiscalDocumentNumber: '123', fiscalDriveNumber: 'D1', fiscalSign: 'S1' });
  assert.equal(normalized.id, null);
});

test('normalize items handles incomplete fields', () => {
  assert.deepEqual(normalizeItems([{}, null, { name: 'X' }]), [
    { name: '', quantity: null, price: null, sum: null },
    { name: '', quantity: null, price: null, sum: null },
    { name: 'X', quantity: null, price: null, sum: null },
  ]);
});

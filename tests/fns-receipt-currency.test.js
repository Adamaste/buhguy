import test from 'node:test';
import assert from 'node:assert/strict';
import { FNS_RECEIPT_CURRENCY_MODEL_VERSION, resolveFnsReceiptCurrency } from '../src/fns-receipt-currency.js';

test('FNS source contract derives RUB when explicit currency is absent', () => {
  assert.deepEqual(resolveFnsReceiptCurrency({ fnsSourceProven: true }), {
    status: 'RESOLVED', currency: 'RUB', modelVersion: FNS_RECEIPT_CURRENCY_MODEL_VERSION,
    basis: 'FNS_SOURCE_CONTRACT', reasonCode: 'FNS_FISCAL_AMOUNTS_ARE_RUBLES', sourceFamily: 'FNS_FISCAL_RECEIPT',
  });
});

test('explicit RUB remains explicit evidence', () => {
  assert.equal(resolveFnsReceiptCurrency({ explicitCurrency: 'rub', fnsSourceProven: true }).basis, 'EXPLICIT_PAYLOAD');
});

test('explicit non-RUB and malformed currency fail closed', () => {
  assert.equal(resolveFnsReceiptCurrency({ explicitCurrency: 'USD', fnsSourceProven: true }).status, 'CONFLICT');
  assert.equal(resolveFnsReceiptCurrency({ explicitCurrency: 'not-a-currency', fnsSourceProven: true }).reasonCode, 'INVALID_EXPLICIT_CURRENCY');
});

test('absent currency without proven FNS source is unresolved', () => {
  assert.equal(resolveFnsReceiptCurrency().status, 'UNRESOLVED');
});

test('resolver does not mutate its input', () => {
  const input = { explicitCurrency: null, fnsSourceProven: true };
  const before = structuredClone(input);
  resolveFnsReceiptCurrency(input);
  assert.deepEqual(input, before);
});

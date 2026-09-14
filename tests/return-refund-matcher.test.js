import test from 'node:test';
import assert from 'node:assert/strict';
import { matchReturnReceipts } from '../src/return-refund-matcher.js';

const sale = (id, overrides = {}) => ({ id, operationType: 1, sellerInn: 'seller-a', totalSum: '100.00', currency: 'RUB', dateTime: '2026-01-01T10:00:00Z', normalizationStatus: 'READY', paymentStage: 'SETTLEMENT_ONLY', items: [{ name: 'Widget', quantity: 1, price: '100.00', itemSum: '100.00' }], ...overrides });
const ret = (id, overrides = {}) => ({ id, operationType: 2, sellerInn: 'seller-a', totalSum: '100.00', currency: 'RUB', dateTime: '2026-01-02T10:00:00Z', normalizationStatus: 'READY', paymentStage: 'SETTLEMENT_ONLY', items: [{ name: 'Widget', quantity: 1, price: '100.00', itemSum: '100.00' }], ...overrides });

test('exact unique full return confirms only with a resolved purchase target', () => {
  const result = matchReturnReceipts([sale('s'), ret('r')], { purchaseTargets: new Map([['s', { kind: 'EXISTING', eventId: 10 }]]) });
  assert.equal(result.summary.confirmed, 1);
  assert.equal(result.results[0].status, 'CONFIRMED');
  assert.equal(result.results[0].refundStatus, 'UNPROVEN');
});

test('standalone full settlement can provide a deterministic purchase target', () => {
  const result = matchReturnReceipts([sale('s'), ret('r')], { standalonePurchaseEligible: new Set(['s']) });
  assert.equal(result.results[0].status, 'CONFIRMED');
  assert.equal(result.results[0].purchaseTarget.kind, 'STANDALONE');
});

test('ambiguous exact competition never confirms', () => {
  const result = matchReturnReceipts([sale('s1'), sale('s2', { dateTime: '2026-01-01T11:00:00Z' }), ret('r')], { purchaseTargets: new Map([['s1', { eventId: 1 }], ['s2', { eventId: 2 }]]) });
  assert.equal(result.summary.ambiguous, 1);
  assert.equal(result.results[0].status, 'AMBIGUOUS');
});

test('partial returns remain candidate-only', () => {
  const result = matchReturnReceipts([sale('s'), ret('r', { totalSum: '40.00', items: [{ name: 'Widget', quantity: 0.4, price: '100.00', itemSum: '40.00' }] })], { standalonePurchaseEligible: new Set(['s']) });
  assert.equal(result.summary.candidateOnly, 1);
});

test('seller mismatch, over-return and return-before-sale fail closed', () => {
  const mismatch = matchReturnReceipts([sale('s', { sellerInn: 'seller-b' }), ret('r')], { standalonePurchaseEligible: new Set(['s']) });
  assert.equal(mismatch.results[0].status, 'UNMATCHED');
  const over = matchReturnReceipts([sale('s'), ret('r')], { standalonePurchaseEligible: new Set(['s']), priorReturnedAmountBySaleId: new Map([['s', 100]]) });
  assert.notEqual(over.results[0].status, 'CONFIRMED');
  const before = matchReturnReceipts([sale('s', { dateTime: '2026-01-03T10:00:00Z' }), ret('r')], { standalonePurchaseEligible: new Set(['s']) });
  assert.equal(before.results[0].status, 'UNMATCHED');
});

test('two full returns cannot consume one purchase twice', () => {
  const result = matchReturnReceipts([sale('s'), ret('r1'), ret('r2', { dateTime: '2026-01-03T10:00:00Z' })], { standalonePurchaseEligible: new Set(['s']) });
  assert.equal(result.summary.confirmed, 1);
  assert.equal(result.summary.candidateOnly, 1);
  assert.equal(result.results.filter((row) => row.status === 'CONFIRMED').length, 1);
});

test('repeat and concurrent dry-run are deterministic and non-mutating', async () => {
  const inputs = [sale('s'), ret('r')];
  const [first, second, concurrent] = await Promise.all([Promise.resolve(matchReturnReceipts(inputs, { standalonePurchaseEligible: new Set(['s']) })), Promise.resolve(matchReturnReceipts(inputs, { standalonePurchaseEligible: new Set(['s']) })), Promise.resolve(matchReturnReceipts(inputs, { standalonePurchaseEligible: new Set(['s']) }))]);
  assert.deepEqual(second, first);
  assert.deepEqual(concurrent, first);
});

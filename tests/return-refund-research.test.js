import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReturnResearch, candidatePredicates } from '../src/return-refund-research.js';

const sale = (id, overrides = {}) => ({ id, operationType: 1, sellerInn: 'seller-a', totalSum: '100.00', dateTime: '2026-01-01T10:00:00Z', items: [{ name: 'Widget', quantity: 1, price: '100.00', itemSum: '100.00' }], ...overrides });
const refund = (overrides = {}) => ({ id: 'r', operationType: 2, sellerInn: 'seller-a', totalSum: '100.00', dateTime: '2026-01-02T10:00:00Z', items: [{ name: 'Widget', quantity: 1, price: '100.00', itemSum: '100.00' }], ...overrides });

test('exact unique return is safe only with one unused prior sale', () => {
  const result = classifyReturnResearch(refund(), [sale('s')]);
  assert.equal(result.classification, 'EXACT_UNIQUE_SAFE');
  assert.equal(result.strictCandidateReceiptId, 's');
});

test('identical purchases are ambiguous and nearest is not selected', () => {
  const result = classifyReturnResearch(refund(), [sale('s1'), sale('s2', { dateTime: '2026-01-01T11:00:00Z' })]);
  assert.equal(result.classification, 'AMBIGUOUS_EXACT_COMPETITION');
  assert.equal(result.strictCandidateReceiptId, null);
});

test('partial return remains a candidate and supports repeated partial returns', () => {
  const result = classifyReturnResearch(refund({ totalSum: '40.00', items: [{ name: 'Widget', quantity: 0.4, price: '100.00', itemSum: '40.00' }] }), [sale('s')]);
  assert.equal(result.classification, 'PARTIAL_ITEM_CANDIDATE');
  assert.equal(result.strictCandidateReceiptId, null);
});

test('item overlap with an excess quantity is not treated as a partial subset', () => {
  const result = classifyReturnResearch(refund({ totalSum: '200.00', items: [{ name: 'Widget', quantity: 2, price: '100.00', itemSum: '200.00' }] }), [sale('s')]);
  assert.equal(result.classification, 'ITEM_MATCH_SELLER_OR_AMOUNT_MISMATCH');
});

test('over-return and prior allocation are not strict-safe', () => {
  const options = { priorReturnsBySaleId: new Map([['s', 1]]), priorReturnedAmountBySaleId: new Map([['s', 80]]), allocatedSaleIds: new Set(['s']) };
  const result = classifyReturnResearch(refund(), [sale('s')], options);
  assert.equal(result.classification, 'EXACT_UNIQUE_BLOCKED');
  assert.equal(result.strictCandidateReceiptId, null);
  assert.equal(candidatePredicates(refund(), sale('s'), options).noExistingReturnAllocation, false);
});

test('cumulative return amount cannot exceed the original sale amount', () => {
  const options = { priorReturnedAmountBySaleId: new Map([['s', 80]]) };
  const result = classifyReturnResearch(refund({ totalSum: '100.00' }), [sale('s')], options);
  assert.equal(result.classification, 'EXACT_UNIQUE_BLOCKED');
  assert.equal(result.candidates[0].predicates.noOverReturn, false);
});

test('seller mismatch and no prior sale are explicit', () => {
  assert.equal(classifyReturnResearch(refund({ dateTime: '2025-01-01T10:00:00Z' }), [sale('s')]).classification, 'NO_PRIOR_SALE_IN_HISTORY');
  assert.equal(classifyReturnResearch(refund(), [sale('s', { sellerInn: 'seller-b' })]).classification, 'AMOUNT_MATCH_SELLER_MISMATCH');
});

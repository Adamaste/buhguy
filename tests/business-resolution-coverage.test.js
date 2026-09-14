import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCoverage, classifyCoverage, paymentComponentSignature, paymentTypeSignature } from '../src/business-resolution-coverage.js';

const receipt = (overrides = {}) => ({ operationType: 1, totalSum: 100, fact: { normalizationStatus: 'READY', paymentStage: 'SETTLEMENT_ONLY', cashTotalSum: '100.00', ecashTotalSum: '0.00', prepaidSum: '0.00', creditSum: '0.00', provisionSum: '0.00' }, ...overrides });

test('coverage classifies confirmed, ambiguous, candidate and standalone receipts', () => {
  assert.deepEqual(classifyCoverage(receipt(), { graphConfirmed: true }), { state: 'CONFIRMED', scenarioClass: 'PREPAYMENT_SETTLEMENT_CONFIRMED' });
  assert.deepEqual(classifyCoverage(receipt(), { matcherState: 'AMBIGUOUS' }), { state: 'AMBIGUOUS', scenarioClass: 'PREPAYMENT_AMBIGUOUS' });
  assert.deepEqual(classifyCoverage(receipt(), { matcherState: 'CANDIDATE' }), { state: 'CANDIDATE_ONLY', scenarioClass: 'PREPAYMENT_CANDIDATE' });
  assert.deepEqual(classifyCoverage(receipt()), { state: 'UNRESOLVED', scenarioClass: 'STANDALONE_FULL_SETTLEMENT' });
});

test('coverage blocks incomplete normalization and keeps return ambiguity explicit', () => {
  assert.equal(classifyCoverage(receipt({ fact: { normalizationStatus: 'BLOCKED' } })).state, 'BLOCKED');
  assert.deepEqual(classifyCoverage(receipt({ operationType: 2 }), { returnState: 'AMBIGUOUS' }), { state: 'AMBIGUOUS', scenarioClass: 'RETURN_AMBIGUOUS' });
  assert.deepEqual(classifyCoverage(receipt({ operationType: 2 }), { returnState: 'UNMATCHED' }), { state: 'UNRESOLVED', scenarioClass: 'RETURN_UNMATCHED' });
});

test('payment signatures and monetary aggregation are deterministic without double counting', () => {
  assert.equal(paymentTypeSignature([{ paymentTypeCode: 4 }, { paymentTypeCode: 1 }, { paymentTypeCode: 4 }]), '[1,4]');
  assert.equal(paymentComponentSignature({ cashTotalSum: '10', ecashTotalSum: '0', prepaidSum: '90', creditSum: '0', provisionSum: '0' }), 'NEW_MONEY_PLUS_PREPAID');
  const summary = aggregateCoverage([
    { state: 'UNRESOLVED', totalSum: 100, fact: { cashTotalSum: 100, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0 } },
    { state: 'CANDIDATE_ONLY', totalSum: 50, fact: { cashTotalSum: 0, ecashTotalSum: 0, prepaidSum: 50, creditSum: 0, provisionSum: 0 } },
  ]);
  assert.equal(summary.UNRESOLVED.fiscalFaceValue, 100);
  assert.equal(summary.CANDIDATE_ONLY.prepaidUsed, 50);
  assert.equal(Object.values(summary).reduce((sum, bucket) => sum + bucket.receipts, 0), 2);
});

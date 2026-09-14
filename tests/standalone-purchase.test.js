import test from 'node:test';
import assert from 'node:assert/strict';
import { standaloneEligibility, standaloneSemanticKey, STANDALONE_PURCHASE_RULE, STANDALONE_PURCHASE_VERSION } from '../src/standalone-purchase.js';

const row = (overrides = {}) => ({ id: 1, normalizationStatus: 'READY', operationType: 1, fiscalOperationType: 1, currency: 'RUB', paymentStage: 'SETTLEMENT_ONLY', cashTotalSum: '0.00', cashTotalState: 'EXPLICIT_ZERO', ecashTotalSum: '2350.00', ecashTotalState: 'PRESENT_VALUE', prepaidSum: '0.00', prepaidState: 'EXPLICIT_ZERO', creditSum: '0.00', creditState: 'EXPLICIT_ZERO', provisionSum: '0.00', provisionState: 'EXPLICIT_ZERO', paymentComponentsStatus: 'RECONCILED', totalSum: '2350.00', ...overrides });

test('ordinary full settlement is standalone eligible', () => assert.deepEqual(standaloneEligibility(row()), { category: 'ELIGIBLE_STANDALONE', reason: 'STRICT_NEW_MONEY_FULL_SETTLEMENT' }));
test('replay uses a stable standalone semantic key', () => assert.equal(standaloneSemanticKey(42), 'standalone-purchase:42'));
test('prepayment and advance are excluded', () => {
  assert.equal(standaloneEligibility(row({ paymentStage: 'PREPAYMENT_ONLY' })).category, 'EXCLUDED_PREPAYMENT');
  assert.equal(standaloneEligibility(row({ paymentStage: 'ADVANCE_ONLY' })).category, 'EXCLUDED_ADVANCE');
});
test('mixed payment type is excluded', () => assert.equal(standaloneEligibility(row({ paymentStage: 'MIXED' })).category, 'EXCLUDED_MIXED'));
test('prepaid, credit and provision components fail closed', () => {
  assert.equal(standaloneEligibility(row({ prepaidSum: '1.00', prepaidState: 'PRESENT_VALUE' })).category, 'EXCLUDED_PREPAID_COMPONENT');
  assert.equal(standaloneEligibility(row({ creditSum: '1.00', creditState: 'PRESENT_VALUE' })).category, 'EXCLUDED_CREDIT');
  assert.equal(standaloneEligibility(row({ provisionSum: '1.00', provisionState: 'PRESENT_VALUE' })).category, 'OTHER_UNSUPPORTED');
});
test('missing components are not treated as zero', () => assert.notEqual(standaloneEligibility(row({ prepaidSum: null, prepaidState: 'FIELD_MISSING' })).category, 'ELIGIBLE_STANDALONE'));
test('existing multi-receipt lifecycle is excluded before ordinary predicates', () => assert.equal(standaloneEligibility(row(), { lifecycleReceiptIds: new Set(['1']) }).category, 'EXCLUDED_ALREADY_MULTI_RECEIPT'));
test('existing purchase evidence is reused, not duplicated', () => assert.equal(standaloneEligibility(row(), { purchaseReceiptIds: new Set(['1']) }).category, 'EXCLUDED_ALREADY_PURCHASE'));
test('return target can converge through existing purchase evidence', () => assert.equal(standaloneEligibility(row(), { purchaseReceiptIds: new Set(['1']) }).reason, 'PURCHASE_EVIDENCE_ALREADY_EXISTS'));
test('identity and operation guards fail closed', () => {
  assert.equal(standaloneEligibility(row({ operationType: 2 })).category, 'OTHER_UNSUPPORTED');
  assert.equal(standaloneEligibility(row({ currency: 'USD' })).category, 'OTHER_UNSUPPORTED');
  assert.equal(standaloneEligibility(row({ currency: null })).category, 'ELIGIBLE_STANDALONE');
  assert.equal(STANDALONE_PURCHASE_RULE, 'STANDALONE_PURCHASE_V1');
  assert.equal(STANDALONE_PURCHASE_VERSION, 'standalone-purchase-v1');
});

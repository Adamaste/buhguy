import test from 'node:test';
import assert from 'node:assert/strict';
import { fiscalContentFingerprint } from '../src/fiscal-evidence.js';
import { NORMALIZATION_VERSION, normalizeFiscalEvidence } from '../src/fiscal-normalization.js';

function raw(overrides = {}) {
  return {
    key: 'norm-1', totalSum: 100, operationType: 1, fiscalDocumentFormatVer: '4',
    cashTotalSum: 20, ecashTotalSum: 30, prepaidSum: 50, creditSum: 0, provisionSum: 0,
    items: [{ name: 'Item', quantity: 1, price: 100, sum: 100, paymentType: 4, productType: 4, providerInn: '7700000000', productCodeNew: { code: { gtin: '00000000000000', rawProductCode: 'raw-code' } } }],
    ...overrides,
  };
}

test('NORM-INV-004/011: same evidence is deterministic and direction is separate', () => {
  const a = normalizeFiscalEvidence(raw(), { receiptId: 1 });
  const b = normalizeFiscalEvidence({ items: raw().items, provisionSum: 0, creditSum: 0, prepaidSum: 50, ecashTotalSum: 30, cashTotalSum: 20, fiscalDocumentFormatVer: '4', operationType: 1, totalSum: 100, key: 'norm-1' }, { receiptId: 1 });
  assert.equal(a.facts.normalizationVersion, NORMALIZATION_VERSION);
  assert.equal(a.facts.normalizationStatus, 'READY');
  assert.equal(a.facts.householdCashDirection, 'OUT');
  assert.equal(a.facts.normalizedContentSha256, b.facts.normalizedContentSha256);
});

test('NORM-INV-005: unknown FFD is unsupported and never guessed', () => {
  const result = normalizeFiscalEvidence(raw({ fiscalDocumentFormatVer: '99' }), { receiptId: 1 });
  assert.equal(result.facts.normalizationStatus, 'UNSUPPORTED');
  assert.equal(result.facts.paymentComponentsStatus, 'UNSUPPORTED');
  assert.equal(result.issues[0].issueCode, 'UNKNOWN_FFD_VERSION');
});

test('NORM-INV-006: missing component is not zero', () => {
  const result = normalizeFiscalEvidence(raw({ prepaidSum: undefined }), { receiptId: 1 });
  assert.equal(result.facts.prepaid_sum, null);
  assert.equal(result.facts.prepaid_state, 'FIELD_MISSING');
  assert.notEqual(result.facts.paymentComponentsStatus, 'RECONCILED');
});

test('NORM-INV-006: explicit zero is preserved', () => {
  const result = normalizeFiscalEvidence(raw({ prepaidSum: 0, cashTotalSum: 100, ecashTotalSum: 0 }), { receiptId: 1 });
  assert.equal(result.facts.prepaid_sum, '0.00');
  assert.equal(result.facts.prepaid_state, 'EXPLICIT_ZERO');
});

test('NORM-INV-007/008: item payment types remain item-scoped and mixed is visible', () => {
  const result = normalizeFiscalEvidence(raw({ items: [{ paymentType: 1 }, { paymentType: 4 }], totalSum: 100 }), { receiptId: 1 });
  assert.equal(result.facts.paymentStage, 'MIXED');
  assert.deepEqual(result.itemFacts.map((item) => item.paymentTypeCode), [1, 4]);
});

test('NORM-INV-009: component mismatch is blocked and visible', () => {
  const result = normalizeFiscalEvidence(raw({ cashTotalSum: 99 }), { receiptId: 1 });
  assert.equal(result.facts.paymentComponentsStatus, 'MISMATCH');
  assert.equal(result.facts.normalizationStatus, 'BLOCKED');
  assert.ok(result.issues.some((issue) => issue.issueCode === 'PAYMENT_COMPONENT_MISMATCH'));
});

test('NORM-INV-011: operation types 2/3/4 map separately from fiscal code', () => {
  assert.equal(normalizeFiscalEvidence(raw({ operationType: 2 }), { receiptId: 1 }).facts.householdCashDirection, 'IN');
  assert.equal(normalizeFiscalEvidence(raw({ operationType: 3 }), { receiptId: 1 }).facts.householdCashDirection, 'IN');
  assert.equal(normalizeFiscalEvidence(raw({ operationType: 4 }), { receiptId: 1 }).facts.householdCashDirection, 'OUT');
});

test('NORM-INV-014: normalizer does not create business purchase relations', () => {
  const result = normalizeFiscalEvidence(raw(), { receiptId: 62 });
  assert.equal(result.semantic.purchaseId, undefined);
  assert.equal(fiscalContentFingerprint(result.semantic), result.facts.normalizedContentSha256);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPrepaymentSettlements, PREPAYMENT_SETTLEMENT_RULE, readPrepaymentSettlementStartAt } from '../src/prepayment-settlement-matcher.js';

const item = (name = 'phone') => ({ name, quantity: 1, price: 100, itemSum: 100, providerInn: '7700000000', gtin: null, rawProductCode: null });
function receipt(id, dateTime, paymentStage, overrides = {}) {
  return { id, fnsId: `fns-${id}`, dateTime, sellerInn: '7700000000', totalSum: 100, currency: 'RUB', operationType: 1, normalizationStatus: 'READY', paymentStage, cashTotalSum: 100, ecashTotalSum: 0, prepaidSum: 0, creditSum: 0, provisionSum: 0, items: [item()], scopeKey: 'default', ...overrides };
}
function pair(overrides = {}) {
  return [receipt(1, '2026-01-01T10:00:00Z', 'PREPAYMENT_ONLY'), receipt(2, '2026-01-02T10:00:00Z', 'SETTLEMENT_ONLY', { prepaidSum: 100, cashTotalSum: 0, ...overrides })];
}

test('PREPAYMENT_SETTLEMENT_V1 confirms one strong prepayment/settlement pair', () => {
  const result = matchPrepaymentSettlements(pair());
  assert.equal(result.rule, PREPAYMENT_SETTLEMENT_RULE);
  assert.deepEqual(result.summary, { settlementsExamined: 1, candidatePairs: 1, strictMatches: 1, confirmedSettlements: 1, ambiguousSettlements: 0, unmatchedSettlements: 0, candidateOnlySettlements: 0 });
  assert.equal(result.candidates[0].purchaseValue, '100.00');
});

test('prepayment persistence cutoff defaults to disabled and accepts only canonical UTC timestamps', () => {
  assert.equal(readPrepaymentSettlementStartAt({}), null);
  assert.equal(readPrepaymentSettlementStartAt({ PREPAYMENT_SETTLEMENT_START_AT: '' }), null);
  assert.equal(readPrepaymentSettlementStartAt({ PREPAYMENT_SETTLEMENT_START_AT: '2026-11-02T12:00:00.000Z' }), '2026-11-02T12:00:00.000Z');
  assert.throws(() => readPrepaymentSettlementStartAt({ PREPAYMENT_SETTLEMENT_START_AT: '2026-11-02T12:00:00Z' }), { code: 'PREPAYMENT_SETTLEMENT_START_AT_INVALID' });
  assert.throws(() => readPrepaymentSettlementStartAt({ PREPAYMENT_SETTLEMENT_START_AT: 'not-a-date' }), { code: 'PREPAYMENT_SETTLEMENT_START_AT_INVALID' });
});

test('compact matcher candidates preserve confirmation and source-ingestion timestamps', () => {
  const rows = pair();
  rows[0].sourceObservedAt = '2026-01-01T10:00:00.000Z';
  rows[1].sourceObservedAt = '2026-01-02T10:00:00.000Z';
  const result = matchPrepaymentSettlements(rows, { retainDetails: false });
  assert.equal(result.candidates[0].confirmed, true);
  assert.equal(result.candidates[0].prepaymentObservedAt, rows[0].sourceObservedAt);
  assert.equal(result.candidates[0].settlementObservedAt, rows[1].sourceObservedAt);
  assert.equal(Object.hasOwn(result.candidates[0], 'predicates'), false);
});

test('same fiscal item multiset matches when receipt line order changes', () => {
  const rows = pair();
  const first = item('phone');
  const second = { ...item('case'), quantity: 2, price: 25, itemSum: 50, gtin: '00000000000001' };
  const third = { ...item('case'), quantity: 2, price: 25, itemSum: 50, gtin: '00000000000001' };
  rows[0] = { ...rows[0], totalSum: 200, ecashTotalSum: 200, items: [first, second, third] };
  rows[1] = { ...rows[1], totalSum: 200, prepaidSum: 200, items: [third, first, second] };
  const result = matchPrepaymentSettlements(rows);
  assert.equal(result.candidates[0].strict, true);
  assert.equal(result.summary.confirmedSettlements, 1);
});

test('item multiset comparison preserves duplicate multiplicity and full item pairing', () => {
  const rows = pair();
  const a = item('a');
  const b = { ...item('b'), price: 0, itemSum: 0 };
  rows[0] = { ...rows[0], items: [a, b] };
  rows[1] = { ...rows[1], items: [b, a, a] };
  const result = matchPrepaymentSettlements(rows);
  assert.equal(result.candidates[0].strict, false);
  assert.equal(result.candidates[0].firstExclusionReason, 'item_count');

  rows[1] = { ...rows[1], items: [{ ...a, price: 99 }, b] };
  const crossed = matchPrepaymentSettlements(rows);
  assert.equal(crossed.candidates[0].strict, false);
  assert.equal(crossed.candidates[0].firstExclusionReason, 'price');
});

test('missing currency on both receipts is compatible, while a known conflict is not', () => {
  const missing = matchPrepaymentSettlements([receipt(1, '2026-01-01T10:00:00Z', 'PREPAYMENT_ONLY', { currency: null }), receipt(2, '2026-01-02T10:00:00Z', 'SETTLEMENT_ONLY', { currency: null, prepaidSum: 100, cashTotalSum: 0 })]);
  assert.equal(missing.candidates[0].strict, true);
  const conflict = matchPrepaymentSettlements(pair({ currency: 'USD' }));
  assert.equal(conflict.candidates[0].strict, false);
  assert.equal(conflict.candidates[0].firstExclusionReason, 'currency_compatible');
});

test('two identical-looking purchases stay independent and ambiguity is explicit', () => {
  const rows = [
    receipt(1, '2026-01-01T10:00:00Z', 'PREPAYMENT_ONLY'),
    receipt(2, '2026-01-01T11:00:00Z', 'PREPAYMENT_ONLY'),
    receipt(3, '2026-01-02T10:00:00Z', 'SETTLEMENT_ONLY', { prepaidSum: 100, cashTotalSum: 0 }),
  ];
  const result = matchPrepaymentSettlements(rows);
  assert.equal(result.summary.strictMatches, 2);
  assert.equal(result.summary.ambiguousSettlements, 1);
  assert.equal(result.settlements[0].status, 'AMBIGUOUS');
});

test('one prepayment cannot be consumed by two separately strict settlements', () => {
  const rows = [
    receipt(1, '2026-01-01T10:00:00Z', 'PREPAYMENT_ONLY'),
    receipt(2, '2026-01-02T10:00:00Z', 'SETTLEMENT_ONLY', { prepaidSum: 100, cashTotalSum: 0 }),
    receipt(3, '2026-01-03T10:00:00Z', 'SETTLEMENT_ONLY', { prepaidSum: 100, cashTotalSum: 0 }),
  ];
  const result = matchPrepaymentSettlements(rows);
  assert.equal(result.summary.strictMatches, 2);
  assert.equal(result.summary.confirmedSettlements, 0);
  assert.equal(result.summary.ambiguousSettlements, 2);
  assert.deepEqual(result.settlements.map((settlement) => settlement.status), ['AMBIGUOUS', 'AMBIGUOUS']);
  assert.equal(result.candidates.every((candidate) => candidate.confirmed !== true), true);
});

test('no candidate, mixed receipt, and advance remain non-confirmed', () => {
  const noCandidate = matchPrepaymentSettlements([receipt(1, '2026-01-02T10:00:00Z', 'SETTLEMENT_ONLY', { prepaidSum: 100, cashTotalSum: 0 })]);
  assert.equal(noCandidate.settlements[0].status, 'UNMATCHED');
  const mixed = matchPrepaymentSettlements(pair({ paymentStage: 'MIXED' }));
  assert.equal(mixed.settlements[0].status, 'CANDIDATE');
  const advance = matchPrepaymentSettlements([receipt(1, '2026-01-01T10:00:00Z', 'ADVANCE_ONLY'), receipt(2, '2026-01-02T10:00:00Z', 'SETTLEMENT_ONLY', { prepaidSum: 100, cashTotalSum: 0 })]);
  assert.equal(advance.summary.candidatePairs, 1);
});

test('operation, seller, chronology, item and payment predicates fail closed', () => {
  for (const overrides of [
    { operationType: 2 },
    { sellerInn: '7800000000' },
    { items: [item('different')] },
    { dateTime: '2025-12-31T10:00:00Z' },
    { prepaidSum: 90 },
  ]) {
    const result = matchPrepaymentSettlements(pair(overrides));
    if (overrides.dateTime) {
      assert.equal(result.settlements[0].status, 'UNMATCHED');
    } else {
      assert.equal(result.candidates[0].strict, false);
      assert.ok(result.candidates[0].firstExclusionReason);
    }
  }
});

test('rerun and out-of-order processing are deterministic', async () => {
  const rows = pair();
  const first = matchPrepaymentSettlements(rows);
  const second = matchPrepaymentSettlements(rows);
  const reversed = matchPrepaymentSettlements([...rows].reverse());
  assert.deepEqual(second, first);
  assert.deepEqual(reversed, first);
  assert.deepEqual(await Promise.all([rows, rows].map(async (value) => matchPrepaymentSettlements(value))), [first, first]);
});

test('incremental arrival and accounting scope isolation are explicit', () => {
  const prepayment = receipt(1, '2026-01-01T10:00:00Z', 'PREPAYMENT_ONLY');
  const settlement = receipt(2, '2026-01-02T10:00:00Z', 'SETTLEMENT_ONLY', { prepaidSum: 100, cashTotalSum: 0 });
  assert.deepEqual(matchPrepaymentSettlements([prepayment]).summary, { settlementsExamined: 0, candidatePairs: 0, strictMatches: 0, confirmedSettlements: 0, ambiguousSettlements: 0, unmatchedSettlements: 0, candidateOnlySettlements: 0 });
  assert.equal(matchPrepaymentSettlements([prepayment, settlement]).summary.strictMatches, 1);
  assert.equal(matchPrepaymentSettlements([{ ...prepayment, scopeKey: 'scope-a' }, { ...settlement, scopeKey: 'scope-b' }]).candidates[0].strict, false);
});

test('manual/external graph assertions are outside pure matcher output', () => {
  const result = matchPrepaymentSettlements(pair());
  assert.equal(Object.hasOwn(result, 'businessEvents'), false);
  assert.equal(Object.hasOwn(result, 'ledger'), false);
});

test('only an explicitly linked receipt is excluded from lifecycle matching', () => {
  const [ordinaryPrepayment, ordinarySettlement] = pair();
  const ordinary = matchPrepaymentSettlements([ordinaryPrepayment, ordinarySettlement]);
  assert.equal(ordinary.summary.confirmedSettlements, 1);

  const linked = matchPrepaymentSettlements([
    { ...ordinaryPrepayment, manualTroikaTopupAlreadyExpensed: true },
    ordinarySettlement,
  ]);
  assert.equal(linked.summary.confirmedSettlements, 0);
  assert.equal(linked.candidates[0].strict, false);
  assert.equal(linked.candidates[0].firstExclusionReason, 'prepayment_not_already_expensed');

  const unrelated = matchPrepaymentSettlements([
    { ...ordinaryPrepayment, id: 31, manualTroikaTopupAlreadyExpensed: false },
    { ...ordinarySettlement, id: 32 },
  ]);
  assert.equal(unrelated.summary.confirmedSettlements, 1);
});

test('an explicitly linked manual transport receipt on the settlement side blocks lifecycle matching', () => {
  const [ordinaryPrepayment, ordinarySettlement] = pair();
  const result = matchPrepaymentSettlements([
    ordinaryPrepayment,
    { ...ordinarySettlement, manualTroikaTopupAlreadyExpensed: true },
  ]);
  assert.equal(result.summary.confirmedSettlements, 0);
  assert.equal(result.candidates[0].strict, false);
  assert.equal(result.candidates[0].firstExclusionReason, 'settlement_not_already_expensed');
});

test('persistence mode does not retain forensic predicate payloads for large candidate sets', () => {
  const rows = [];
  for (let index = 0; index < 120; index += 1) {
    rows.push(receipt(`pre-${index}`, `2026-01-${String((index % 20) + 1).padStart(2, '0')}T10:00:00Z`, 'PREPAYMENT_ONLY'));
    rows.push(receipt(`set-${index}`, `2026-02-${String((index % 20) + 1).padStart(2, '0')}T10:00:00Z`, 'SETTLEMENT_ONLY', { prepaidSum: 100, cashTotalSum: 0 }));
  }
  const result = matchPrepaymentSettlements(rows, { retainDetails: false });
  assert.ok(result.candidates.length > 0);
  assert.equal(result.candidates.some((candidate) => Object.hasOwn(candidate, 'predicates')), false);
  assert.equal(result.candidates.every((candidate) => Object.hasOwn(candidate, 'prepaymentReceiptId') && Object.hasOwn(candidate, 'settlementReceiptId')), true);
});

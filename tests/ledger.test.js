import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveLedgerEntries, LEDGER_RULES, summarizeLedgerProjection } from '../src/ledger.js';

function event(id, type, rule, amountValue) {
  return { id, event_type: type, rule_code: rule, resolution_status: 'CONFIRMED', origin: 'SYSTEM_DERIVED', amount: amountValue, currency: null, created_at: '2026-01-01T00:00:00Z', scope_key: 'default' };
}

test('Xiaomi-like prepayment and fulfillment create one cash outflow and one acquisition', () => {
  const entries = deriveLedgerEntries({
    events: [event(1, 'PURCHASE', 'PREPAYMENT_SETTLEMENT_V1', '32380.00'), event(2, 'PREPAYMENT', 'PREPAYMENT_SETTLEMENT_V1', '32380.00'), event(3, 'FULFILLMENT', 'PREPAYMENT_SETTLEMENT_V1', '32380.00')],
    evidence: [],
    allocations: [],
    edges: [{ source_event_id: 2, target_event_id: 1, relation_type: 'PREPAYMENT_FOR' }, { source_event_id: 3, target_event_id: 1, relation_type: 'FULFILLS' }],
  });
  const postings = entries.flatMap((entry) => entry.postings);
  assert.equal(entries.filter((entry) => entry.derivationRule === LEDGER_RULES.PREPAYMENT).length, 1);
  assert.equal(entries.filter((entry) => entry.derivationRule === LEDGER_RULES.FULFILLMENT).length, 1);
  assert.equal(postings.filter((posting) => posting.account === 'FISCAL_PAYMENT_CLEARING').reduce((total, posting) => total + Number(posting.credit), 0), 32380);
  assert.equal(postings.filter((posting) => posting.account === 'UNCLASSIFIED_ACQUISITION').reduce((total, posting) => total + Number(posting.debit), 0), 32380);
  assert.equal(postings.filter((posting) => posting.account === 'MERCHANT_ADVANCE').reduce((total, posting) => total + Number(posting.debit) - Number(posting.credit), 0), 0);
});

test('return without refund creates receivable and reverses acquisition', () => {
  const entries = deriveLedgerEntries({
    events: [event(10, 'PURCHASE', 'RETURN_REFUND_V1', '100.00'), event(11, 'RETURN', 'RETURN_REFUND_V1', '100.00')],
    evidence: [{ event_id: 10, evidence_id: 100, receipt_id: 1, normalization_version: 'fiscal-normalizer-v1', date_time: '2026-01-01T00:00:00Z', normalization_status: 'READY', cash_total_sum: '0.00', ecash_total_sum: '100.00', payment_components_status: 'RECONCILED' }, { event_id: 11, evidence_id: 101, receipt_id: 2, normalization_version: 'fiscal-normalizer-v1', date_time: '2026-01-02T00:00:00Z', normalization_status: 'READY', cash_total_sum: '0.00', ecash_total_sum: '100.00', payment_components_status: 'RECONCILED' }],
    allocations: [{ id: 500, target_event_id: 11, source_receipt_id: 2, allocated_amount: '100.00', resolution_status: 'CONFIRMED' }],
    edges: [{ source_event_id: 11, target_event_id: 10, relation_type: 'RETURNS' }],
  });
  const returnEntry = entries.find((entry) => entry.derivationRule === LEDGER_RULES.RETURN);
  assert.deepEqual(returnEntry.postings.map((posting) => [posting.account, posting.debit, posting.credit]), [['MERCHANT_REFUND_RECEIVABLE', '100.00', '0.00'], ['UNCLASSIFIED_ACQUISITION', '0.00', '100.00']]);
  assert.equal(entries.some((entry) => entry.derivationRule === LEDGER_RULES.REFUND), false);
});

test('standalone purchase creates balanced new-money acquisition postings', () => {
  const entries = deriveLedgerEntries({
    events: [event(12, 'PURCHASE', 'STANDALONE_PURCHASE_V1', '2350.00')],
    evidence: [{ event_id: 12, evidence_id: 120, receipt_id: 12, normalization_version: 'fiscal-normalizer-v1', date_time: '2026-01-01T00:00:00Z', normalization_status: 'READY', cash_total_sum: '0.00', ecash_total_sum: '2350.00', payment_components_status: 'RECONCILED' }],
    allocations: [],
    edges: [],
  });
  assert.equal(entries[0].derivationRule, LEDGER_RULES.STANDALONE_PURCHASE);
  assert.equal(entries[0].derivationStatus, 'READY');
  assert.deepEqual(entries[0].postings.map((posting) => [posting.account, posting.debit, posting.credit]), [['UNCLASSIFIED_ACQUISITION', '2350.00', '0.00'], ['FISCAL_PAYMENT_CLEARING', '0.00', '2350.00']]);
});

test('unsupported confirmed event is explicit and blocked', () => {
  const entries = deriveLedgerEntries({ events: [event(20, 'PAYMENT', 'OTHER_RULE', '10.00')], evidence: [], allocations: [], edges: [] });
  assert.equal(entries[0].derivationRule, LEDGER_RULES.UNSUPPORTED);
  assert.equal(entries[0].derivationStatus, 'BLOCKED');
  assert.deepEqual(entries[0].postings, []);
});

test('projection summary is deterministic and balanced by construction', () => {
  const entries = deriveLedgerEntries({ events: [event(1, 'PREPAYMENT', 'PREPAYMENT_SETTLEMENT_V1', '10.00')], evidence: [], allocations: [], edges: [] });
  const summary = summarizeLedgerProjection({ entries });
  assert.equal(summary.entries, 1);
  assert.equal(summary.postings, 2);
  assert.equal(summary.byRule[LEDGER_RULES.PREPAYMENT].debit, 10);
  assert.equal(summary.byRule[LEDGER_RULES.PREPAYMENT].credit, 10);
});

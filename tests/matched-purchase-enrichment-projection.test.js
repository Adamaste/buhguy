import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEDGER_DISPOSITIONS,
  MATCHED_PURCHASE_ENRICHMENT_STATUSES,
  PURCHASE_IDENTITY_DISPOSITIONS,
  loadMatchedPurchaseEnrichment,
  projectMatchedPurchaseEnrichment,
} from '../src/matched-purchase-enrichment-projection.js';

const match = (overrides = {}) => ({
  modelVersion: 'bank-receipt-matching-v1',
  matchStatus: 'MATCHED',
  matchKey: 'a'.repeat(64),
  relationshipType: 'RECEIPT_EVIDENCE_FOR_BANK_PURCHASE',
  scopeKey: 'scope-a', amount: '100.00', currency: 'RUB',
  bank: { ledgerKey: 'b'.repeat(64), candidateKey: 'c'.repeat(64), journalKey: 'd'.repeat(64), bankTransactionId: 11, financialAccountId: 7, occurredAt: '2026-10-05T10:00:00.000Z' },
  receipt: { receiptCandidateKey: 'e'.repeat(64), receiptId: 22, normalizationVersion: 'fiscal-normalizer-v1', normalizedContentSha256: 'f'.repeat(64), dateTime: '2026-10-05T10:00:01.000Z', amount: '100.00', currency: 'RUB' },
  ...overrides,
});
const event = (overrides = {}) => ({ id: 31, scope_key: 'scope-a', event_type: 'PURCHASE', resolution_status: 'CONFIRMED', amount: '100.00', currency: 'RUB', ...overrides });
const evidence = (overrides = {}) => ({ event_id: 31, receipt_id: 22, normalization_version: 'fiscal-normalizer-v1', ...overrides });
const fiscalLedger = (overrides = {}) => ({ id: 41, source_event_id: 31, scopeKey: 'scope-a', currency: 'RUB', derivationRule: 'LEDGER_STANDALONE_PURCHASE_V1', derivationStatus: 'READY', postings: [
  { side: 'DEBIT', account: 'UNCLASSIFIED_ACQUISITION', amount: '100.00', currency: 'RUB' },
  { side: 'CREDIT', account: 'FISCAL_PAYMENT_CLEARING', amount: '100.00', currency: 'RUB' },
], ...overrides });

test('reuses one compatible confirmed purchase and plans fiscal funding refinement', () => {
  const result = projectMatchedPurchaseEnrichment({ match: match(), existingPurchaseEvents: [event()], existingPurchaseEvidence: [evidence()], existingLedgerEntries: [fiscalLedger()] });
  assert.equal(result.projectionStatus, MATCHED_PURCHASE_ENRICHMENT_STATUSES.PROJECTED);
  assert.equal(result.purchaseIdentity.disposition, PURCHASE_IDENTITY_DISPOSITIONS.REUSE_EXISTING_PURCHASE);
  assert.equal(result.ledgerDisposition, LEDGER_DISPOSITIONS.REFINE_EXISTING_FISCAL_FUNDING);
  assert.deepEqual(result.targetLedgerPlan.postings.map(({ side, account, amount, currency }) => ({ side, account, amount, currency })), [
    { side: 'DEBIT', account: { type: 'CODE', code: 'UNCLASSIFIED_ACQUISITION' }, amount: '100.00', currency: 'RUB' },
    { side: 'CREDIT', account: { type: 'FINANCIAL_ACCOUNT', financialAccountId: 7 }, amount: '100.00', currency: 'RUB' },
  ]);
});

test('proposes a deterministic purchase without an existing event', () => {
  const first = projectMatchedPurchaseEnrichment({ match: match() });
  const second = projectMatchedPurchaseEnrichment({ match: match() });
  assert.equal(first.purchaseIdentity.disposition, PURCHASE_IDENTITY_DISPOSITIONS.PROPOSE_NEW_PURCHASE);
  assert.equal(first.enrichmentKey, second.enrichmentKey);
  assert.equal(first.purchaseIdentity.identityKey, second.purchaseIdentity.identityKey);
  assert.equal(first.ledgerDisposition, LEDGER_DISPOSITIONS.FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED);
});

test('ignores rejected and superseded purchase history for active identity', () => {
  const result = projectMatchedPurchaseEnrichment({
    match: match(),
    existingPurchaseEvents: [event({ resolution_status: 'REJECTED' }), event({ id: 32, resolution_status: 'SUPERSEDED' })],
    existingPurchaseEvidence: [evidence(), evidence({ event_id: 32 })],
  });
  assert.equal(result.purchaseIdentity.disposition, PURCHASE_IDENTITY_DISPOSITIONS.PROPOSE_NEW_PURCHASE);
});

test('is input-order independent and changes key when account or match evidence changes', () => {
  const base = projectMatchedPurchaseEnrichment({ match: match(), existingPurchaseEvents: [event()], existingPurchaseEvidence: [evidence()], existingLedgerEntries: [fiscalLedger()] });
  const reordered = projectMatchedPurchaseEnrichment({ match: match(), existingPurchaseEvents: [event()], existingPurchaseEvidence: [evidence()], existingLedgerEntries: [fiscalLedger()] });
  const changed = projectMatchedPurchaseEnrichment({ match: match({ bank: { ...match().bank, financialAccountId: 8 } }) });
  assert.equal(base.enrichmentKey, reordered.enrichmentKey);
  assert.notEqual(base.enrichmentKey, changed.enrichmentKey);
});

test('fails closed for competing, contradictory, or malformed state', () => {
  assert.equal(projectMatchedPurchaseEnrichment({ match: match(), existingPurchaseEvents: [event(), event({ id: 32 })], existingPurchaseEvidence: [evidence(), evidence({ event_id: 32 })] }).reasonCode, 'MULTIPLE_ACTIVE_PURCHASE_EVENTS');
  assert.equal(projectMatchedPurchaseEnrichment({ match: match(), existingPurchaseEvents: [event({ amount: '101.00' })], existingPurchaseEvidence: [evidence()] }).reasonCode, 'PURCHASE_AMOUNT_CONTRADICTION');
  assert.equal(projectMatchedPurchaseEnrichment({ match: match(), existingPurchaseEvents: [event({ currency: 'USD' })], existingPurchaseEvidence: [evidence()] }).reasonCode, 'PURCHASE_CURRENCY_CONTRADICTION');
  assert.equal(projectMatchedPurchaseEnrichment({ match: match(), existingPurchaseEvents: [event()], existingPurchaseEvidence: [evidence()], existingLedgerEntries: [fiscalLedger({ postings: [] })] }).reasonCode, 'LEDGER_CONFLICT');
  assert.equal(projectMatchedPurchaseEnrichment({ match: match(), existingPurchaseEvents: [event()], existingPurchaseEvidence: [evidence()], existingLedgerEntries: [fiscalLedger(), fiscalLedger({ id: 42 })] }).reasonCode, 'LEDGER_CONFLICT');
  assert.equal(projectMatchedPurchaseEnrichment({ match: { ...match(), matchStatus: 'UNMATCHED' } }).projectionStatus, MATCHED_PURCHASE_ENRICHMENT_STATUSES.BLOCKED);
  for (const forged of [
    { modelVersion: 'stale-matcher-v0' },
    { bank: { ...match().bank, journalKey: 'not-a-hash' } },
    { receipt: { ...match().receipt, receiptCandidateKey: 'not-a-hash' } },
    { bank: { ...match().bank, candidateKey: undefined } },
  ]) assert.equal(projectMatchedPurchaseEnrichment({ match: { ...match(), ...forged } }).reasonCode, 'MATCH_CONTRACT_INVALID');
});

test('ledger conflict always exposes the matching ledger disposition', () => {
  const result = projectMatchedPurchaseEnrichment({
    match: match(), existingPurchaseEvents: [event()], existingPurchaseEvidence: [evidence()],
    existingLedgerEntries: [fiscalLedger({ postings: [] })],
  });
  assert.equal(result.projectionStatus, MATCHED_PURCHASE_ENRICHMENT_STATUSES.BLOCKED);
  assert.equal(result.reasonCode, 'LEDGER_CONFLICT');
  assert.equal(result.ledgerDisposition, LEDGER_DISPOSITIONS.LEDGER_CONFLICT);
});

test('preserves both times, ownership boundary, exact money, and no second ledger entry', () => {
  const input = { match: match(), existingPurchaseEvents: [event()], existingPurchaseEvidence: [evidence()] };
  const before = JSON.stringify(input);
  const result = projectMatchedPurchaseEnrichment(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.bankOccurredAt, '2026-10-05T10:00:00.000Z');
  assert.equal(result.receiptDateTime, '2026-10-05T10:00:01.000Z');
  assert.equal(result.targetLedgerPlan.amount, '100.00');
  assert.equal(result.targetLedgerPlan.postings.length, 2);
  assert.equal(result.sourceProvenance.payerPersonId, undefined);
  assert.equal(result.persistenceBoundary.persistenceAllowed, true);
  assert.deepEqual(result.persistenceBoundary.blockedBySchemaBoundaries, []);
});

test('loader calls matching once and only issues SELECT reads', async () => {
  const calls = [];
  let matchingCalls = 0;
  const pool = { query: async (sql, params) => {
    calls.push(sql);
    if (/FROM business_events/i.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql} ${JSON.stringify(params)}`);
  } };
  const result = await loadMatchedPurchaseEnrichment(pool, {
    matchKey: 'a'.repeat(64),
    matchingLoader: async () => { matchingCalls += 1; return { matches: [match()] }; },
  });
  assert.equal(result.purchaseIdentity.disposition, PURCHASE_IDENTITY_DISPOSITIONS.PROPOSE_NEW_PURCHASE);
  assert.equal(matchingCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls.every((sql) => /^\s*SELECT/i.test(sql)), true);
  assert.equal(calls.some((sql) => /INSERT|UPDATE|DELETE/i.test(sql)), false);
});

test('loader deduplicates evidence rows and exposes cross-scope purchase state', async () => {
  const queries = [];
  let includeCrossScope = false;
  const pool = { query: async (sql) => {
    queries.push(sql);
    if (/FROM business_events/i.test(sql)) return { rows: includeCrossScope ? [event(), event({ id: 32, scope_key: 'scope-b' })] : [event()] };
    if (/FROM business_event_evidence/i.test(sql)) return { rows: includeCrossScope ? [evidence(), evidence({ id: 2, event_id: 32 })] : [evidence(), evidence({ id: 2 })] };
    if (/FROM ledger_entries/i.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const result = await loadMatchedPurchaseEnrichment(pool, {
    matchKey: 'a'.repeat(64),
    matchingLoader: async () => ({ matches: [match()] }),
  });
  assert.equal(result.purchaseIdentity.disposition, PURCHASE_IDENTITY_DISPOSITIONS.REUSE_EXISTING_PURCHASE);
  assert.equal(queries.length, 3);
  assert.match(queries[0], /DISTINCT ON \(e\.id\)/i);
  assert.match(queries[0], /EXISTS/i);
  assert.doesNotMatch(queries[0], /scope_key=\$1/i);

  includeCrossScope = true;
  const crossScope = await loadMatchedPurchaseEnrichment(pool, {
    matchKey: 'a'.repeat(64),
    matchingLoader: async () => ({ matches: [match()] }),
  });
  assert.equal(crossScope.projectionStatus, MATCHED_PURCHASE_ENRICHMENT_STATUSES.BLOCKED);
  assert.equal(crossScope.reasonCode, 'MULTIPLE_ACTIVE_PURCHASE_EVENTS');
});

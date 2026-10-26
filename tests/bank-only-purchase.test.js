import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveLedgerEntries } from '../src/ledger.js';
import {
  BANK_ONLY_PURCHASE_EVIDENCE_ROLE,
  BANK_ONLY_PURCHASE_EVENT_RULE,
  BANK_ONLY_PURCHASE_VERSION,
  bankOnlyEvidenceSemanticKey,
  bankOnlyEvidenceSha256,
  isValidBankOnlyPurchaseEvidence,
} from '../src/bank-only-purchase-contract.js';
import {
  BANK_ONLY_PURCHASE_LEDGER_ENABLED_ENV,
  BANK_ONLY_PURCHASE_LEDGER_SCOPE_ENV,
  BANK_ONLY_PURCHASE_LEDGER_START_AT_ENV,
  BANK_ONLY_PURCHASE_ALFA_START_AT_ENV,
  readBankOnlyPurchaseLedgerOptIn,
} from '../src/bank-only-purchase.js';

function validPair(provider = 'bank.example') {
  const event = {
    id: 42,
    scope_id: 7,
    scope_key: 'default',
    event_type: 'PURCHASE',
    resolution_status: 'CONFIRMED',
    origin: 'SYSTEM_DERIVED',
    graph_model_version: 'business-graph-v1',
    rule_code: BANK_ONLY_PURCHASE_EVENT_RULE,
    rule_version: BANK_ONLY_PURCHASE_VERSION,
    amount: '83.41',
    currency: 'RUB',
    created_at: '2026-10-20T09:00:00.000Z',
  };
  const snapshot = {
    modelVersion: BANK_ONLY_PURCHASE_VERSION,
    bankTransactionId: 84,
    observationId: 85,
    provider,
    eventType: 'PURCHASE',
    direction: 'DEBIT',
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    amount: '83.41',
    currency: 'RUB',
    occurredAt: '2026-10-20T09:00:00.000Z',
    receiptMatchStatusAtWrite: 'UNMATCHED',
    scopeKey: 'default',
    financialAccountId: 9,
    accountResolutionState: 'EXACT',
    accountResolutionProvenance: 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT',
    accountProofMethod: 'SOURCE_PROVIDER_BINDING',
    sourceProviderBindingVerified: true,
    tbankCardSpecificAccountProofVerified: false,
    accountReferenceKind: null,
    paymentInstrumentId: null,
    paymentInstrumentResolutionState: null,
    paymentInstrumentResolutionProvenance: null,
    paymentInstrumentAccountMatchesResolvedAccount: false,
    referenceTargetsResolvedInstrument: false,
    uniqueCardReferenceInstrumentCount: 0,
    candidateKey: 'a'.repeat(64),
    journalKey: 'b'.repeat(64),
    ownerRelations: [{ personId: 11, personScopeKey: 'default', relationType: 'OWNER', provenance: 'USER_CONFIRMED' }],
  };
  if (provider === 'com.idamob.tinkoff.android') Object.assign(snapshot, {
    accountResolutionProvenance: 'OBSERVED_PROVIDER_REFERENCE',
    accountProofMethod: 'TBANK_CARD_SPECIFIC',
    sourceProviderBindingVerified: false,
    tbankCardSpecificAccountProofVerified: true,
    accountReferenceKind: 'MASKED_CARD',
    paymentInstrumentId: 13,
    paymentInstrumentResolutionState: 'EXACT',
    paymentInstrumentResolutionProvenance: 'OBSERVED_PROVIDER_REFERENCE',
    paymentInstrumentAccountMatchesResolvedAccount: true,
    referenceTargetsResolvedInstrument: true,
    uniqueCardReferenceInstrumentCount: 1,
  });
  const evidence = {
    id: 99,
    scope_id: 7,
    business_event_id: event.id,
    bank_receipt_match_id: null,
    bank_transaction_id: 84,
    financial_account_id: 9,
    evidence_role: BANK_ONLY_PURCHASE_EVIDENCE_ROLE,
    rule_version: BANK_ONLY_PURCHASE_VERSION,
    evidence_snapshot: snapshot,
  };
  evidence.evidence_sha256 = bankOnlyEvidenceSha256(snapshot);
  evidence.semantic_key = bankOnlyEvidenceSemanticKey({
    scopeId: evidence.scope_id,
    eventId: evidence.business_event_id,
    bankTransactionId: evidence.bank_transaction_id,
    evidenceSha256: evidence.evidence_sha256,
  });
  return { event, evidence };
}

test('bank-only purchase opt-in is disabled by default and requires an explicit scope and cutoff', () => {
  assert.deepEqual(readBankOnlyPurchaseLedgerOptIn({}), { enabled: false, reasonCode: 'DISABLED' });
  assert.deepEqual(readBankOnlyPurchaseLedgerOptIn({ [BANK_ONLY_PURCHASE_LEDGER_ENABLED_ENV]: 'true' }), { enabled: false, reasonCode: 'CONFIG_INVALID' });
  const enabled = readBankOnlyPurchaseLedgerOptIn({
    [BANK_ONLY_PURCHASE_LEDGER_ENABLED_ENV]: 'true',
    [BANK_ONLY_PURCHASE_LEDGER_SCOPE_ENV]: 'default',
    [BANK_ONLY_PURCHASE_LEDGER_START_AT_ENV]: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.scopeKey, 'default');
  assert.equal(enabled.alfaStartAt, null);
  assert.equal(enabled.maxWrites, 25);

  const alfaEnabled = readBankOnlyPurchaseLedgerOptIn({
    [BANK_ONLY_PURCHASE_LEDGER_ENABLED_ENV]: 'true',
    [BANK_ONLY_PURCHASE_LEDGER_SCOPE_ENV]: 'default',
    [BANK_ONLY_PURCHASE_LEDGER_START_AT_ENV]: '2026-10-20T00:00:00.000Z',
    [BANK_ONLY_PURCHASE_ALFA_START_AT_ENV]: '2026-10-26T12:00:00.000Z',
  });
  assert.equal(alfaEnabled.alfaStartAt, '2026-10-26T12:00:00.000Z');
});

test('evidence contract accepts exact source/provider binding and T-Bank card-specific proof', () => {
  const regular = validPair();
  assert.equal(isValidBankOnlyPurchaseEvidence(regular.event, regular.evidence), true);
  const tbank = validPair('com.idamob.tinkoff.android');
  assert.equal(isValidBankOnlyPurchaseEvidence(tbank.event, tbank.evidence), true);
});

test('evidence contract fails closed on non-purchase, non-debit, non-exact, mismatched event, or missing ownership proof', () => {
  const mutations = [
    (pair) => { pair.event.event_type = 'TRANSFER'; },
    (pair) => { pair.evidence.evidence_snapshot.direction = 'CREDIT'; },
    (pair) => { pair.evidence.evidence_snapshot.normalizationStatus = 'PARTIAL'; },
    (pair) => { pair.evidence.evidence_snapshot.evidenceQuality = 'PARTIAL'; },
    (pair) => { pair.evidence.evidence_snapshot.receiptMatchStatusAtWrite = 'UNKNOWN_STATUS'; },
    (pair) => { pair.evidence.business_event_id += 1; },
    (pair) => { pair.evidence.evidence_snapshot.ownerRelations = []; },
    (pair) => { pair.evidence.evidence_snapshot.ownerRelations.push({ ...pair.evidence.evidence_snapshot.ownerRelations[0] }); },
  ];
  for (const mutate of mutations) {
    const pair = validPair();
    mutate(pair);
    pair.evidence.evidence_sha256 = bankOnlyEvidenceSha256(pair.evidence.evidence_snapshot);
    pair.evidence.semantic_key = bankOnlyEvidenceSemanticKey({
      scopeId: pair.evidence.scope_id,
      eventId: pair.evidence.business_event_id,
      bankTransactionId: pair.evidence.bank_transaction_id,
      evidenceSha256: pair.evidence.evidence_sha256,
    });
    assert.equal(isValidBankOnlyPurchaseEvidence(pair.event, pair.evidence), false);
  }
});

test('T-Bank evidence requires exact card reference, unique instrument, and instrument-to-account proof', () => {
  for (const mutate of [
    (snapshot) => { snapshot.accountReferenceKind = 'MASKED_ACCOUNT'; },
    (snapshot) => { snapshot.paymentInstrumentResolutionState = 'UNKNOWN'; },
    (snapshot) => { snapshot.uniqueCardReferenceInstrumentCount = 2; },
    (snapshot) => { snapshot.referenceTargetsResolvedInstrument = false; },
    (snapshot) => { snapshot.paymentInstrumentAccountMatchesResolvedAccount = false; },
    (snapshot) => { snapshot.tbankCardSpecificAccountProofVerified = false; },
  ]) {
    const pair = validPair('com.idamob.tinkoff.android');
    mutate(pair.evidence.evidence_snapshot);
    pair.evidence.evidence_sha256 = bankOnlyEvidenceSha256(pair.evidence.evidence_snapshot);
    pair.evidence.semantic_key = bankOnlyEvidenceSemanticKey({
      scopeId: pair.evidence.scope_id,
      eventId: pair.evidence.business_event_id,
      bankTransactionId: pair.evidence.bank_transaction_id,
      evidenceSha256: pair.evidence.evidence_sha256,
    });
    assert.equal(isValidBankOnlyPurchaseEvidence(pair.event, pair.evidence), false);
  }
});

test('bank-only ledger derivation creates one unclassified acquisition linked to its exact bank transaction', () => {
  const pair = validPair();
  const [entry] = deriveLedgerEntries({
    events: [pair.event], evidence: [], allocations: [], edges: [], bankEvidence: [pair.evidence],
  });
  assert.equal(entry.derivationRule, 'LEDGER_BANK_ONLY_PURCHASE_V1');
  assert.equal(entry.derivationStatus, 'READY');
  assert.equal(entry.reasonCode, 'PROOF_QUALIFIED_BANK_PURCHASE');
  assert.equal(entry.eventAt, pair.evidence.evidence_snapshot.occurredAt);
  assert.equal(entry.postings.length, 2);
  assert.deepEqual(entry.postings.map((posting) => [posting.account, posting.debit, posting.credit]), [
    ['UNCLASSIFIED_ACQUISITION', '83.41', '0.00'],
    ['FINANCIAL_ACCOUNT:9', '0.00', '83.41'],
  ]);
  assert.deepEqual(entry.links, [{ role: 'BANK_ONLY_PURCHASE', bankTransactionId: 84 }]);
});

test('bank-only ledger derivation preserves exact decimal text for large supported amounts', () => {
  const pair = validPair();
  pair.event.amount = '99999999999999.99';
  pair.evidence.evidence_snapshot.amount = pair.event.amount;
  pair.evidence.evidence_sha256 = bankOnlyEvidenceSha256(pair.evidence.evidence_snapshot);
  pair.evidence.semantic_key = bankOnlyEvidenceSemanticKey({
    scopeId: pair.evidence.scope_id,
    eventId: pair.evidence.business_event_id,
    bankTransactionId: pair.evidence.bank_transaction_id,
    evidenceSha256: pair.evidence.evidence_sha256,
  });
  const [entry] = deriveLedgerEntries({ events: [pair.event], evidence: [], allocations: [], edges: [], bankEvidence: [pair.evidence] });
  assert.equal(entry.postings[0].debit, '99999999999999.99');
  assert.equal(entry.postings[1].credit, '99999999999999.99');
});

test('invalid bank-only ledger evidence is blocked rather than turned into a purchase', () => {
  const pair = validPair();
  pair.evidence.evidence_snapshot.direction = 'CREDIT';
  pair.evidence.evidence_sha256 = bankOnlyEvidenceSha256(pair.evidence.evidence_snapshot);
  const [entry] = deriveLedgerEntries({ events: [pair.event], evidence: [], allocations: [], edges: [], bankEvidence: [pair.evidence] });
  assert.equal(entry.derivationStatus, 'BLOCKED');
  assert.equal(entry.reasonCode, 'BANK_ONLY_PURCHASE_EVIDENCE_INVALID');
  assert.deepEqual(entry.postings, []);
});

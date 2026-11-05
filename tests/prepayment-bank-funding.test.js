import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidPrepaymentBankFundingEvidence,
  PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE,
  PREPAYMENT_BANK_FUNDING_VERSION,
  prepaymentBankFundingSemanticKey,
  prepaymentBankFundingSha256,
} from '../src/prepayment-bank-funding-contract.js';

function fixture(provider = 'bank.example') {
  const event = {
    id: 41, scope_id: 1, scope_key: 'scope-test', event_type: 'PREPAYMENT',
    resolution_status: 'CONFIRMED', origin: 'SYSTEM_DERIVED', graph_model_version: 'business-graph-v1',
    rule_code: 'PREPAYMENT_SETTLEMENT_V1', rule_version: 'prepayment-settlement-matcher-v2', amount: '100.00', currency: null,
  };
  const snapshot = {
    modelVersion: PREPAYMENT_BANK_FUNDING_VERSION, scopeKey: 'scope-test', prepaymentEventId: 41, receiptId: 7,
    bankTransactionId: 99, observationId: 88, provider, eventType: 'PURCHASE', direction: 'DEBIT',
    normalizationStatus: 'READY', paymentComponentsStatus: 'RECONCILED', evidenceQuality: 'EXACT', paymentStage: 'PREPAYMENT_ONLY',
    settlementPaymentStage: 'SETTLEMENT_ONLY', fiscalOperationType: 1,
    amount: '100.00', currency: 'RUB', occurredAt: '2026-11-02T12:00:00.000Z',
    observedAt: '2026-11-02T12:00:01.000Z', prepaymentReceiptAt: '2026-11-02T12:00:00.000Z',
    prepaymentEventCreatedAt: '2026-11-02T11:59:00.000Z', prepaymentSourceObservedAt: '2026-11-02T11:59:00.000Z',
    settlementSourceObservedAt: '2026-11-02T12:02:00.000Z', cohortStartAt: '2026-11-02T11:58:00.000Z',
    timeDeltaMs: 0, financialAccountId: 5, accountResolutionState: 'MANUAL',
    accountResolutionProvenance: 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT',
    accountProofMethod: 'SOURCE_PROVIDER_BINDING', sourceProviderBindingVerified: true,
    tbankCardSpecificAccountProofVerified: false,
    notificationLifecycleIdVerified: provider === 'ru.alfabank.mobile.android',
    accountOwnerScopeProof: { status: 'PROVEN', ownerRelationCount: 1 },
    fnsSourceProven: true, fnsCurrencyBasis: 'FNS_SOURCE_CONTRACT',
    candidateKey: 'a'.repeat(64), journalKey: 'b'.repeat(64),
  };
  const evidenceSha256 = prepaymentBankFundingSha256(snapshot);
  const evidence = {
    evidence_role: PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE,
    rule_version: PREPAYMENT_BANK_FUNDING_VERSION,
    bank_receipt_match_id: null, business_event_id: 41, scope_id: 1,
    bank_transaction_id: 99, financial_account_id: 5,
    evidence_snapshot: snapshot, evidence_sha256: evidenceSha256,
    semantic_key: prepaymentBankFundingSemanticKey({ scopeId: 1, eventId: 41, bankTransactionId: 99, evidenceSha256 }),
  };
  return { event, evidence };
}

test('prepayment bank funding evidence requires complete, scoped and time-bounded proof', () => {
  const value = fixture();
  assert.equal(isValidPrepaymentBankFundingEvidence(value.event, value.evidence), true);

  const wrongAccount = structuredClone(value);
  wrongAccount.evidence.financial_account_id = 6;
  assert.equal(isValidPrepaymentBankFundingEvidence(wrongAccount.event, wrongAccount.evidence), false);

  const oldObservation = structuredClone(value);
  oldObservation.evidence.evidence_snapshot.observedAt = '2026-11-02T11:57:59.000Z';
  oldObservation.evidence.evidence_sha256 = prepaymentBankFundingSha256(oldObservation.evidence.evidence_snapshot);
  oldObservation.evidence.semantic_key = prepaymentBankFundingSemanticKey({ scopeId: 1, eventId: 41, bankTransactionId: 99, evidenceSha256: oldObservation.evidence.evidence_sha256 });
  assert.equal(isValidPrepaymentBankFundingEvidence(oldObservation.event, oldObservation.evidence), false);

  const tooFar = structuredClone(value);
  tooFar.evidence.evidence_snapshot.timeDeltaMs = 300001;
  tooFar.evidence.evidence_sha256 = prepaymentBankFundingSha256(tooFar.evidence.evidence_snapshot);
  tooFar.evidence.semantic_key = prepaymentBankFundingSemanticKey({ scopeId: 1, eventId: 41, bankTransactionId: 99, evidenceSha256: tooFar.evidence.evidence_sha256 });
  assert.equal(isValidPrepaymentBankFundingEvidence(tooFar.event, tooFar.evidence), false);

  const wrongScope = structuredClone(value);
  wrongScope.evidence.evidence_snapshot.scopeKey = 'another-scope';
  wrongScope.evidence.evidence_sha256 = prepaymentBankFundingSha256(wrongScope.evidence.evidence_snapshot);
  wrongScope.evidence.semantic_key = prepaymentBankFundingSemanticKey({ scopeId: 1, eventId: 41, bankTransactionId: 99, evidenceSha256: wrongScope.evidence.evidence_sha256 });
  assert.equal(isValidPrepaymentBankFundingEvidence(wrongScope.event, wrongScope.evidence), false);

  const wrongCurrency = structuredClone(value);
  wrongCurrency.evidence.evidence_snapshot.currency = 'USD';
  wrongCurrency.evidence.evidence_sha256 = prepaymentBankFundingSha256(wrongCurrency.evidence.evidence_snapshot);
  wrongCurrency.evidence.semantic_key = prepaymentBankFundingSemanticKey({ scopeId: 1, eventId: 41, bankTransactionId: 99, evidenceSha256: wrongCurrency.evidence.evidence_sha256 });
  assert.equal(isValidPrepaymentBankFundingEvidence(wrongCurrency.event, wrongCurrency.evidence), false);
});

test('Alfa funding proof requires a valid lifecycle ID without storing the ID value', () => {
  const value = fixture('ru.alfabank.mobile.android');
  assert.equal(value.evidence.evidence_snapshot.notificationLifecycleIdVerified, true);
  assert.equal(JSON.stringify(value.evidence.evidence_snapshot).includes('notificationLifecycleId'), true);
  assert.equal(JSON.stringify(value.evidence.evidence_snapshot).includes('00000000-0000-4000-8000-000000000001'), false);
  assert.equal(isValidPrepaymentBankFundingEvidence(value.event, value.evidence), true);
  const invalid = structuredClone(value);
  invalid.evidence.evidence_snapshot.notificationLifecycleIdVerified = false;
  invalid.evidence.evidence_sha256 = prepaymentBankFundingSha256(invalid.evidence.evidence_snapshot);
  invalid.evidence.semantic_key = prepaymentBankFundingSemanticKey({ scopeId: 1, eventId: 41, bankTransactionId: 99, evidenceSha256: invalid.evidence.evidence_sha256 });
  assert.equal(isValidPrepaymentBankFundingEvidence(invalid.event, invalid.evidence), false);
});

test('ordinary bank transaction identifiers and private notification text are absent from evidence schema', () => {
  const value = fixture();
  const serialized = JSON.stringify(value.evidence.evidence_snapshot);
  assert.doesNotMatch(serialized, /notificationText|rawPayload|merchant|accountReference|cardNumber|otp|secret/i);
  assert.equal(Object.hasOwn(value.evidence.evidence_snapshot, 'notificationLifecycleId'), false);
});

test('invalid explicit funding targets fail before any database access', async () => {
  const { reconcilePrepaymentBankFunding } = await import('../src/prepayment-bank-funding.js');
  for (const targets of [[], {}, [null], [{ prepaymentReceiptId: 1, settlementReceiptId: 2, bankTransactionId: '3' }]]) {
    await assert.rejects(() => reconcilePrepaymentBankFunding({}, { targets }),
      error => error.code === 'PREPAYMENT_FUNDING_TARGETS_INVALID');
  }
});

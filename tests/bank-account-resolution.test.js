import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBankTransactionCoverage, resolveBankTransactionAccount, resolveNewBankTransactionIdentity } from '../src/bank-account-resolution.js';

test('bank transaction coverage keeps resolved and unresolved totals explicit', () => {
  const report = buildBankTransactionCoverage([
    { financialAccountId: 10, resolutionState: 'EXACT' },
    { financialAccountId: 11, resolutionState: 'MANUAL' },
    { financialAccountId: 12, resolutionState: 'RECONCILED' },
    { financialAccountId: null, resolutionState: 'UNKNOWN' },
    { financialAccountId: null, resolutionState: null },
  ]);
  assert.deepEqual(report, {
    totalBankTransactions: 5,
    resolvedAccount: 3,
    unresolvedAccount: 2,
    exact: 1,
    manual: 1,
    reconciled: 1,
    unknown: 2,
    invariant: true,
  });
});

test('resolution state validation is fail-closed', async () => {
  await assert.rejects(() => resolveBankTransactionAccount({}, { bankTransactionId: 1, resolutionState: 'UNKNOWN', financialAccountId: 2, provenance: 'test', reason: 'test' }), /UNKNOWN resolution/);
  await assert.rejects(() => resolveBankTransactionAccount({}, { bankTransactionId: 1, resolutionState: 'MANUAL', provenance: 'test', reason: 'test' }), /requires a financial account/);
});

test('generic resolution cannot assert arbitrary EXACT evidence', async () => {
  await assert.rejects(() => resolveBankTransactionAccount({}, { bankTransactionId: 1, financialAccountId: 2, resolutionState: 'EXACT', provenance: 'manual', reason: 'manual guess' }), /proven account reference evidence/);
});

const TBANK_PROVIDER = 'com.idamob.tinkoff.android';
const exactDebitCard = {
  payment_instrument_id: 31,
  financial_account_id: 41,
  validated_financial_account_id: 41,
  provider: TBANK_PROVIDER,
  instrumentProvider: TBANK_PROVIDER,
  referenceValue: '****7268',
  scopeId: 7,
  instrumentType: 'CARD',
  active: true,
};

function resolverClient({
  provider = TBANK_PROVIDER,
  referenceKind = 'MASKED_CARD',
  reference = '****7268',
  eventType = 'PURCHASE',
  direction = 'DEBIT',
  scopeIds = [7],
  candidates = [exactDebitCard],
  bindingAccountId = null,
} = {}) {
  const accountResolutions = [];
  const instrumentResolutions = [];
  const calls = { candidateLookup: 0, providerBindingLookup: 0 };
  return {
    accountResolutions,
    instrumentResolutions,
    calls,
    async query(sql, params = []) {
      const query = String(sql).trim();
      if (query.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (query.startsWith('SELECT bt.account_reference AS')) {
        return {
          rows: [{
            accountReference: reference,
            accountReferenceKind: referenceKind,
            eventType,
            direction,
            normalizationStatus: 'READY',
            evidenceQuality: 'EXACT',
            bankSourceId: 12,
            provider,
            scope_ids: scopeIds,
          }],
          rowCount: 1,
        };
      }
      if (query.includes('FROM bank_account_references r') && query.includes('validated_financial_account_id')) {
        calls.candidateLookup += 1;
        assert.deepEqual(params, [TBANK_PROVIDER, reference, Number(scopeIds[0])]);
        return {
          rows: candidates.filter((candidate) => candidate.provider === params[0]
            && candidate.instrumentProvider === params[0]
            && candidate.referenceValue === params[1]
            && candidate.scopeId === params[2]
            && candidate.instrumentType === 'CARD'
            && candidate.active),
          rowCount: candidates.length,
        };
      }
      if (query.startsWith('SELECT b.financial_account_id') && query.includes('FROM bank_source_provider_account_bindings')) {
        calls.providerBindingLookup += 1;
        return { rows: bindingAccountId == null ? [] : [{ financial_account_id: bindingAccountId }], rowCount: bindingAccountId == null ? 0 : 1 };
      }
      if (query.startsWith('INSERT INTO bank_transaction_account_resolution')) {
        const [bankTransactionId, financialAccountId, resolutionState, provenance, reason] = params;
        const row = { bankTransactionId, financialAccountId, resolutionState, provenance, reason };
        accountResolutions.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (query.startsWith('INSERT INTO bank_transaction_payment_instrument_resolution')) {
        const [bankTransactionId, paymentInstrumentId, resolutionState, provenance, reason] = params;
        const row = { bankTransactionId, paymentInstrumentId, resolutionState, provenance, reason };
        instrumentResolutions.push(row);
        return { rows: [row], rowCount: 1 };
      }
      throw new Error(`Unexpected resolver query: ${query.slice(0, 90)}`);
    },
  };
}

async function resolveWith(options) {
  const client = resolverClient(options);
  const result = await resolveNewBankTransactionIdentity(client, { bankTransactionId: 55 });
  return { ...result, client };
}

test('T-Bank resolves an exact masked debit card only through its unique active instrument and linked account', async () => {
  const { account, paymentInstrument, client } = await resolveWith({});
  assert.equal(account.resolutionState, 'EXACT');
  assert.equal(account.financialAccountId, 41);
  assert.equal(account.provenance, 'OBSERVED_PROVIDER_REFERENCE');
  assert.equal(paymentInstrument.resolutionState, 'EXACT');
  assert.equal(paymentInstrument.paymentInstrumentId, 31);
  assert.equal(client.calls.candidateLookup, 1);
});

test('T-Bank card mapping must match the exact provider, mask, card type, and scope', async () => {
  const otherCard = { ...exactDebitCard, referenceValue: '****9912', payment_instrument_id: 32 };
  const wrongProvider = { ...exactDebitCard, provider: 'other.provider', instrumentProvider: 'other.provider' };
  const wrongInstrumentProvider = { ...exactDebitCard, instrumentProvider: 'other.provider' };
  const wrongScope = { ...exactDebitCard, scopeId: 8 };
  for (const candidate of [otherCard, wrongProvider, wrongInstrumentProvider, wrongScope]) {
    const { account, paymentInstrument, client } = await resolveWith({ candidates: [candidate] });
    assert.equal(account.resolutionState, 'UNKNOWN');
    assert.equal(account.financialAccountId, null);
    assert.equal(paymentInstrument.resolutionState, 'UNKNOWN');
    assert.equal(client.calls.providerBindingLookup, 0);
  }
});

test('T-Bank credit-card operation with another mask cannot inherit the debit-card account', async () => {
  const { account, client } = await resolveWith({ direction: 'CREDIT', reference: '****9912', candidates: [exactDebitCard] });
  assert.equal(account.resolutionState, 'UNKNOWN');
  assert.equal(account.financialAccountId, null);
  assert.equal(client.calls.providerBindingLookup, 0);
});

test('T-Bank account resolution stays UNKNOWN when the mask or payment instrument is missing', async () => {
  for (const options of [
    { reference: null, referenceKind: 'MASKED_CARD', candidates: [exactDebitCard] },
    { reference: null, referenceKind: null, candidates: [exactDebitCard] },
    { referenceKind: 'OTHER', candidates: [exactDebitCard] },
    { candidates: [] },
  ]) {
    const { account, client } = await resolveWith(options);
    assert.equal(account.resolutionState, 'UNKNOWN');
    assert.equal(account.financialAccountId, null);
    assert.equal(client.calls.providerBindingLookup, 0);
  }
});

test('T-Bank does not persist an instrument resolution when no usable masked-card reference exists', async () => {
  for (const options of [
    { referenceKind: null, reference: null },
    { referenceKind: 'MASKED_CARD', reference: null },
    { referenceKind: 'MASKED_CARD', reference: '' },
  ]) {
    const { account, paymentInstrument, client } = await resolveWith({ ...options, candidates: [] });
    assert.equal(account.resolutionState, 'UNKNOWN');
    assert.equal(account.financialAccountId, null);
    assert.equal(paymentInstrument, null);
    assert.deepEqual(client.instrumentResolutions, []);
    assert.equal(client.calls.providerBindingLookup, 0);
  }
});

test('T-Bank identified instrument without a linked active financial account is not assigned an account', async () => {
  for (const candidate of [
    { ...exactDebitCard, financial_account_id: null, validated_financial_account_id: null },
    { ...exactDebitCard, financial_account_id: 41, validated_financial_account_id: null },
  ]) {
    const { account, paymentInstrument } = await resolveWith({ candidates: [candidate] });
    assert.equal(paymentInstrument.resolutionState, 'EXACT');
    assert.equal(account.resolutionState, 'UNKNOWN');
    assert.equal(account.financialAccountId, null);
  }
});

test('T-Bank multiple matching instruments are ambiguous and do not resolve an account', async () => {
  const second = { ...exactDebitCard, payment_instrument_id: 32, financial_account_id: 42, validated_financial_account_id: 42 };
  const { account, paymentInstrument } = await resolveWith({ candidates: [exactDebitCard, second] });
  assert.equal(paymentInstrument.resolutionState, 'UNKNOWN');
  assert.equal(account.resolutionState, 'UNKNOWN');
  assert.equal(account.financialAccountId, null);
  assert.equal(account.provenance, 'OBSERVED_PROVIDER_REFERENCE_AMBIGUOUS');
});

test('T-Bank conflicts with a provider-wide binding fail closed instead of choosing either account', async () => {
  const { account, paymentInstrument, client } = await resolveWith({ bindingAccountId: 99 });
  assert.equal(paymentInstrument.resolutionState, 'EXACT');
  assert.equal(account.resolutionState, 'UNKNOWN');
  assert.equal(account.financialAccountId, null);
  assert.equal(account.provenance, 'SOURCE_PROVIDER_BINDING_INSTRUMENT_CONFLICT');
  assert.equal(client.calls.providerBindingLookup, 1);
});

test('T-Bank provider-wide fallback is never used for unmasked or unmapped events', async () => {
  const { account, client } = await resolveWith({ reference: null, referenceKind: null, candidates: [], bindingAccountId: 99 });
  assert.equal(account.resolutionState, 'UNKNOWN');
  assert.equal(account.financialAccountId, null);
  assert.equal(client.calls.providerBindingLookup, 0);
});

test('Yandex and Sber retain their confirmed source/provider binding fallback', async () => {
  for (const provider of ['com.yandex.bank', 'ru.sberbankmobile']) {
    const { account, client } = await resolveWith({ provider, reference: null, referenceKind: null, candidates: [], bindingAccountId: 77 });
    assert.equal(account.resolutionState, 'MANUAL');
    assert.equal(account.financialAccountId, 77);
    assert.equal(account.provenance, 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT');
    assert.equal(client.calls.providerBindingLookup, 1);
    assert.equal(client.calls.candidateLookup, 0);
  }
});

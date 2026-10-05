import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANK_LEDGER_PROJECTION_VERSION,
  BANK_LEDGER_SOURCE_STATUSES,
  loadBankLedgerProjection,
  projectBankLedger,
} from '../src/bank-ledger-projection.js';
import { buildBankInternalTransferOwnershipSnapshot } from '../src/bank-internal-transfer-matching.js';
import { projectBankCashFlowTransaction } from '../src/bank-cash-flow-projection.js';
import { projectBalancedBankJournal } from '../src/balanced-bank-journal-projection.js';
import { projectBankBusinessEventCandidate } from '../src/bank-business-event-candidate-projection.js';

const baseRow = (overrides = {}) => ({
  bankTransactionId: 10,
  occurredAt: '2026-10-05T10:00:00.000Z',
  amount: '100.00',
  currency: 'RUB',
  sourceEventType: 'PURCHASE',
  direction: 'DEBIT',
  normalizationStatus: 'READY',
  evidenceQuality: 'EXACT',
  sourceScopeKeys: ['scope-a'],
  accountResolutionState: 'EXACT',
  financialAccountId: 1,
  financialAccountScopeKey: 'scope-a',
  ...overrides,
});

function entry(overrides = {}) {
  const row = baseRow(overrides);
  const journal = projectBalancedBankJournal(projectBankCashFlowTransaction(row));
  return { journal, candidate: projectBankBusinessEventCandidate(journal) };
}

function owner(financialAccountId, personId = 7) {
  return {
    financialAccountId,
    accountScopeKey: 'scope-a',
    personId,
    personScopeKey: 'scope-a',
    relationType: 'OWNER',
    provenance: 'EXPLICIT_TEST',
  };
}

function snapshot(rows = []) { return buildBankInternalTransferOwnershipSnapshot(rows); }

function transferPair() {
  return {
    entries: [
      entry({ bankTransactionId: 10, sourceEventType: 'OUTGOING_TRANSFER', direction: 'DEBIT', financialAccountId: 1 }),
      entry({ bankTransactionId: 11, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT', financialAccountId: 2, occurredAt: '2026-10-05T10:00:05.000Z' }),
    ],
    ownership: snapshot([owner(1), owner(2)]),
  };
}

function assertProjected(result, economicKind) {
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].modelVersion, BANK_LEDGER_PROJECTION_VERSION);
  assert.equal(result.entries[0].projectionStatus, 'PROJECTED');
  assert.equal(result.entries[0].economicKind, economicKind);
  assert.equal(result.entries[0].postings.length, 2);
  assert.deepEqual(result.entries[0].postings.map((posting) => posting.side).sort(), ['CREDIT', 'DEBIT']);
  assert.equal(result.entries[0].postings[0].amount, result.entries[0].postings[1].amount);
  assert.equal(result.entries[0].postings[0].currency, result.entries[0].postings[1].currency);
}

test('purchase preserves the validated two-posting journal and unresolved bank side', () => {
  const result = projectBankLedger([entry({ accountResolutionState: 'UNKNOWN', financialAccountId: null, financialAccountScopeKey: null })], snapshot(), { maxTimeDeltaMs: 10_000 });
  assertProjected(result, 'PURCHASE');
  assert.deepEqual(result.entries[0].postings.map((posting) => posting.account.code ?? posting.account.financialAccountId), ['UNCLASSIFIED_PURCHASE', 'UNRESOLVED_BANK_ACCOUNT']);
  assert.equal(result.sourceStatuses[0].status, BANK_LEDGER_SOURCE_STATUSES.STANDALONE);
});

test('purchase keeps a concrete financial account and does not infer expense semantics', () => {
  const result = projectBankLedger([entry()], snapshot(), { maxTimeDeltaMs: 10_000 });
  assertProjected(result, 'PURCHASE');
  assert.equal(result.entries[0].postings.find((posting) => posting.side === 'CREDIT').account.financialAccountId, 1);
  assert.equal(result.entries[0].economicKind, 'PURCHASE');
});

test('unmatched transfer directions and exact unknown movements remain standalone', () => {
  const rows = [
    entry({ bankTransactionId: 20, sourceEventType: 'OUTGOING_TRANSFER', direction: 'DEBIT' }),
    entry({ bankTransactionId: 21, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT' }),
    entry({ bankTransactionId: 22, sourceEventType: 'UNKNOWN', direction: 'DEBIT' }),
    entry({ bankTransactionId: 23, sourceEventType: 'UNKNOWN', direction: 'CREDIT' }),
  ];
  const result = projectBankLedger(rows, snapshot(), { maxTimeDeltaMs: 10_000 });
  assert.equal(result.entries.length, 4);
  assert.deepEqual(result.entries.map((row) => row.economicKind).sort(), ['INCOMING_TRANSFER', 'OUTGOING_TRANSFER', 'UNCLASSIFIED_MONETARY_MOVEMENT', 'UNCLASSIFIED_MONETARY_MOVEMENT']);
  assert.equal(result.entries.some((row) => row.economicKind === 'INCOME' || row.economicKind === 'EXPENSE'), false);
  assert.equal(result.summary.postings, 8);
});

test('a proven own-account pair collapses into exactly one internal transfer entry', () => {
  const input = transferPair();
  const result = projectBankLedger(input.entries, input.ownership, { maxTimeDeltaMs: 10_000 });
  assertProjected(result, 'INTERNAL_TRANSFER');
  assert.equal(result.entries[0].occurredAt, input.entries[0].candidate.occurredAt);
  assert.equal(result.entries[0].postings.find((posting) => posting.side === 'DEBIT').account.financialAccountId, 2);
  assert.equal(result.entries[0].postings.find((posting) => posting.side === 'CREDIT').account.financialAccountId, 1);
  assert.equal(result.summary.consumedInternalTransferSources, 2);
  assert.equal(result.summary.internalTransferLedgerEntries, 1);
  assert.equal(result.sourceStatuses.filter((row) => row.status === BANK_LEDGER_SOURCE_STATUSES.CONSUMED_INTERNAL_TRANSFER).length, 2);
  assert.equal(result.entries[0].sourceProvenance.incoming.occurredAt, input.entries[1].candidate.occurredAt);
});

test('ambiguous transfers remain standalone and an unmatched transfer remains independent', () => {
  const a = entry({ bankTransactionId: 30, sourceEventType: 'OUTGOING_TRANSFER', direction: 'DEBIT', financialAccountId: 1 });
  const b = entry({ bankTransactionId: 31, sourceEventType: 'OUTGOING_TRANSFER', direction: 'DEBIT', financialAccountId: 2 });
  const c = entry({ bankTransactionId: 32, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT', financialAccountId: 3 });
  const d = entry({ bankTransactionId: 33, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT', financialAccountId: 4, occurredAt: '2026-10-05T11:00:00.000Z' });
  const result = projectBankLedger([a, b, c, d], snapshot([owner(1), owner(2), owner(3), owner(4)]), { maxTimeDeltaMs: 10_000 });
  assert.equal(result.entries.length, 4);
  assert.equal(result.entries.some((row) => row.economicKind === 'INTERNAL_TRANSFER'), false);
  assert.equal(result.summary.standaloneSources, 4);
});

test('invalid journal and tampered candidate are unresolved without a ledger entry', () => {
  const valid = entry();
  const validSecond = entry({ bankTransactionId: 62 });
  const tamperedCandidate = { ...valid, journal: { ...valid.journal, bankTransactionId: 61 }, candidate: { ...valid.candidate, bankTransactionId: 61, amount: '999.00' } };
  const tamperedJournal = { ...validSecond, journal: { ...validSecond.journal, amount: '999.00' } };
  const result = projectBankLedger([tamperedCandidate, tamperedJournal], snapshot(), { maxTimeDeltaMs: 10_000 });
  assert.equal(result.entries.length, 0);
  assert.deepEqual(result.sourceStatuses.map((row) => row.status), ['UNRESOLVED', 'UNRESOLVED']);
});

test('fake caller-supplied INTERNAL_TRANSFER cannot inject output', () => {
  const valid = entry();
  const fake = { ...valid, candidate: { ...valid.candidate, candidateKind: 'TRANSFER', businessEventType: 'INTERNAL_TRANSFER', transferDirection: null } };
  const result = projectBankLedger([fake], snapshot(), { maxTimeDeltaMs: 10_000 });
  assert.equal(result.entries.length, 0);
  assert.equal(JSON.stringify(result).includes('INTERNAL_TRANSFER'), false);
});

test('duplicate source identities are rejected and inputs remain unchanged', () => {
  const first = entry();
  const second = entry({ bankTransactionId: 11 });
  second.journal.journalKey = first.journal.journalKey;
  assert.throws(() => projectBankLedger([first, second], snapshot(), { maxTimeDeltaMs: 10_000 }), /duplicate journalKey/);
  const pair = transferPair();
  const before = structuredClone(pair);
  const result = projectBankLedger(pair.entries, pair.ownership, { maxTimeDeltaMs: 10_000 });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(pair, before);
});

test('ledger keys are deterministic, content-sensitive, and input-order independent', () => {
  const first = entry({ bankTransactionId: 40, amount: '1234567890123456.78', currency: 'USD' });
  const second = entry({ bankTransactionId: 41, amount: '101.00' });
  const one = projectBankLedger([first, second], snapshot(), { maxTimeDeltaMs: 10_000 });
  const two = projectBankLedger([second, first], snapshot(), { maxTimeDeltaMs: 10_000 });
  assert.deepEqual(one.entries, two.entries);
  assert.equal(one.entries.find((row) => row.amount === '1234567890123456.78').amount, '1234567890123456.78');
  assert.notEqual(one.entries[0].ledgerKey, projectBankLedger([entry({ bankTransactionId: 40, amount: '1234567890123456.79', currency: 'USD' })], snapshot(), { maxTimeDeltaMs: 10_000 }).entries[0].ledgerKey);
});

test('account refinement changes the bank ledger content key', () => {
  const unresolved = entry({ bankTransactionId: 45, accountResolutionState: 'UNKNOWN', financialAccountId: null, financialAccountScopeKey: null });
  const concrete = entry({ bankTransactionId: 45, accountResolutionState: 'EXACT', financialAccountId: 1 });
  const unresolvedResult = projectBankLedger([unresolved], snapshot(), { maxTimeDeltaMs: 10_000 });
  const concreteResult = projectBankLedger([concrete], snapshot(), { maxTimeDeltaMs: 10_000 });
  assert.notEqual(unresolvedResult.entries[0].ledgerKey, concreteResult.entries[0].ledgerKey);
  assert.notDeepEqual(unresolvedResult.entries[0].postings, concreteResult.entries[0].postings);
});

test('zero and noncanonical money fail closed, while multi-currency survives', () => {
  const zero = entry({ bankTransactionId: 70, amount: '0.00' });
  const noncanonical = { ...entry({ bankTransactionId: 71 }), journal: { ...entry({ bankTransactionId: 71 }).journal, amount: '1' } };
  const usd = entry({ bankTransactionId: 72, amount: '1.20', currency: 'USD' });
  const result = projectBankLedger([zero, noncanonical, usd], snapshot(), { maxTimeDeltaMs: 10_000 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].currency, 'USD');
  assert.equal(result.summary.unresolvedSources, 2);
});

test('loader calls balanced-journal and ownership loaders once with transfer accounts only', async () => {
  const rows = [
    baseRow({ bankTransactionId: 50, sourceEventType: 'OUTGOING_TRANSFER', direction: 'DEBIT', financialAccountId: 1 }),
    baseRow({ bankTransactionId: 51, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT', financialAccountId: 2, occurredAt: '2026-10-05T10:00:05.000Z' }),
    baseRow({ bankTransactionId: 52, sourceEventType: 'PURCHASE', direction: 'DEBIT', financialAccountId: 9 }),
  ];
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM financial_accounts a/i.test(sql)) return { rows: [owner(1), owner(2)] };
    return { rows };
  } };
  const result = await loadBankLedgerProjection(pool, { scopeKey: 'scope-a', maxTimeDeltaMs: 10_000 });
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries.filter((row) => row.economicKind === 'INTERNAL_TRANSFER').length, 1);
  const ownershipCall = calls.find(({ sql }) => /FROM financial_accounts a/i.test(sql));
  assert.deepEqual(ownershipCall.params, [[1, 2]]);
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ sql }) => !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)), true);
});

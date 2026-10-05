import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANK_INTERNAL_TRANSFER_MATCHING_VERSION,
  INTERNAL_TRANSFER_MATCH_STATUSES,
  buildBankInternalTransferOwnershipSnapshot,
  loadBankInternalTransferOwnershipSnapshot,
  matchBankInternalTransfers,
} from '../src/bank-internal-transfer-matching.js';
import { projectBankCashFlowTransaction } from '../src/bank-cash-flow-projection.js';
import { projectBalancedBankJournal } from '../src/balanced-bank-journal-projection.js';
import { projectBankBusinessEventCandidate } from '../src/bank-business-event-candidate-projection.js';

const bankRow = (overrides = {}) => ({
  bankTransactionId: 10,
  occurredAt: '2026-10-05T10:00:00.000Z',
  amount: '100.00',
  currency: 'RUB',
  sourceEventType: 'OUTGOING_TRANSFER',
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
  const row = bankRow(overrides);
  const journal = projectBalancedBankJournal(projectBankCashFlowTransaction(row));
  return { candidate: projectBankBusinessEventCandidate(journal), journal };
}

function ownership(rows) {
  return buildBankInternalTransferOwnershipSnapshot(rows);
}

function owner(financialAccountId, personId, overrides = {}) {
  return {
    financialAccountId,
    accountScopeKey: 'scope-a',
    personId,
    personScopeKey: 'scope-a',
    relationType: 'OWNER',
    provenance: 'EXPLICIT_TEST',
    ...overrides,
  };
}

function pair(overrides = {}, incomingOverrides = {}, ownerRows = [owner(1, 7), owner(2, 7)]) {
  return {
    entries: [
      entry({ bankTransactionId: 10, financialAccountId: 1, ...overrides }),
      entry({
        bankTransactionId: 11,
        financialAccountId: 2,
        sourceEventType: 'INCOMING_TRANSFER',
        direction: 'CREDIT',
        occurredAt: '2026-10-05T10:00:05.000Z',
        ...incomingOverrides,
      }),
    ],
    snapshot: ownership(ownerRows),
  };
}

function run(entries, snapshot, maxTimeDeltaMs = 10_000) {
  return matchBankInternalTransfers(entries, snapshot, { maxTimeDeltaMs });
}

test('two proven opposite transfers produce exactly one internal transfer match', () => {
  const input = pair();
  const result = run(input.entries, input.snapshot);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].modelVersion, BANK_INTERNAL_TRANSFER_MATCHING_VERSION);
  assert.equal(result.matches[0].businessEventType, 'INTERNAL_TRANSFER');
  assert.equal(result.summary.matchedTransfers, 2);
  assert.equal(result.summary.internalTransferMatches, 1);
  assert.equal(result.matches[0].ownerPersonId, 7);
  assert.equal(result.matches[0].amount, '100.00');
  assert.equal(result.matches[0].currency, 'RUB');
  assert.equal('expense' in result.matches[0], false);
  assert.equal('income' in result.matches[0], false);
});

test('upstream candidates remain unchanged and one-sided transfers never become internal', () => {
  const input = pair();
  const before = structuredClone(input.entries[0]);
  const result = run(input.entries.slice(0, 1), input.snapshot);
  assert.deepEqual(input.entries[0], before);
  assert.equal(result.matches.length, 0);
  assert.equal(result.candidateStatuses[0].status, INTERNAL_TRANSFER_MATCH_STATUSES.UNMATCHED);
  assert.equal(JSON.stringify(result).includes('INTERNAL_TRANSFER'), false);
});

test('unresolved, same-account, amount, currency, scope, and account-scope mismatches fail closed', () => {
  const base = pair();
  const cases = [
    pair({}, {}, [owner(1, 7)]),
    pair({}, { financialAccountId: 1 }, [owner(1, 7)]),
    pair({}, { amount: '101.00' }),
    pair({}, { currency: 'USD' }),
    pair({}, { sourceScopeKeys: ['scope-b'], financialAccountScopeKey: 'scope-b' }, [owner(1, 7), owner(2, 7, { accountScopeKey: 'scope-b', personScopeKey: 'scope-b' })]),
    pair({}, {}, [owner(1, 7), owner(2, 7, { accountScopeKey: 'scope-b', personScopeKey: 'scope-b' })]),
  ];
  cases[0].entries[0] = entry({ accountResolutionState: 'UNKNOWN', financialAccountId: null, financialAccountScopeKey: null });
  for (const item of cases) assert.equal(run(item.entries, item.snapshot).matches.length, 0);
  assert.equal(run(base.entries, base.snapshot).matches.length, 1);
});

test('only exactly one common OWNER qualifies; authorized users and source context do not', () => {
  const noOwner = pair({}, {}, [owner(1, 7, { relationType: 'AUTHORIZED_USER' }), owner(2, 7, { relationType: 'AUTHORIZED_USER' })]);
  assert.equal(run(noOwner.entries, noOwner.snapshot).matches.length, 0);
  const sourceOnly = pair({}, {}, [{ ...owner(1, 7), relationType: 'SOURCE_OWNER' }, { ...owner(2, 7), relationType: 'SOURCE_OWNER' }]);
  assert.equal(run(sourceOnly.entries, sourceOnly.snapshot).matches.length, 0);
  const differentOwners = pair({}, {}, [owner(1, 7), owner(2, 8)]);
  assert.equal(run(differentOwners.entries, differentOwners.snapshot).matches.length, 0);
  const ambiguousOwners = pair({}, {}, [owner(1, 7), owner(1, 8), owner(2, 7), owner(2, 8)]);
  assert.equal(run(ambiguousOwners.entries, ambiguousOwners.snapshot).matches.length, 0);
  const oneCommon = pair({}, {}, [owner(1, 7), owner(1, 8), owner(2, 7)]);
  assert.equal(run(oneCommon.entries, oneCommon.snapshot).matches.length, 1);
});

test('time window is explicit, inclusive, absolute, and has no nearest-neighbor fallback', () => {
  const atBoundary = pair({}, { occurredAt: '2026-10-05T10:00:10.000Z' });
  assert.equal(run(atBoundary.entries, atBoundary.snapshot, 10_000).matches.length, 1);
  const beyondBoundary = pair({}, { occurredAt: '2026-10-05T10:00:10.001Z' });
  assert.equal(run(beyondBoundary.entries, beyondBoundary.snapshot, 10_000).matches.length, 0);
  const incomingEarlier = pair({}, { occurredAt: '2026-10-05T09:59:55.000Z' });
  assert.equal(run(incomingEarlier.entries, incomingEarlier.snapshot, 10_000).matches.length, 1);
  for (const maxTimeDeltaMs of [undefined, 0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => matchBankInternalTransfers(atBoundary.entries, atBoundary.snapshot, { maxTimeDeltaMs }));
  }
});

test('ambiguous connected components fail closed while independent pairs still match', () => {
  const first = pair();
  const second = pair({ bankTransactionId: 20, financialAccountId: 3, occurredAt: '2026-10-05T11:00:00.000Z' }, { bankTransactionId: 21, financialAccountId: 4, occurredAt: '2026-10-05T11:00:05.000Z' }, [owner(3, 7), owner(4, 7)]);
  const secondIncoming = entry({ bankTransactionId: 12, financialAccountId: 3, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT', occurredAt: '2026-10-05T10:00:06.000Z' });
  const result = run([...first.entries, secondIncoming, ...second.entries], ownership([
    owner(1, 7), owner(2, 7), owner(3, 7), owner(4, 7),
  ]));
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].outgoing.bankTransactionId, 20);
  assert.equal(result.summary.ambiguousTransfers, 3);
  assert.equal(result.summary.matchedTransfers, 2);
});

test('two outgoing and one incoming are all ambiguous, with no greedy selection', () => {
  const outgoingA = entry({ bankTransactionId: 30, financialAccountId: 5 });
  const outgoingB = entry({ bankTransactionId: 31, financialAccountId: 6 });
  const incoming = entry({ bankTransactionId: 32, financialAccountId: 7, sourceEventType: 'INCOMING_TRANSFER', direction: 'CREDIT' });
  const result = run([outgoingA, outgoingB, incoming], ownership([
    owner(5, 7), owner(6, 7), owner(7, 7),
  ]));
  assert.equal(result.matches.length, 0);
  assert.equal(result.summary.ambiguousTransfers, 3);
});

test('purchase and unclassified monetary candidates are ineligible', () => {
  const purchase = entry({ sourceEventType: 'PURCHASE', direction: 'DEBIT' });
  const unknown = entry({ bankTransactionId: 12, financialAccountId: 3, sourceEventType: 'UNKNOWN', direction: 'DEBIT', normalizationStatus: 'READY', evidenceQuality: 'EXACT' });
  const result = run([purchase, unknown], ownership([owner(1, 7)]));
  assert.equal(result.matches.length, 0);
  assert.equal(result.summary.ineligibleCandidates, 2);
  assert.equal(result.candidateStatuses.every((row) => row.status === INTERNAL_TRANSFER_MATCH_STATUSES.INELIGIBLE), true);
});

test('candidate and journal coherence is regenerated and tampering is ineligible', () => {
  const valid = pair();
  const tamperedCandidate = { ...valid.entries[0], candidate: { ...valid.entries[0].candidate, amount: '999.00' } };
  const tamperedJournal = { ...valid.entries[1], journal: { ...valid.entries[1].journal, amount: '999.00' } };
  const result = run([tamperedCandidate, tamperedJournal], valid.snapshot);
  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.candidateStatuses.map((row) => row.status), ['INELIGIBLE', 'INELIGIBLE']);
});

test('duplicate identity inputs are rejected instead of deduplicated', () => {
  const input = pair();
  for (const field of ['candidateKey', 'journalKey', 'bankTransactionId']) {
    const duplicate = structuredClone(input.entries[1]);
    duplicate.candidate[field] = input.entries[0].candidate[field];
    assert.throws(() => run([input.entries[0], duplicate], input.snapshot), /duplicate/);
  }
});

test('matching is deterministic, input-order independent, and changes with policy or ownership evidence', () => {
  const input = pair();
  const first = run(input.entries, input.snapshot, 10_000);
  const reversed = run([...input.entries].reverse(), input.snapshot, 10_000);
  assert.deepEqual(first.matches, reversed.matches);
  assert.deepEqual(first.candidateStatuses.map(({ inputIndex, ...row }) => row), reversed.candidateStatuses.map(({ inputIndex, ...row }) => row));
  assert.equal(first.matches[0].matchKey, run(input.entries, input.snapshot, 10_000).matches[0].matchKey);
  assert.notEqual(first.matches[0].matchKey, run(input.entries, input.snapshot, 10_001).matches[0].matchKey);
  assert.equal(run(input.entries, ownership([owner(1, 7), owner(2, 8)])).matches.length, 0);
  const before = structuredClone(input);
  run(input.entries, input.snapshot);
  assert.deepEqual(input, before);
});

test('ownership loader is SELECT-only and excludes source-context tables', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [owner(1, 7)] };
  } };
  const snapshot = await loadBankInternalTransferOwnershipSnapshot(pool, [1]);
  assert.equal(snapshot.accounts[0].owners[0].personId, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /SELECT/);
  assert.doesNotMatch(calls[0].sql, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
  assert.doesNotMatch(calls[0].sql, /bank_source_person/i);
});

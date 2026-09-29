import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBankTransactionCoverage, resolveBankTransactionAccount } from '../src/bank-account-resolution.js';

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

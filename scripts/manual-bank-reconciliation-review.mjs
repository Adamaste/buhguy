import { createPool } from '../src/database.js';
import {
  approveHistoricalReceiptBankMatch,
  previewHistoricalReceiptBankMatch,
  reviewHistoricalBankAccountResolution,
} from '../src/manual-bank-reconciliation-review.js';

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || options.has(key)) throw new Error('ARGUMENTS_INVALID');
    if (key === '--persist') { options.set(key, true); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('ARGUMENT_VALUE_MISSING');
    options.set(key, value);
    index += 1;
  }
  return options;
}

const usage = 'Use --mode account|pair with one bank transaction ID. Writes require --persist and an exact --confirm-target.';
const args = parseArgs(process.argv.slice(2));
const allowed = new Set([
  '--mode', '--bank-transaction-id', '--financial-account-id', '--receipt-id', '--scope-key',
  '--expected-match-key', '--cohort-cutoff', '--evidence-type', '--evidence-sha256',
  '--evidence-reference-sha256', '--reviewer-code', '--confirm-target', '--persist',
]);
if ([...args.keys()].some((key) => !allowed.has(key))) throw new Error('ARGUMENTS_INVALID');

function required(name) {
  const value = args.get(name);
  if (typeof value !== 'string' || !value) throw new Error(`${name.toUpperCase().replaceAll('-', '_')}_REQUIRED`);
  return value;
}

function safeId(name) {
  const value = required(name);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name.toUpperCase().replaceAll('-', '_')}_INVALID`);
  return Number(value);
}

function evidence() {
  return {
    evidenceType: required('--evidence-type'),
    evidenceSha256: required('--evidence-sha256'),
    evidenceReferenceSha256: required('--evidence-reference-sha256'),
    reviewerCode: required('--reviewer-code'),
  };
}

const mode = required('--mode');
const bankTransactionId = safeId('--bank-transaction-id');
const persist = args.has('--persist');
if (persist && !args.has('--confirm-target')) throw new Error('--CONFIRM_TARGET_REQUIRED_FOR_PERSIST');

const pool = createPool({ max: 2, connectionTimeoutMillis: 10000 });
try {
  let result;
  if (mode === 'account') {
    const financialAccountId = safeId('--financial-account-id');
    if (persist && args.get('--confirm-target') !== `${bankTransactionId}:${financialAccountId}`) throw new Error('--CONFIRM_TARGET_MISMATCH');
    result = await reviewHistoricalBankAccountResolution(pool, {
      bankTransactionId,
      financialAccountId,
      ...(persist ? { evidence: evidence() } : {}),
      persist,
    });
  } else if (mode === 'pair') {
    const receiptId = safeId('--receipt-id');
    const financialAccountId = safeId('--financial-account-id');
    const scopeKey = required('--scope-key');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(scopeKey)) throw new Error('--SCOPE_KEY_INVALID');
    const selection = { bankTransactionId, receiptId, financialAccountId, scopeKey };
    if (!persist) {
      result = await previewHistoricalReceiptBankMatch(pool, selection);
    } else {
      const expectedMatchKey = required('--expected-match-key');
      const cohortCutoff = required('--cohort-cutoff');
      if (args.get('--confirm-target') !== `${bankTransactionId}:${receiptId}:${expectedMatchKey}`) throw new Error('--CONFIRM_TARGET_MISMATCH');
      result = await approveHistoricalReceiptBankMatch(pool, {
        ...selection,
        expectedMatchKey,
        cohortCutoff,
        evidence: evidence(),
        persist: true,
      });
    }
  } else {
    throw new Error(usage);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'MANUAL_REVIEW_FAILED'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

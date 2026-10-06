import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { buildMatchedPurchaseOrchestrationPreview } from '../src/matched-purchase-orchestration.js';
import { runMatchedPurchaseOrchestrationCommand } from '../src/cli.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const match = (suffix = 'a') => ({
  modelVersion: 'bank-receipt-matching-v1',
  matchStatus: 'MATCHED',
  relationshipType: 'RECEIPT_EVIDENCE_FOR_BANK_PURCHASE',
  matchKey: hash(`match:${suffix}`),
  scopeKey: 'scope-a',
  amount: '12.34',
  currency: 'RUB',
  bank: { bankTransactionId: suffix === 'a' ? 1 : 2, financialAccountId: 7, ledgerKey: hash(`ledger:${suffix}`), candidateKey: hash(`candidate:${suffix}`), journalKey: hash(`journal:${suffix}`), occurredAt: '2026-10-06T10:00:00.000Z' },
  receipt: { receiptId: suffix === 'a' ? 11 : 12, receiptCandidateKey: hash(`receipt:${suffix}`), normalizationVersion: 'fiscal-normalizer-v1', normalizedContentSha256: hash(`content:${suffix}`), amount: '12.34', currency: 'RUB', dateTime: '2026-10-06T10:01:00.000Z' },
});
const enrichment = (item, ledgerDisposition, status = 'PROJECTED') => ({
  modelVersion: 'matched-purchase-enrichment-projection-v1',
  projectionStatus: status,
  reasonCode: status === 'PROJECTED' ? 'MATCHED_BANK_PURCHASE_RECEIPT_ENRICHMENT_READY' : 'LEDGER_CONFLICT',
  enrichmentKey: status === 'PROJECTED' ? hash(`enrichment:${item.matchKey}`) : null,
  matchKey: item.matchKey,
  purchaseIdentity: { disposition: 'PROPOSE_NEW_PURCHASE', identityKey: hash(`purchase:${item.matchKey}`) },
  ledgerDisposition,
  bankOccurredAt: item.bank.occurredAt,
  receiptDateTime: item.receipt.dateTime,
});

function matching({ matches = [], bankStatuses = [], receiptStatuses = [], summary = {} } = {}) {
  return { matches, bankStatuses, receiptStatuses, summary };
}

test('authoritative matched pair produces a PERSIST_REQUIRED preview plan', () => {
  const item = match();
  const result = buildMatchedPurchaseOrchestrationPreview({
    matching: matching({ matches: [item] }),
    enrichments: [enrichment(item, 'FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED')],
  });
  assert.equal(result.readiness, 'READY');
  assert.equal(result.summary.persistRequired, 1);
  assert.equal(result.decisions[0].orchestrationAction, 'PERSIST_REQUIRED');
  assert.equal(result.decisions[0].writePlan.bankReceiptMatch, 'CREATE_OR_REUSE');
  assert.equal(result.decisions[0].writePlan.certification, 'REFRESH_ACTIVE_STATE');
});

test('REFINE and already persisted decisions expose distinct safe plans', () => {
  const first = match('a');
  const second = match('b');
  const result = buildMatchedPurchaseOrchestrationPreview({
    matching: matching({ matches: [second, first] }),
    enrichments: [enrichment(second, 'REUSE_EXISTING_BANK_FUNDING'), enrichment(first, 'REFINE_EXISTING_FISCAL_FUNDING')],
  });
  assert.equal(result.summary.persistRequired, 1);
  assert.equal(result.summary.alreadyPersisted, 1);
  const refine = result.decisions.find((row) => row.matchKey === first.matchKey);
  const noop = result.decisions.find((row) => row.matchKey === second.matchKey);
  assert.equal(refine.writePlan.supersession, 'APPEND_OR_REUSE');
  assert.equal(noop.orchestrationAction, 'NOOP_ALREADY_PERSISTED');
  assert.equal(noop.writePlan.expectedSemanticChange, false);
  assert.equal(noop.writePlan.bankFundedLedgerEntry, 'REUSE');
});

test('blocked enrichment and ambiguous matching require review, while ordinary unmatched evidence is visible', () => {
  const item = match();
  const result = buildMatchedPurchaseOrchestrationPreview({
    matching: matching({
      matches: [item],
      bankStatuses: [{ ledgerKey: hash('ledger'), status: 'AMBIGUOUS', reasonCode: 'AMBIGUOUS_COMPATIBLE_RECEIPTS', candidateKey: hash('candidate'), journalKey: hash('journal'), bankTransactionId: 1 }, { ledgerKey: hash('ledger-2'), status: 'UNMATCHED', reasonCode: 'NO_COMPATIBLE_RECEIPT', candidateKey: hash('candidate-2'), journalKey: hash('journal-2'), bankTransactionId: 2 }],
      receiptStatuses: [{ receiptId: 11, receiptCandidateKey: hash('receipt'), status: 'INELIGIBLE', reasonCode: 'RECEIPT_EVIDENCE_INELIGIBLE' }],
      summary: { ambiguousBankPurchases: 1, ambiguousReceipts: 0, unmatchedBankPurchases: 1, unmatchedReceipts: 0, ineligibleBankEntries: 0, ineligibleReceipts: 1 },
    }),
    enrichments: [enrichment(item, null, 'BLOCKED')],
  });
  assert.equal(result.readiness, 'REVIEW_REQUIRED');
  assert.equal(result.summary.blockedMatchedPairs, 1);
  assert.equal(result.summary.ambiguousBankPurchases, 1);
  assert.equal(result.summary.unmatchedBankPurchases, 1);
  assert.equal(result.summary.ineligibleReceipts, 1);
  assert.equal(result.decisions[0].orchestrationAction, 'BLOCKED');
  assert.equal(result.decisions[0].writePlan.execution, 'BLOCKED');
  assert.equal(result.decisions[0].writePlan.expectedSemanticChange, false);
});

test('preview output is deterministic and isolated PERSIST_REQUIRED decisions survive unrelated ambiguity', () => {
  const a = match('a');
  const b = match('b');
  const input = {
    matching: matching({
      matches: [b, a],
      summary: { ambiguousBankPurchases: 1, ambiguousReceipts: 1 },
    }),
    enrichments: [enrichment(b, 'FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED'), enrichment(a, 'FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED')],
  };
  const first = buildMatchedPurchaseOrchestrationPreview(input);
  const second = buildMatchedPurchaseOrchestrationPreview({ ...input, matching: { ...input.matching, matches: [a, b] }, enrichments: input.enrichments.slice().reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.readiness, 'REVIEW_REQUIRED');
  assert.equal(first.summary.persistRequired, 2);
  assert.ok(first.decisions.every((row) => row.orchestrationAction === 'PERSIST_REQUIRED'));
});

test('CLI requires explicit windows and rejects mutation requests', async () => {
  await assert.rejects(() => runMatchedPurchaseOrchestrationCommand({ _: ['preview'], 'scope-key': 'scope-a', 'receipt-window-ms': '10' }, { pool: {} }), /internal-transfer-window/);
  await assert.rejects(() => runMatchedPurchaseOrchestrationCommand({ _: ['preview'], 'scope-key': 'scope-a', 'internal-transfer-window-ms': '10', 'receipt-window-ms': '10', persist: true }, { pool: {} }), /read-only/);
  await assert.rejects(() => runMatchedPurchaseOrchestrationCommand({ _: ['execute'], 'scope-key': 'scope-a', 'internal-transfer-window-ms': '10', 'receipt-window-ms': '10' }, { pool: {} }), /only preview/);
});

test('CLI preview returns readiness exit codes without exposing an execution path', async () => {
  let output = null;
  const preview = async (_pool, options) => {
    assert.equal(options.internalTransferMaxTimeDeltaMs, 10);
    assert.equal(options.receiptMaxTimeDeltaMs, 20);
    return { modelVersion: 'matched-purchase-writer-orchestration-v1', readiness: 'READY', summary: {}, decisions: [], bankStatuses: [], receiptStatuses: [] };
  };
  const code = await runMatchedPurchaseOrchestrationCommand({ _: ['preview'], 'scope-key': 'scope-a', 'internal-transfer-window-ms': '10', 'receipt-window-ms': '20' }, { pool: {}, preview, write: (value) => { output = value; } });
  assert.equal(code, 0);
  assert.equal(output.readiness, 'READY');
});

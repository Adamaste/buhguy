import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool } from '../src/database.js';
import {
  findPreliminaryBankReceiptCandidates,
  PRELIMINARY_BANK_RECEIPT_WINDOW_MS,
  summarizePreliminaryBankReceiptCandidates,
} from '../src/bank-receipt-provisional-candidates.js';
import { runPreliminaryCandidateRead } from '../src/bank-receipt-provisional-candidate-read.js';
import { loadBankReceiptMatching, BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES } from '../src/bank-receipt-matching.js';
import {
  MATCHED_PURCHASE_AUTO_POLICY,
  previewMatchedPurchaseOrchestration,
} from '../src/matched-purchase-orchestration.js';
import { readMatchedPurchaseReconciliationOptIn } from '../src/matched-purchase-reconciliation.js';
import {
  APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
  APPROVED_RECEIPT_WINDOW_MS,
} from '../src/matched-purchase-reconciliation-constants.js';
import { loadBankCashFlowProjection } from '../src/bank-cash-flow-projection.js';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return { help: true };
    if (!['--from', '--to'].includes(arg)) throw new Error('only --from and --to are supported');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires an ISO timestamp`);
    values[arg.slice(2)] = value;
    index += 1;
  }
  if (!values.from || !values.to) throw new Error('--from and --to are required');
  return values;
}

function autoPreviewEligibility(optIn, period) {
  if (!optIn.enabled) return 'RECONCILIATION_DISABLED';
  if (typeof optIn.canaryScopeKey !== 'string' || !optIn.canaryScopeKey) return 'CANARY_SCOPE_UNSET';
  if (optIn.automaticPolicy !== MATCHED_PURCHASE_AUTO_POLICY) return 'AUTOMATIC_POLICY_NOT_ACTIVE';
  if (typeof optIn.bankIngestedAfter !== 'string' || !Number.isFinite(Date.parse(optIn.bankIngestedAfter))
    || new Date(Date.parse(optIn.bankIngestedAfter)).toISOString() !== optIn.bankIngestedAfter) return 'COHORT_CUTOFF_UNSET_OR_INVALID';
  if (Date.parse(optIn.bankIngestedAfter) > Date.parse(period.to)) return 'COHORT_CUTOFF_AFTER_PERIOD';
  return null;
}

function reportSummary(candidates, matching, optIn, period) {
  const candidateSummary = summarizePreliminaryBankReceiptCandidates(candidates);
  const autoBlocker = autoPreviewEligibility(optIn, period);
  return {
    ...candidateSummary,
    ambiguousBankRows: matching?.summary?.ambiguousBankPurchases ?? null,
    ambiguousReceiptRows: matching?.summary?.ambiguousReceipts ?? null,
    strictMatcherCompatiblePairs: matching?.summary?.matchedPairs ?? null,
    automaticAccountingPreview: {
      enabled: optIn.enabled,
      policy: optIn.automaticPolicy,
      scopeConfigured: Boolean(optIn.canaryScopeKey),
      cohortCutoffConfigured: Boolean(optIn.bankIngestedAfter),
      evaluated: autoBlocker === null,
      ...(autoBlocker ? { blocker: autoBlocker } : {}),
    },
    ledgerWritesPerformed: 0,
  };
}

export async function buildPreliminaryCandidateReadOnlyReport(pool, period, optIn = readMatchedPurchaseReconciliationOptIn()) {
  return runPreliminaryCandidateRead(pool, period, {
    findCandidates: async (data, normalizedPeriod, readOnlyClient) => {
      const autoBlocker = autoPreviewEligibility(optIn, normalizedPeriod);
      const matching = await loadBankReceiptMatching(readOnlyClient, {
        scopeKey: optIn.enabled && optIn.canaryScopeKey ? optIn.canaryScopeKey : null,
        from: normalizedPeriod.from,
        to: normalizedPeriod.to,
        bankIngestedAfter: optIn.enabled ? optIn.bankIngestedAfter : null,
        internalTransferMaxTimeDeltaMs: APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
        receiptMaxTimeDeltaMs: APPROVED_RECEIPT_WINDOW_MS,
        assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.UNAMBIGUOUS_COMPONENTS,
        requireSourceProviderBinding: true,
      });
      let strictDecisions = [];
      if (autoBlocker === null) {
        const preview = await previewMatchedPurchaseOrchestration(readOnlyClient, {
          scopeKey: optIn.canaryScopeKey,
          from: normalizedPeriod.from,
          to: normalizedPeriod.to,
          bankIngestedAfter: optIn.bankIngestedAfter,
          automaticPolicy: optIn.automaticPolicy,
          internalTransferMaxTimeDeltaMs: APPROVED_INTERNAL_TRANSFER_WINDOW_MS,
          receiptMaxTimeDeltaMs: APPROVED_RECEIPT_WINDOW_MS,
          logger: { info() {} },
        });
        strictDecisions = preview.decisions;
      }
      const bankCashFlow = await loadBankCashFlowProjection(readOnlyClient, {
        from: new Date(Date.parse(normalizedPeriod.from) - PRELIMINARY_BANK_RECEIPT_WINDOW_MS).toISOString(),
        to: new Date(Date.parse(normalizedPeriod.to) + PRELIMINARY_BANK_RECEIPT_WINDOW_MS).toISOString(),
      });
      const bankFlowById = new Map(bankCashFlow.projections.map((row) => [String(row.bankTransactionId), row]));
      const candidateBankRows = data.bankRows.map((row) => ({
        ...row,
        tbankCardSpecificAccountProofVerified: bankFlowById.get(String(row.bankTransactionId))?.tbankCardSpecificAccountProofVerified === true,
      }));
      const candidates = findPreliminaryBankReceiptCandidates({
        ...data,
        bankRows: candidateBankRows,
        from: normalizedPeriod.from,
        to: normalizedPeriod.to,
        cohortStartAt: optIn.enabled ? optIn.bankIngestedAfter : null,
        strictBankStatuses: matching.bankStatuses,
        strictReceiptStatuses: matching.receiptStatuses,
        strictDecisions,
      });
      return {
        summary: reportSummary(candidates, matching, optIn, normalizedPeriod),
        candidates,
      };
    },
  });
}

export async function main(argv = process.argv.slice(2)) {
  let pool;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write('Usage: node scripts/bank-receipt-provisional-candidates-read-only.mjs --from <ISO> --to <ISO>\n');
      return 0;
    }
    pool = createPool({ max: 1, connectionTimeoutMillis: 10_000 });
    const result = await buildPreliminaryCandidateReadOnlyReport(pool, args);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return 0;
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'READ_ONLY_REPORT_FAILED', reasonCode: 'PRELIMINARY_CANDIDATE_READ_FAILED' })}\n`);
    return 1;
  } finally {
    await pool?.end().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}

export { PRELIMINARY_BANK_RECEIPT_WINDOW_MS };

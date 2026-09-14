# Layer Gaps Tech-Debt Forensic Closeout

Model: `layer-gaps-tech-debt-v1`

Scope: read-only analysis of production receipts `72`, `83`, and `335`. No production schema, data, service, timer, grant, or accounting mutation was performed.

## Finding

The three reported gaps were diagnostic false positives, not missing accounting rows.

The deployed diagnostic joined graph evidence to `ledger_source_links`. A blocked ledger entry intentionally has no postings and no source link, so it appeared as if no ledger entry existed. The certification diagnostic required `CONFIRMED_ACQUISITION_VALUE/CERTIFIED`; it did not count the explicit `BLOCKED_EXPOSURE/BLOCKED` fact produced by Certification V1.

The candidate diagnostic now joins the latest ledger entry directly by `ledger_entries.source_event_id` and recognizes any certification fact for that event. Blocked routes remain visible as `BLOCKED` with their reason; they are not silently ignored and do not become accounting postings.

## Per-receipt trace

| Receipt | Normalized semantic | Graph event | Ledger expectation / actual | Certification expectation / actual | Financial impact | Root cause / fix |
|---:|---|---|---|---|---|---|
| 72 | READY, operation type 2, SETTLEMENT_ONLY, total 134.00, reconciled; cash/ecash 0, prepaid 134.00 | Event 13862, `RETURN`, `CONFIRMED`, `RETURN_REFUND_V1`, edge `13862 -> 13861` `RETURNS`, allocation 134.00 | `SHOULD_LEDGERIZE` as explicit blocked `LEDGER_RETURN_V1`; actual entry 116, `BLOCKED`, `PURCHASE_LEDGER_NOT_READY`; no postings by policy | `BLOCKED_EXPOSURE/BLOCKED`, reason `PURCHASE_LEDGER_NOT_READY`; actual fact exists | 134.00 blocked return exposure; not a certified return or bank refund; no double count | Old Graph -> Ledger check looked only for a source link. Candidate reads the blocked entry directly. |
| 83 | READY, operation type 1, SETTLEMENT_ONLY, total 134.00, reconciled; cash/ecash 0, prepaid 134.00 | Event 13861, `PURCHASE`, `CONFIRMED`, `RETURN_REFUND_V1` | `SHOULD_LEDGERIZE` as explicit blocked `LEDGER_STANDALONE_PURCHASE_V1`; actual entry 115, `BLOCKED`, `NO_SUPPORTED_NEW_MONEY_COMPONENT`; no postings by policy | `BLOCKED_EXPOSURE/BLOCKED`, reason `NO_SUPPORTED_NEW_MONEY_COMPONENT`; actual fact exists | 134.00 blocked exposure; excluded from certified acquisition and new-money postings | Old diagnostic required certified acquisition, not explicit blocked certification. Candidate classifies receipt as `BLOCKED`. |
| 335 | READY, operation type 1, SETTLEMENT_ONLY, total 0.00, reconciled; all components zero | Event 18117, `PURCHASE`, `CONFIRMED`, `STANDALONE_PURCHASE_V1` | `SHOULD_LEDGERIZE` as explicit blocked `LEDGER_STANDALONE_PURCHASE_V1`; actual entry 408, `BLOCKED`, `NO_SUPPORTED_NEW_MONEY_COMPONENT`; no postings by policy | `BLOCKED_EXPOSURE/BLOCKED`, reason `NO_SUPPORTED_NEW_MONEY_COMPONENT`; actual fact exists | Zero exposure; no certified acquisition and no postings | Same diagnostic boundary error as 83. |

`72` is not part of a prepayment/fulfillment lifecycle. Its only economic relationship is the confirmed `RETURNS` edge to purchase event `13861`; it cannot post until the target purchase ledger route is ready. `83` and `335` are not prepayment/fulfillment events either. No second business event, ledger entry, or allocation is created by this fix.

## Before and candidate diagnostics

| Diagnostic | Existing deployed report | Candidate read-only scan |
|---|---:|---:|
| Graph -> Ledger unexpected gaps | 3: 72, 83, 335 | 0 |
| Certification unexpected gaps | 2: 83, 335 | 0 |
| Analytics gaps | 0 | 0 |
| READY receipts | 1703 | 1703 |
| Explained receipts | 1703 | 1703 |
| UNEXPLAINED | 0 | 0 |
| Coverage gate | PASS | PASS |

The candidate scan reports `missingCertifiedAcquisition=2` for 83 and 335. This is intentionally not a layer gap: both have an explicit blocked certification fact and must not be counted as certified acquisition. `normalizationToGraph.readyWithoutReceiptEvidence=493` remains a census of ordinary receipts without graph evidence, not an unexplained route; their coverage outcomes are explicit and the gate remains PASS.

## Accounting impact

No financial totals changed. Production values observed by the candidate scan were:

- certified acquisition: `1093629.73` RUB;
- certified return: `2683.29` RUB;
- outstanding refund receivable: `2683.29` RUB;
- blocked exposure: `98310.00` RUB;
- merchant advance balance: `0.00` RUB;
- ledger postings: `2414`, balanced violations `0`.

The three receipts contribute blocked exposure of `134.00 + 134.00 + 0.00 = 268.00` RUB. They do not change certified acquisition, certified return, cash, or ledger postings.

## Clone validation

The candidate scanner ran against disposable clone `finance_receipt_collector_purchase_details_clone_20260907T17315`, which had the same 1703/5792/1703 source counts and the same graph/ledger/certification corpus. It was read-only. Results:

- graph validator: PASS;
- coverage gate: PASS;
- Graph -> Ledger unexpected gaps: 0;
- Certification unexpected gaps: 0;
- Analytics gaps: 0;
- ledger dry-run: 1248 entries, 2414 postings, balanced;
- certification blocked facts for all three target events present;
- no rebuild, persistence, schema mutation, or source mutation.

The same candidate scan against production returned identical counts and diagnostics. Production source counts remained 1703 receipts, 5792 items, 1703 raw rows, and 1703 fiscal facts.

## Code and tests

Changed files:

- `src/accounting-coverage.js`: direct ledger-entry lookup by source event; certification facts are loaded by business event; layer checks distinguish blocked explicit state from missing state.
- `tests/accounting-coverage.test.js`: blocked ledger/certification is not a gap; a confirmed event without a ledger entry remains a gap.
- `scripts/run-layer-gaps-tech-debt.mjs`: reproducible read-only scanner writing safe JSON artifacts.

Local test suite: `116 passed, 0 failed, 4 skipped`.

No production deployment was performed. The candidate is ready for a separately authorized deployment of the diagnostic-only change.

## Verdict

LAYER_GAPS_TECH_DEBT READY FOR DEPLOYMENT
# Historical audit snapshot

The snapshot counts below are historical evidence from a disposable validation run, not stable project or production values.

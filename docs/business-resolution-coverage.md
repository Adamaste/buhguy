# Business Resolution Coverage V1

## Scope and Safety

This is a read-only coverage scan of the current production corpus. The scan used one PostgreSQL `REPEATABLE READ READ ONLY` transaction and did not create or update receipts, normalized facts, graph objects, allocations, schema, timers, or matcher results. The PREPAYMENT_SETTLEMENT_V1 implementation was executed only as an in-memory dry-run.

Coverage version: `business-resolution-coverage-v1`.

## Actual Model Inspected

- Source fiscal evidence: `receipts`, `receipt_items`, `receipt_raw`.
- Phase 1B normalized evidence: `receipt_fiscal_facts`, `receipt_item_fiscal_facts`, `normalization_issues`.
- Phase 2A graph: `business_events`, `business_event_evidence`, typed graph relations/edges, allocations, scopes and provenance fields.
- Current lifecycle research: `PREPAYMENT_SETTLEMENT_V1` from `src/prepayment-settlement-matcher.js`.
- Source schema migrations present: `001_initial.sql` through `005_business_event_graph.sql`.

The coverage unit is one normalized receipt. A receipt is not treated as a purchase unless an existing confirmed graph lifecycle supports that conclusion.

## Production Snapshot

- Receipts: `1703`
- Receipt items: `5792`
- All receipts classified exactly once: `true`
- Normalization blockers: `0`
- Component reconciliation violations: `0`
- Duplicate source identities: `0`
- Duplicate canonical fiscal tuples: `0`

## Resolution Coverage

| State | Receipts | Fiscal face value | New money | Prepaid | Credit | Provision |
|---|---:|---:|---:|---:|---:|---:|
| CONFIRMED | 76 | 196084.00 | 98042.00 | 98042.00 | 0.00 | 0.00 |
| AMBIGUOUS | 30 | 15856.00 | 10406.00 | 5450.00 | 0.00 | 0.00 |
| CANDIDATE_ONLY | 1322 | 1294616.61 | 1140187.73 | 154428.88 | 0.00 | 0.00 |
| UNRESOLVED | 275 | 259553.68 | 255982.00 | 3571.68 | 0.00 | 0.00 |
| UNKNOWN_PATTERN | 0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| BLOCKED | 0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| **Total** | **1703** | **1766110.29** | **1404617.73** | **166452.56** | **0.00** | **0.00** |

`CONFIRMED` means graph evidence exists for an existing confirmed business lifecycle. It does not mean that every ordinary standalone receipt is a confirmed purchase. The 150 `STANDALONE_FULL_SETTLEMENT` receipts remain `UNRESOLVED`.

Graph evidence covers 76 receipts (`4.46%`) and represents 38 distinct confirmed lifecycles. All 76 graph-linked receipts are currently classified `CONFIRMED`; there are no confirmed graph lifecycles with missing receipt evidence in this scan.

## Scenario Census

| Scenario | State | Receipts | Fiscal face value | New money |
|---|---|---:|---:|---:|
| PREPAYMENT_CANDIDATE | CANDIDATE_ONLY | 1296 | 1254481.01 | 1100052.13 |
| PREPAYMENT_WITHOUT_SETTLEMENT | UNRESOLVED | 45 | 210359.00 | 210359.00 |
| PREPAYMENT_SETTLEMENT_CONFIRMED | CONFIRMED | 76 | 196084.00 | 98042.00 |
| RETURN_EXACT_CANDIDATE | CANDIDATE_ONLY | 21 | 34389.00 | 34389.00 |
| RETURN_AMBIGUOUS | AMBIGUOUS | 21 | 10406.00 | 10406.00 |
| RETURN_UNMATCHED | UNRESOLVED | 79 | 18407.00 | 18407.00 |
| RETURN_PARTIAL_ITEM_CANDIDATE | CANDIDATE_ONLY | 1 | 92.00 | 92.00 |
| ADVANCE_WITH_POSSIBLE_SETTLEMENT | CANDIDATE_ONLY | 4 | 5654.60 | 5654.60 |
| ADVANCE_UNRESOLVED | UNRESOLVED | 1 | 372.00 | 372.00 |
| STANDALONE_FULL_SETTLEMENT | UNRESOLVED | 150 | 30415.68 | 26844.00 |
| PREPAYMENT_AMBIGUOUS | AMBIGUOUS | 9 | 5450.00 | 0.00 |

No automatic matcher was run and no new graph relation was created.

## Operation Types

- Type 1, приход: 1417 receipts. They include the 76 confirmed lifecycle receipts, 9 ambiguous prepayment receipts, 1136 candidate-only receipts and 196 unresolved receipts.
- Type 2, возврат прихода: 285 receipts. There are no confirmed return lifecycles in the current model.
- Type 3, расход: 1 receipt, candidate-only, fiscal face value `28.80`.
- Type 4, возврат расхода: no current receipt.

Return research is deliberately non-committing: 34 `EXACT_UNIQUE`, 82 `AMBIGUOUS`, 5 `PARTIAL`, and 164 `UNMATCHED`. An exact candidate is still `CANDIDATE_ONLY`, not a confirmed return.

## Payment and Component Signatures

Observed item payment type signatures:

- `[4]`: 1518 receipts, fiscal face `1293073.64`.
- `[1]`: 179 receipts, fiscal face `463130.05`.
- `[3]`: 5 receipts, fiscal face `6026.60`.
- `[1,4]`: 1 receipt, fiscal face `3880.00`.

Observed component signatures:

- `NEW_MONEY`: 1551 receipts, fiscal face `1504617.73`.
- `PREPAID`: 151 receipts, fiscal face `261492.56`.
- `ZERO_COMPONENTS`: 1 receipt with face value `0.00`.

There were no `CREDIT` or `PROVISION` amounts in the current normalized corpus. All available component sums reconcile to the fiscal total.

The `[1,4]` receipt is retained as a mixed item-level signature and is not collapsed into one lifecycle stage. The five `[3]` receipts are the advance census; four have possible settlement candidates and one is unresolved.

## PREPAYMENT_SETTLEMENT_V1 Census

- Settlements examined: `1519`
- Candidate pairs: `47641`
- Strict matches: `59`
- Confirmed settlements: `38`
- Ambiguous settlements: `9`
- Candidate-only settlements: `1239`
- Unmatched settlements: `233`
- Distinct confirmed prepayments: `38`
- Distinct confirmed settlements: `38`
- Reused confirmed prepayments: `0`
- Confirmed lifecycle fiscal face value: `98042.00`
- Confirmed lifecycle new money: `98042.00`

The confirmed-consumption invariant is clean: one confirmed prepayment is not fully consumed by multiple confirmed settlement lifecycles.

## Unknown and Unresolved Exposure

There are no `UNKNOWN_PATTERN` or `BLOCKED` receipts in this snapshot. The primary unresolved exposure is known modeled lifecycle evidence that is not yet decisive:

- `AMBIGUOUS`: fiscal face `15856.00`, new money `10406.00`, prepaid `5450.00`.
- `CANDIDATE_ONLY`: fiscal face `1294616.61`, new money `1140187.73`, prepaid `154428.88`.
- `UNRESOLVED`: fiscal face `259553.68`, new money `255982.00`, prepaid `3571.68`.

These figures are fiscal/component dimensions, not household-spend totals and not purchase counts.

## Validator and Invariants

Graph validator: `PASS`.

All validator counters are zero: dangling evidence, dangling edges, duplicate event semantic keys, missing provenance, missing assertion provenance, cross-scope edges, self-edges, negative allocations, confirmed receipt overallocation, and confirmed item overallocation.

The scanner also verified exact-one classification, source identity uniqueness, canonical tuple uniqueness, component reconciliation, and `accountingMutations=false`.

## Reproducibility

The reusable read-only scanner is [business-resolution-coverage.mjs](../scripts/business-resolution-coverage.mjs). It emits deterministic JSON artifacts with a version identifier and uses no LLM or FNS calls. Redacted outputs are kept outside the publishable source tree.

Local verification: the new coverage tests pass `3/3`; the existing project suite passes `62/62`.

## Recommendation

NEXT BUSINESS RULE TO IMPLEMENT: a separately governed Return/Refund research-to-matcher phase. It has the clearest unresolved classification boundary: 285 type-2 receipts with 82 competing candidates and 164 unmatched cases. Do not auto-match returns yet; first define collision, partial-item, chronology, and evidence rules. The high-volume prepayment candidate population should remain candidate-only until a separate business decision authorizes additional confirmation semantics.
# Historical audit snapshot

The numeric totals below describe the snapshot used for this audit only. They are not current production values and must not be used as fixtures or configuration.

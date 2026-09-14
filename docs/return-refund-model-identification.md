# Return / Refund V1 Model Identification

## Scope

This phase is read-only model identification. It analyzed all current `operation_type=2` receipts and did not create business events, evidence links, edges, allocations, confirmations, schema changes, or production matcher writes.

Research version: `return-refund-model-identification-v1`.

The scan used one PostgreSQL `REPEATABLE READ READ ONLY` transaction. It inspected normalized facts, item-level payment types, seller identity, amounts, chronology, item quantity/amount subsets, fiscal identity fields, payment stages/components, and existing graph evidence.

## Corpus

- Current receipts: `1703`
- Prior operation_type=1 sales: `1417`
- Returns, operation_type=2: `285`
- Return fiscal face value: `90421.55`
- Return new money: `89545.55`
- Return prepaid component: `876.00`
- Return credit/provision components: `0.00`

The earlier coverage census (`34 EXACT_UNIQUE`, `82 AMBIGUOUS`, `5 PARTIAL`, `164 UNMATCHED`) was a coarse first pass. This research applies a broader deterministic item-subset search and preserves the earlier groups as provenance in `summary.json`.

## Detailed Classification

| Classification | Receipts | Fiscal face value | New money | Prepaid |
|---|---:|---:|---:|---:|
| EXACT_UNIQUE_SAFE | 34 | 38006.29 | 37872.29 | 134.00 |
| AMBIGUOUS_EXACT_COMPETITION | 82 | 19905.00 | 19308.00 | 597.00 |
| AMBIGUOUS_SAME_SELLER_AMOUNT | 2 | 120.00 | 120.00 | 0.00 |
| PARTIAL_ITEM_CANDIDATE | 167 | 32390.26 | 32245.26 | 145.00 |
| Detailed UNMATCHED | 0 | 0.00 | 0.00 | 0.00 |

The earlier 164 unmatched cases were not silently discarded. Under the expanded analysis, they have item-overlap/subset evidence and are represented as `PARTIAL_ITEM_CANDIDATE`, or fall into the two same-seller/amount ambiguity cases. They remain non-confirmed.

## Exact Unique Validation

All 34 prior exact-unique cases satisfy the research-level predicates:

- one prior operation_type=1 candidate;
- same seller identity;
- sale timestamp strictly before return timestamp;
- equal fiscal amount;
- exact item fingerprint including item identity, quantity, price and item sum;
- no competing exact candidate;
- no known confirmed return allocation;
- no known cumulative over-return in the current graph evidence.

These are `EXACT_UNIQUE_SAFE` research candidates, not confirmed purchases or confirmed returns. A production rule must additionally resolve the purchase/business lifecycle context before creating a return or refund event.

## Ambiguity Taxonomy

- `AMBIGUOUS_EXACT_COMPETITION`: 82 cases, where at least two prior sales share seller, amount, chronology and exact item fingerprint. Nearest receipt is not selected.
- `AMBIGUOUS_SAME_SELLER_AMOUNT`: 2 cases, where multiple same-seller amount candidates remain but exact item identity is insufficient.

Existing prepayment/settlement context is retained as context only. A return must target the resolved purchase lifecycle, not independently double-count a prepayment and its settlement receipt.

## Partial Cases

There are 167 `PARTIAL_ITEM_CANDIDATE` cases. They have seller/chronology and item overlap/subset evidence, but full fingerprint and equal amount are not proven. The scanner records quantity, item sum, amount, payment type and candidate predicates for each case.

Partial quantity and partial amount are not auto-confirmed. They require explicit graph allocations. The existing allocation model is suitable for representing a future `RETURN_COMPONENT` allocation, subject to cumulative quantity and amount limits.

## Return vs Refund

The fiscal return receipt proves a fiscal return operation. It does not by itself prove that money was actually transferred back. Therefore:

- `RETURN` means the merchandise/service return event supported by fiscal evidence.
- `REFUND` means the monetary refund event and requires separate payment/refund evidence.
- No current production relation was created for either concept.

A future model may use one return receipt as evidence for both events only when the respective evidence predicates are independently satisfied.

## Proposed RETURN_REFUND_V1 Rule

High-precision confirmation requires all of the following:

1. Return has `operation_type=2`; source sale has `operation_type=1`.
2. Seller identity is equal and non-null.
3. Sale chronology is strictly before return chronology.
4. For a full return, fiscal amount is equal.
5. Item fingerprint is exact, including quantity, price, item sum and available product/provider identifiers.
6. Exactly one candidate remains after all predicates.
7. The candidate is tied to one resolved purchase lifecycle, not merely one receipt inside a prepayment/settlement lifecycle.
8. Existing confirmed return allocations do not consume the same quantity or amount.
9. Cumulative returned quantity and amount do not exceed the original acquisition.
10. Scope and provenance are explicit and deterministic.

Any competing candidate is `AMBIGUOUS`. Partial evidence is `CANDIDATE_ONLY`. Missing history remains unresolved. This is a model proposal only; it is not enabled in production.

## Required Allocation Semantics

The future matcher should use existing graph allocations:

- one return may allocate to multiple purchase items only with explicit item-level evidence;
- one purchase may have multiple partial returns;
- cumulative allocated quantity must not exceed purchased quantity;
- cumulative allocated amount must not exceed original amount;
- one return cannot be fully confirmed against two purchases without explicit split allocation;
- allocations must remain scope-isolated and idempotent;
- `MANUAL` and `EXTERNAL_CONFIRMED` relations must survive rebuild.

## Safety and Verification

- Return result rows: `285/285`.
- Exact safe research candidates: `34`.
- Confirmed return edges before and after scan: `0`.
- Graph validator: `PASS`.
- No production mutations: `true`.
- Existing project tests: `62/62 PASS`.
- Return research regression tests: `7/7 PASS`.

Regression fixtures cover exact unique return, identical purchases, partial quantity, repeated partial returns, over-return/allocation blocking, seller mismatch, no prior history, deterministic predicates and strict non-selection of nearest candidates.

## Artifacts

- Artifact JSON files are intentionally excluded from the public repository.
- [return-refund-research.mjs](../scripts/return-refund-research.mjs)
- [return-refund-research.js](../src/return-refund-research.js)

The artifacts contain redacted research data, receipt IDs, candidate predicates and aggregates. They do not contain credentials, tokens, cookies or full raw payloads.

## Conclusion

The model is ready for a separately controlled implementation phase, but the production matcher must not be enabled from this research result alone. The only proposed automatic coverage is the 34 high-precision exact candidates, and even those require resolved business-purchase lifecycle context and allocation guards before confirmation.
# Historical audit snapshot

This research note records a historical snapshot only. It contains no required production configuration.

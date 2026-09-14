# Matching Rule Catalog v3.1

No rule below is an implemented production rule. `AUTO` means safe only for evidence normalization, not purchase matching.

| ID | Rule | Verdict | Evidence/guardrails |
|---|---|---|---|
| R1 | Valid raw operation type copied to normalized receipt | AUTO | 1691/1691 consistent, nullable and constrained |
| R2 | Payment components reconcile to total at two decimals | AUTO for reconciliation | missing and zero remain distinct |
| R3 | Same seller and amount means same purchase | UNSAFE | 116 same-seller/amount candidate pairs; repeats exist |
| R4 | Same seller/amount and core item fingerprint within 14 days | CANDIDATE_ONLY | current snapshot 39 core rows; research window only |
| R5 | Strict full item fingerprint plus `[1]` -> `[4]` | CANDIDATE_ONLY | current snapshot 2; no order/fulfillment proof |
| R6 | Return same seller/amount/item fingerprint to prior receipt | CANDIDATE_ONLY | 116 returns with candidates; 84 competing |
| R7 | Return amount alone allocates original purchase | UNSAFE | partial/split/competing return risk |
| R8 | Fixed 14-day lifecycle window | UNSAFE | distribution feature only, no production threshold |
| R9 | Item paymentType is receipt lifecycle | UNSAFE | one mixed-payment receipt |
| R10 | Generic service code identifies product | UNSAFE | receipt 109 code 115730 unresolved |
| R11 | Public exact INN identifies merchant legal entity | CANDIDATE_ONLY | provenance and date/version required |
| R12 | market_payment_id prefix groups lifecycle | BLOCKED | path absent in current corpus; no collision proof |
| R13 | Missing numeric field equals zero | UNSAFE | FFD support/missing/zero distinction |
| R14 | Correction is only `payload.correction` | UNSAFE | FFD-aware fiscal tags and bases required |

Promotion to AUTO requires positive/counterexample/collision/reuse/FFD/amount/quantity/return/cancellation/incremental/out-of-order/idempotency/explainability/rebuildability tests and a false-positive budget.

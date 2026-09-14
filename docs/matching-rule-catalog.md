# Matching Rule Catalog (Audit)

Verdicts: `AUTO` is safe only within the stated scope; `CANDIDATE_ONLY` requires review or additional evidence; `UNSAFE` must not allocate money.

| ID | Rule | Verdict | Required guardrails |
| --- | --- | --- | --- |
| R1 | Copy valid raw `operationType` to normalized receipt | AUTO | Nullable, CHECK 1..4, raw traceability |
| R2 | Verify cash/e-cash/prepaid/credit/provision sum equals total | AUTO for reconciliation | Two-decimal rounding, distinguish missing from zero |
| R3 | Same amount and seller means same purchase | UNSAFE | No automatic allocation |
| R4 | Same seller, amount and item signature plus advance components and later date indicates settlement candidate | CANDIDATE_ONLY | External order/merchant ID, fulfillment, scope, collision test, review |
| R5 | Pair receipts by fixed 14-day window | UNSAFE | No fixed window; use measured distributions only as a candidate feature |
| R6 | Receipt-level `paymentType` represents lifecycle | UNSAFE | Payment type is item-scoped in the corpus |
| R7 | `receipt.total_sum` is spend | UNSAFE | Use ledger cash/advance allocation |
| R8 | Missing numeric component means zero | UNSAFE | Need FFD support/missing/zero distinction |
| R9 | Same item names identify a product | CANDIDATE_ONLY | Product code, merchant scope, quantity/price and collision checks |
| R10 | Same fiscal identity tuple is duplicate | CANDIDATE_ONLY | Source/account scope and correction/reissue policy |

Each future AUTO rule needs positive cases, counterexamples, collisions, reuse, FFD coverage, amount/quantity/return/cancellation tests, incremental/out-of-order replay, idempotency, explainability and rebuildability evidence.

# PREPAYMENT_SETTLEMENT_V1

## Boundary

This matcher identifies only a possible lifecycle from an earlier normalized `PREPAYMENT_ONLY` or `ADVANCE_ONLY` receipt to a later `SETTLEMENT_ONLY` receipt. It does not match returns, refunds, banks, ledger postings, categories, or arbitrary fuzzy purchases. It never treats seller plus amount as sufficient identity.

## Predicates

For a pair to be a strict confirmation candidate, all of these predicates must pass:

1. Both facts are `READY` and belong to the same accounting scope.
2. Both fiscal `operation_type` values are compatible with the purchase flow (`1`); return directions are excluded.
3. The earlier receipt is `PREPAYMENT_ONLY` or `ADVANCE_ONLY`; the later receipt is `SETTLEMENT_ONLY`.
4. The prepayment timestamp is strictly earlier than settlement timestamp.
5. Currency is compatible: equal known currencies, or both values are absent in the source schema; a known-vs-known conflict or known-vs-missing pair fails closed.
6. `total_sum` is equal to two decimals.
7. Item count, ordered item names, quantities, prices, item sums, provider INNs, GTIN and raw product codes are equal.
8. The earlier receipt contains positive new money (`cash_total_sum + ecash_total_sum`).
9. The later receipt consumes the full prepaid value (`prepaid_sum = total_sum`) and has zero new money.
10. Credit and provision components are explicit zero on both receipts.

The matcher records each predicate result and `firstExclusionReason`; missing/invalid data fails closed. `research` is a deterministic weaker candidate classification, not a confirmation rule.

## Resolution

- no earlier stage candidate: `UNMATCHED`;
- candidates exist but strict evidence is insufficient: `CANDIDATE`;
- exactly one strict pair: `CONFIRMED` in the dry-run model only;
- more than one strict pair: `AMBIGUOUS`.

The implementation never chooses first, nearest, or lowest-ID candidate. The dry-run result does not create graph events, edges, allocations, purchases, or ledger rows. Production execution uses only normalized Phase 1B facts through a read-only SQL query.

## Value and provenance

For a strict pair, one conceptual purchase value is the prepayment/settlement value, not their sum. Xiaomi's pair therefore represents `32380.00 RUB`, not `64760.00 RUB`. The result carries rule `PREPAYMENT_SETTLEMENT_V1`, matcher version, normalizer version, receipt IDs, timestamps, seller/provider evidence and predicate results. It is model-identification only; Phase 2B does not write accounting truth.

## Incremental, out-of-order and rebuild behavior

The function accepts the current normalized corpus, so it can be called after each new `READY` receipt. A previously unmatched prepayment is reconsidered when a later settlement arrives. Sorting is deterministic by timestamp and ID, so A-then-B and B-then-A inputs produce the same result. Re-running the same input produces byte-equivalent results and no writes. Since this phase is pure/read-only, manual or external Phase 2A assertions are not touched.

The production schema has `NULL` currency for the Xiaomi receipts, so `NULL/NULL` compatibility is explicit schema handling, not a guessed currency value.

## Unsupported cases

Mixed payment stages, partial settlements, uncertain service identity, missing components, ambiguous candidates and non-equal items remain non-confirmed. `ADVANCE_ONLY` is represented as a candidate source stage but is not inferred from names or blank item text.

## Production read-only dry-run

The current production snapshot returned 1691 `READY` normalized receipts. The matcher examined 1507 settlement-like receipts (`SETTLEMENT_ONLY` plus one `MIXED`) and generated 46867 chronological candidate pairs. It found 58 strict pairs, 37 settlements with exactly one strict pair, 9 ambiguous settlements, 230 unmatched settlements and 1231 candidate-only settlements. No production rows were inserted or updated.

The Xiaomi golden case is confirmed as receipt `62 -> 54`: all 19 predicates passed, including seller, amount, ordered item fingerprint, provider identity, operation type, chronology, positive prepayment money and settlement consumption of prepaid value. Both source currency fields are `NULL`; the explicit `NULL/NULL` compatibility rule applies. The conceptual purchase value is `32380.00`, not the sum of both fiscal documents.

The production dry-run was executed by selecting normalized facts and item facts over SSH and evaluating the result locally. The production database was not used as a test database; no migration, graph write, service change or authentication change occurred.

## Confirmed-consumption invariant

`CONFIRMED` requires mutual uniqueness: one settlement has exactly one strict prepayment candidate, and that prepayment is not the unique strict candidate for any other settlement. Strict predicate matches that reuse a prepayment are retained as evidence but their affected relationships resolve to `AMBIGUOUS` and are never passed to the graph writer. This prevents V1 from consuming the same fiscal prepayment value twice without a proven partial-allocation model.

## Incremental runtime integration

The production-intended runtime path is now explicit: `syncReceipts` commits the source bundle first, calls `normalizeAndStoreReceipt`, and only after a `READY` result calls `reconsiderPrepaymentSettlement(pool, receiptId)`. The reconsideration query is bounded to the trigger receipt plus `READY` receipts with compatible lifecycle stages and the same non-null seller INN; the pure matcher then applies the complete fail-closed predicate set. This means a later settlement reconsiders an earlier prepayment, and a later prepayment can reconsider an already stored settlement without a full-history rescan.

Matcher counters are reported separately as `matcher_examined`, `matcher_confirmed`, `matcher_ambiguous`, `matcher_candidate_only`, `matcher_unmatched` and `matcher_failed`. A matcher exception is logged and counted but does not roll back committed source evidence or normalized facts. The regular `sync` command uses read-only reconsideration and therefore does not write graph rows; graph persistence is an explicit `--persist-matcher` opt-in used only by disposable verification until a separate production-write authorization.

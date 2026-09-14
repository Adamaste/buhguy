# Accounting Audit v3.1.1 Forensic Closeout

## Scope

This is the final closeout of the 52/48 discrepancy. It is read-only. No production schema/data/auth/systemd changes were made and no pair is an AUTO match.

## Evidence availability

The exact historical SQL that allegedly produced `52 candidate pair rows / 48 distinct settlement receipts` is not present in the repository, git history, previous v3/v3.1 artifacts or the accessible production filesystem. Available evidence is the claim itself and its textual research conditions. Therefore the old set cannot be reconstructed honestly as an exact set on the current snapshot.

`old-pairs.json` records this as `NOT_REPRODUCIBLE`, with an empty set and no invented pairs. `pair-diff.json` consequently marks old-only/new-only/intersection as `UNCOMPUTABLE` rather than fabricating a set diff. `snapshot-evidence.json` contains the current identity checksums and timestamp bounds.

## Reproducible current algorithms

The exact executable SQL is [accounting-audit-v3.1.1-discrepancy.sql](../scripts/accounting-audit-v3.1.1-discrepancy.sql). Every current pair uses key:

`prepayment_receipt_id + settlement_receipt_id`

`research-pairs.json` means: both operation type 1; prepayment item payment types exactly `[1]`; settlement item payment types exactly `[4]`; same `seller_inn`; same amount; settlement timestamp later and no more than 14 days after prepayment.

`core-pairs.json` adds equality of item count, names, quantity, price and item sum.

`strict-pairs.json` adds equality of the complete item object after removing only item-level `paymentType`; this includes provider/product-code fields when present.

## Current result

On the same current production snapshot:

| Set | Pair rows | Distinct settlement receipts |
|---|---:|---:|
| Research | 42 | 35 |
| Core | 39 | 35 |
| Strict | 2 | 2 |

The transition is therefore research -> core: `42 -> 39`, core -> strict: `39 -> 2`. All excluded pair rows include predicate booleans and `first_exclusion_reason` in the row-level artifacts. The exact pair-level sets and key-based transitions are in `research-pairs.json`, `core-pairs.json`, `strict-pairs.json` and `pair-diff.json`.

The old 52/48 result does not reproduce. This is not proven to be an algorithm difference because the old SQL is unavailable. It is compatible with snapshot difference, predicate difference or fingerprint difference.

## Snapshot evidence

Current production contains 1691 receipts and 1691 raw rows. `receipts.received_at` spans 2026-09-05 18:57:22 to 19:31:29 MSK; raw rows span 22:03:54 to 22:21:11 MSK. Existing evidence says an earlier sync fetched 1700 while 1691 were stored, but no immutable 1700-row snapshot, old query file or checksum is available locally. Artifact timestamps show v3/v3.1 were generated on 2026-09-06, after the current snapshot was ingested, but do not prove whether the earlier 52/48 calculation used the same rows.

Conclusion: snapshot identity is **not provable** from available evidence. No data deletion or production mutation was performed to test it.

## Pair diff semantics

`pair-diff.json` provides:

- `old_only`: `UNCOMPUTABLE` because old set is unavailable;
- `new_only`: `UNCOMPUTABLE` against the old set;
- `intersection`: `UNCOMPUTABLE` against the old set;
- current transitions: full research/core/strict key sets and excluded rows.

For every current research pair, the artifact records operation type, payment type, chronology, 14-day window, seller, amount, item count, names, quantity, price, item sum, provider INN, GTIN/product code, payment components, external-ref condition and competing-candidate condition. `first_exclusion_reason` is mandatory. External ref is `NULL/NOT_OBSERVED`, not a silently passing predicate, because `market_payment_id` was absent in the current corpus.

## Final blocker status

`BLOCKER`: exact historical old SQL/set unavailable.

`RESOLVED`: current research/core/strict algorithms are reproducible and their set transitions are materialized.

`REMAINING RISK`: the 52/48 calculation cannot be attributed definitively to algorithm vs snapshot without the original SQL and/or immutable prior snapshot. None of 52, 42, 39 or 2 is promoted to automatic matching.

## Stop

This closeout ends here. No new architecture research or production implementation is included.

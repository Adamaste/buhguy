# RETURN_REFUND_V1 Deployment Record

## Status

Implementation was validated on a disposable PostgreSQL 18.6 clone and deployed to production in a controlled maintenance window. The production result below is the pre-persist read-only dry-run.

Rule: `RETURN_REFUND_V1`
Matcher version: `return-refund-matcher-v1`

## Semantics

The matcher creates a `RETURN` business event for a proven fiscal return and a `RETURNS` edge to a business `PURCHASE`. It does not create a `REFUND` event because current FNS facts do not independently prove that money was actually transferred back. `refundStatus` remains `UNPROVEN`.

For standalone full-settlement evidence, V1 may deterministically create the corresponding `PURCHASE` event during persistence only when the sale is normalized, operation type 1, `SETTLEMENT_ONLY`, and not already part of a prepayment/fulfillment lifecycle. For a prepayment plus settlement lifecycle, the matcher resolves the existing `PURCHASE` event through `PREPAYMENT_FOR`/`FULFILLS` edges and never creates a second purchase.

## Confirmation Predicates

Confirmation requires every predicate:

- return `operation_type=2` and sale `operation_type=1`;
- normalized facts are ready;
- same non-null seller identity;
- sale timestamp is before return timestamp;
- exact fiscal amount;
- exact item fingerprint, quantities, prices and item sums;
- compatible currency;
- exactly one valid candidate;
- resolved purchase lifecycle or eligible standalone full settlement;
- no competing lifecycle;
- no existing confirmed return allocation;
- cumulative returned amount and quantity do not exceed the purchase;
- deterministic accounting scope;
- no prior confirmed use of the same return receipt.

Ambiguous candidates are never resolved by nearest date, first row, smallest gap, or any arbitrary tie-breaker. Partial returns remain `CANDIDATE_ONLY` and do not create guessed allocations.

## Production Dry-Run

Current corpus: `285` returns.

| State | Count | Fiscal face value | New money |
|---|---:|---:|---:|
| CONFIRMED candidate | 8 | 2817.29 | 2683.29 |
| AMBIGUOUS | 84 | 20025.00 | 19428.00 |
| CANDIDATE_ONLY | 193 | 67579.26 | 67434.26 |
| UNRESOLVED | 0 | 0.00 | 0.00 |

The 8 confirmed candidates are receipt IDs `72, 295, 746, 927, 954, 1029, 1214, 1292`. A batch consumption guard prevents two full returns from consuming one purchase lifecycle in the same deterministic run. This is a recomputed result, not a hardcoded expectation. No graph objects were written.

No refund events are proven by the current facts, so `REFUND` creation count is `0`.

Production persistence created `7` standalone `PURCHASE` events, `8` `RETURN` events, `15` evidence links, `8` `RETURNS` edges and `8` return allocations. One of the eight targets was an existing `PREPAYMENT_SETTLEMENT_V1` purchase lifecycle; no duplicate purchase was created for it. `REFUND` events created: `0`.

## Graph Persistence

For each confirmed result, persistence is transactional and creates:

- one deterministic `PURCHASE` only for eligible standalone full-settlement evidence;
- one deterministic `RETURN` event;
- one `RETURN_EVIDENCE` link;
- one `RETURNS` edge from RETURN to PURCHASE;
- one `RETURN_COMPONENT` allocation on the RETURN event.

Existing `MANUAL` and `EXTERNAL_CONFIRMED` objects are not deleted by the rule-specific rebuild. The generic graph rebuild removes only `SYSTEM_DERIVED` objects for `RETURN_REFUND_V1`, then replays the deterministic result.

Idempotency is enforced by graph semantic keys and an advisory transaction lock per scope/purchase. Existing confirmed return evidence is checked before writing. Failures roll back the complete matcher transaction.

## Out-of-Order and Runtime

The optional CLI path is:

```text
match return-refund --dry-run
```

Persistence requires an explicit `--persist` flag. The regular sync path is unchanged unless the optional return matcher flag is explicitly enabled. Matcher failures are counted and logged without rolling back immutable source evidence.

## Validation

Disposable PostgreSQL 18.6 integration tests: `6/6 PASS`.

Validated scenarios:

- exact full return persistence;
- ambiguous competition with zero graph mutation;
- transactional rollback after injected failure;
- concurrent runs and idempotent rerun;
- rebuild with manual event preservation;
- return-before-sale convergence;
- prepayment plus settlement return targeting the existing purchase lifecycle.

Pure matcher tests: `7/7 PASS`.
Return research tests: `7/7 PASS`.
Existing suite plus new pure matcher tests: `76/76 PASS`.

Graph validator on clone: `PASS`. Source receipts, raw evidence, items and normalization facts are unchanged by matcher persistence tests.

## Deployment Verification

Fresh backup: `/var/backups/receipt-collector/postgres/finance_receipt_collector-20260907T121046Z.dump.gz`, mode `0600`, owner `postgres`, `pg_restore --list` readable, SHA-256 `f8ffb33501dd507b48683f9e4f8c952aa6b36b76fe6fe312b9c3e48ba12dd773`.

After persistence and the second idempotent run, source counts remained `receipts=1703`, `receipt_items=5792`, `receipt_raw=1703`; normalization facts remained `1703/5792` with `0` issues. Final graph counts are `business_events=129`, `evidence=91`, `edges=84`, `allocations=8`. Graph validator passed. The sync unit now enables bounded RETURN_REFUND reconsideration only for newly inserted normalized return receipts; the normal scheduled sync completed successfully with `return_matcher_failed=0`.
# Historical audit snapshot

The counts and backup references below describe a historical validation run. They are not production defaults and are not required for a fresh installation.

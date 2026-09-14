# FNS Detail Unavailable V1

This change separates a discovered FNS list reference from a resolved
canonical receipt. `receipt_source_observations` remains append-only and keeps
its non-null canonical `receipt_id`; unresolved list references live in
`fns_source_receipt_refs`.

## States

- `PENDING_DETAIL`: reference was listed and has not yet been resolved.
- `RESOLVED`: detail produced or reused a canonical receipt and a source
  observation exists.
- `FNS_DETAIL_UNAVAILABLE`: the reviewed FNS HTTP 422 machine-code signature
  was returned; no receipt is created.
- `RETRYABLE_DETAIL_ERROR`: another bounded detail failure is pending retry.
- `CONFLICT`: reserved for fail-closed source/reference conflicts.

The source coverage invariant is `listed = resolved + detail unavailable +
retryable + conflicts + other explicit states`; `UNCLASSIFIED` must be zero.
This is separate from accounting coverage, which starts only from canonical
receipt evidence.

## Retry policy

Known detail-unavailable records are not fetched on every normal cycle. The
first retry is scheduled after 24 hours, the second after 7 days, and later
retries after 30 days. A generic retryable error uses a one-hour next retry.
The schedule is persisted and survives process restarts.

The known production signature is matched by HTTP 422, a non-empty machine
code whose SHA-256 prefix is recorded in `src/fns-detail-errors.js`, and the
normalized provider message. An HTTP status or message alone is insufficient.

## Backfill

`scripts/backfill-source-references.mjs` is clone/deployment tooling. It takes
`<source-id> <manifest.json>` and atomically backfills only explicit
`RESOLVED` or `FNS_DETAIL_UNAVAILABLE` records. Existing canonical receipts,
raw evidence, observations, graph, ledger, and certification rows are not
rewritten.

## Rollback

Migration 009 is additive and idempotent. A production rollback requires the
normal protected database restore procedure or a separately reviewed rollback;
the candidate does not drop the lifecycle table. Runtime rollback is safe
only after source #2 is disabled or the migration has been restored with the
same operational window.

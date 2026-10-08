# Canonical Spending Read API v1

This module answers bounded read-only questions such as “how much was spent
today”, “yesterday”, or over an explicit period, and lists confirmed purchases.

Use `queryCanonicalSpending(pool, options)` from
`src/canonical-spending-read-api.js`.

- `period` is `today`, `yesterday`, or `range`.
- `timezone` is explicit and defaults to `Europe/Moscow`.
- `range` requires ISO `from` and `to`; the interval is half-open `[from,to)`.
- `today` and `yesterday` use local calendar midnights in the requested IANA
  timezone; DST days are not assumed to be 24 hours. Range requests are
  bounded to at most 366 days.
- all amounts remain decimal strings grouped by currency; no cross-currency
  arithmetic is performed;
- purchases come only from the snapshot-qualified purchase-grain view;
- returns are separate evidence and never create a second purchase cash flow;
- gross/returns/net totals are computed from period-filtered purchase and return
  grain in the same snapshot. Category and person rows use period-filtered
  allocation grain and retain identifiers/attribution metadata. Lifetime
  summary views are never presented as period totals.
- purchase and return lists use bounded `limit`/`offset` pagination; totals are
  computed over the complete requested period rather than the returned page.
- `statementTimeoutMs` and `lockTimeoutMs` are positive bounded values; zero,
  negative, non-finite, or excessive values fail closed.
- duplicate purchase grain, source-state drift, stale/missing/conflicting or
  corrupt certification fails closed;
- bank-only, unmatched, unclassified and unresolved movements are reported as
  incomplete/excluded, never silently converted to zero.

The query computes and validates the authoritative current snapshot through
`resolveCurrentSpendingSnapshotOnClient`, then reads all views in one
`REPEATABLE READ READ ONLY` transaction. It rolls back before returning the
connection to the pool. It does not invoke materialization, writers, replay,
backfill or persistence.

## Safe connector publication

Do not grant `chatgpt_reader` direct access to canonical `public` tables or
views. A separate reviewed publication should expose only this safe result
through the existing `chatgpt_accounting` connector/curated view, retaining
scope, status, reason code, run id and source-state identity. That publication
is not implemented here.

`READY` means current certified snapshot integrity, not complete personal
spending. A bank-only movement without proven purchase semantics remains
outside certified acquisitions.

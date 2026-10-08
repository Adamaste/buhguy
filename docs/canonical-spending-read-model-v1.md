# Canonical Spending Read Model V1

Status: implementation-stage read-only contract. This document does not
authorize production writes, migrations, deployment, replay, backfill, or
automatic certification materialization.

## Query contract

A spending answer must use one authoritative current certification snapshot:
the caller supplies or resolves one `scopeKey`, one exact `sourceStateKey`, and
one coherent unbounded READY run. A consumer must reject mixed source-state
rows rather than combine snapshots. The snapshot reader remains the authority
for READY, stale, missing, conflict, and corrupt outcomes.

Date filtering is explicit and half-open: `[from,to)`. The default accounting
timezone is `Europe/Moscow`, but callers must be able to provide an explicit
IANA timezone. Query-period metadata is separate from the unbounded
certification period.

## Monetary response

For each currency, expose exact decimal-string values for:

- `certifiedGross`: certified economic acquisition value;
- `certifiedReturns`: certified economic return magnitude;
- `certifiedNet`: gross minus returns;
- `unattributedOrUnresolved`: certified amounts without complete person or
  category attribution;
- `bankOnlyExcludedOrIncomplete`: proven bank movements that are not
  certified economic acquisitions.

Amounts must remain NUMERIC(18,2)-compatible decimal strings. Consumers must
not use JavaScript floating point arithmetic, sum currencies together, or
convert a multi-currency result into one total.

This is a certified-evidence answer, not a claim about all personal spending.
A READY snapshot proves integrity of its current certification state; it does
not prove that every bank-only, unmatched, unknown, or otherwise incomplete
expense is represented.

## Grain and fan-out rules

The monetary base is purchase-grain: one canonical economic purchase
contributes at most once. Item rows are detail grain and may fan out one
purchase into multiple lines; they must never be summed as purchases. Person
and category allocations are separate grains and must reconcile to household
gross, returns, and net with explicit unresolved remainders.

Receipt provenance, including multiple people or evidence rows, is not a
second monetary posting. Bank movement remains the sole monetary funding fact
for a matched purchase. A duplicate notification, replay, ambiguous match,
or conflicting evidence must remain visible as excluded/review-required
state, not become a second purchase.

## Safe answer boundary

A future ChatGPT-facing read-only API may answer “How much did I spend today?”
only by returning the certified per-currency values above, the explicit
unresolved/unattributed buckets, coverage limitations, source-state identity,
and the requested timezone/date window. It must not present certified
acquisitions as the complete volume of personal expenses and must not consume
raw bank notifications, raw fiscal payloads, or writer tables.
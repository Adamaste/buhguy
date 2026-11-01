# Preliminary FNS receipt and bank candidate search

The preliminary report is a read-only research view, separate from the strict
bank/receipt matcher and all accounting writers. It creates candidate edges
only when the numeric bank transaction amount equals `receipts.total_sum` and
the absolute difference between `bank_transactions.occurred_at` and
`receipts.date_time` is at most five minutes. Amounts are compared as exact
decimal values; currencies are deliberately ignored for candidate inclusion.

Merchant labels, currencies, normalized event type, payment stage, account
resolution, source binding, owner evidence, scope, cohort cutoff, existing
match links, and strict matcher decisions are report annotations only. They do
not add or remove candidate edges. Multiple edges connected to the same bank
transaction or receipt are reported as `AMBIGUOUS`; no edge is selected.

The report reads only normalized `bank_transactions` fields and FNS receipt
header/fiscal facts. It never selects `bank_event_observations.payload`, raw
notification text, FNS raw payload, account references, or authentication
material. Existing links with an exact-proof reason are labelled
`SAVED_EXACT`; when the persisted row has no durable approval-status field, the
report labels it `SAVED_STATUS_UNRECORDED` and shows its original
`persistedReasonCode` separately. That reason code is not treated as a current
approval state. `NOOP_ALREADY_PERSISTED` alone does not prove automatic
eligibility: `passesAutomaticAccountingPolicy` is true only when the current
strict preview also carries the configured automatic policy approval basis
and unambiguous assignment policy. Every candidate explicitly says
`ledgerWritesAllowed: false`.

Run locally or in an explicitly approved read-only database environment:

```text
npm run report:receipt-bank-candidates -- --from 2026-09-30T21:00:00.000Z --to 2026-10-26T21:00:00.000Z
```

The interval is half-open and represents October 1–26 in Europe/Moscow. The
reader establishes one `REPEATABLE READ READ ONLY` transaction, applies bounded
statement and lock timeouts, verifies `transaction_read_only`, and rolls back.
The strict matcher preview is run on that same read-only snapshot. A policy
decision is labelled evaluated only when the configured opt-in, canary scope,
automatic policy, and cohort cutoff satisfy the existing reconciliation
contract. This report never invokes reconciliation persistence.

This candidate list is not proof that two records describe one purchase. In
particular, a transfer, return, advance, prepayment, unknown currency or
unresolved account can still appear if its amount and time meet the two search
criteria; its type and blockers remain visible for review. The strict matching
and automatic accounting gates are unchanged.

## Local PostgreSQL integration-test isolation

The default integration fixture does not create the shared `receipt_collector`
role. A suite that validates grants added by migrations opts in to a temporary
role before fixture migrations, then the runner removes its grants and role in
a `finally` block. The role is cluster-wide, while `DROP OWNED` cleans
dependencies only in the current database. Run one suite at a time against one
disposable database; do not prepare several test databases concurrently in the
same PostgreSQL cluster. If `receipt_collector` already exists, fixture setup
stops before changing the test schema; use a fresh isolated PostgreSQL cluster
instead of cleaning up another database's role or grants.

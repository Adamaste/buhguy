# Bank Cash-Flow Projection v1

This slice is a read-only semantic projection over already persisted,
normalized `bank_transactions`. It does not create or update a business event,
ledger entry, reconciliation result, or any bank row.

## Pipeline boundary

The projection reads an immutable observation's normalized transaction facts,
then emits one deterministic result per transaction. A result is `PROJECTED`
only when the transaction is `READY`, its evidence is `EXACT`, and occurred-at,
amount, and currency are present. All other rows are emitted as
`UNRESOLVED` with a bounded reason code.

The supported proven pairs are deliberately narrow:

- `PURCHASE` + `DEBIT` -> `PURCHASE` payment candidate;
- `OUTGOING_TRANSFER` + `DEBIT` -> `OUTGOING_TRANSFER` candidate, never a purchase;
- `INCOMING_TRANSFER` + `CREDIT` -> `INCOMING_TRANSFER` candidate.

Unknown, incomplete, conflicting, or unsupported event facts never promote.
Direction alone never determines a business-event type.

## Account identity boundary

Account identity is concrete only when the separate
`bank_transaction_account_resolution` row names a financial account and has a
proven resolution state (`EXACT`, `MANUAL`, or `RECONCILED`). Source-person
links are accounting context only; they are not payer, beneficiary, or account
ownership proof. Ambiguous source scopes and account/scope conflicts fail
closed.

No payment-instrument inference is performed, and no `INTERNAL_TRANSFER` is
created. Matching both sides of a transfer requires independently proven own-
account identities and belongs to a later reviewed slice.

## Later stages

This output is a candidate projection, not business-event truth. A later slice
may derive business events from the proven movement candidates, followed by a
separate ledger integration decision. Bank-to-receipt matching is also a later
reconciliation slice and remains additional independent purchase evidence; it
is not implemented here.

The PostgreSQL loader is SELECT-only, supports optional half-open occurred-at
period bounds `[from, to)`, and returns a deterministic summary invariant:
`totalTransactions = projectedTransactions + unresolvedTransactions`.

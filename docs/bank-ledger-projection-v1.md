# Bank ledger projection v1

`bank-ledger-projection-v1` is a deterministic, fail-closed, in-memory
projection. It consumes validated balanced bank journals and their business
event candidates, then regenerates the candidates and invokes the official
two-sided internal-transfer matcher. Caller-supplied `INTERNAL_TRANSFER`
objects are never authoritative.

## Pipeline

```text
bank transaction
-> bank-cash-flow-projection-v1
-> balanced-bank-journal-projection-v1
-> bank-business-event-candidate-projection-v1
-> bank-internal-transfer-matching-v1
-> bank-ledger-projection-v1
```

The public pure entry point is:

```js
projectBankLedger(entries, ownershipSnapshot, { maxTimeDeltaMs })
```

Each entry is `{ journal, candidate }`. Journals and candidates are
revalidated, source identities must be unique, and invalid or incoherent
inputs are returned as `UNRESOLVED` without a ledger entry. Ledger-invalid
sources are filtered out before internal-transfer matching, so they cannot be
consumed by a matcher result. The output is
content-addressed and independent of input order. Money is a canonical string
with exactly two decimal places and is never converted to a JavaScript number.

## Semantics

Standalone entries reuse the exact validated upstream journal postings:

- `PURCHASE` remains `PURCHASE` and is not broadened into expense semantics.
- unmatched `OUTGOING_TRANSFER` remains directional outgoing transfer.
- unmatched `INCOMING_TRANSFER` remains directional incoming transfer.
- exact unknown event semantics with proven direction remains
  `UNCLASSIFIED_MONETARY_MOVEMENT`.
- ambiguous matcher components remain standalone; proven money is not dropped.

Only one proven matcher result can produce `INTERNAL_TRANSFER`. Its two
source candidates are consumed and collapse to one entry with exactly two
postings: debit the concrete incoming financial account and credit the
concrete outgoing financial account. The entry `occurredAt` is the outgoing
candidate time; the incoming time remains in provenance. No symbolic
counter-side postings are emitted for the consumed pair.

Unresolved bank identity remains `UNRESOLVED_BANK_ACCOUNT`; it is not a
financial-account identity. Only the approved symbolic accounts are accepted.
Every projected entry has exactly one debit, one credit, equal exact amount
and currency, and positive money.

## Persistence boundary

V1 does not write ledger, business-event, receipt, reconciliation, or any
other table. The existing `src/ledger.js` is not reused for this projection:
its persistence contract requires a persisted business-event source id and
receipt/business-event evidence links, performs Number-based money
calculations, defaults missing currency to historical RUB behavior, and its
database postings use `NUMERIC(14,2)`. Bank transactions use a wider
`NUMERIC(18,2)` contract. A future persistence design must introduce an
appropriate bank-source provenance/idempotency model; no migration is part of
this slice.

The optional `loadBankLedgerProjection` helper performs SELECT-only loading:
it loads balanced journals once, derives candidates in memory, loads ownership
only for eligible directional transfer accounts once, and then calls the pure
projection. It does not invoke the old matcher loader or any DML.

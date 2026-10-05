# Bank Business-Event Candidate Projection V1

This slice is a deterministic, fail-closed, non-mutating projection after the
existing bank cash-flow and balanced-journal projections:

`bank transaction -> bank-cash-flow-projection-v1 -> balanced-bank-journal-projection-v1 -> bank-business-event-candidate-projection-v1`

It consumes only `balanced-bank-journal-projection-v1` output. Its loader
delegates to `loadBalancedBankJournalProjection`; it does not issue a separate
bank SQL query and never reads raw notification payloads.

## Accepted journal contract

A candidate is projected only from a `PROJECTED` journal with the exact model
version, a 64-character content key, positive bank transaction id, non-empty
scope, valid event time, canonical decimal amount, uppercase three-letter
currency, and exactly one debit and one credit posting. Both postings must
carry the exact top-level amount and currency. The bank side and counter-side
must match the established direction and symbolic-account mapping.

The journal provenance must identify the cash-flow projection version and key,
the same bank transaction id, and the source reason/status. Malformed,
tampered, incomplete, or semantically inconsistent journals become
`UNRESOLVED` with `candidateKey=null`.

## Candidate mappings

| Journal evidence | Candidate kind | Business event type | Transfer direction |
| --- | --- | --- | --- |
| `PURCHASE + DEBIT` | `PURCHASE` | `PURCHASE` | none |
| `OUTGOING_TRANSFER + DEBIT` | `TRANSFER` | `TRANSFER` | `OUTGOING` |
| `INCOMING_TRANSFER + CREDIT` | `TRANSFER` | `TRANSFER` | `INCOMING` |
| exact `UNKNOWN + DEBIT/CREDIT` | `UNCLASSIFIED_MONETARY_MOVEMENT` | null | null |

The unknown mapping preserves proven monetary movement without inventing
purchase, income, expense, counterparty, payer, beneficiary, or transfer
meaning. No path emits `INTERNAL_TRANSFER`; two-sided matching is a later
evidence-backed slice.

## Identity and deterministic output

The candidate preserves the journal bank side, including the symbolic
`UNRESOLVED_BANK_ACCOUNT` when account identity is not proven. It never derives
an account from provider, source ownership, device, card context, or scope.

`candidateKey` is a SHA-256 content fingerprint of this projection version,
the upstream `journalKey`, bank transaction id, and semantic candidate fields.
No timestamp, array position, or random value participates in identity. Money
remains an exact decimal string without floating-point conversion.

The output preserves a safe provenance chain to the journal key, cash-flow
projection key, bank transaction id, source movement/reason, and account
resolution state. It contains no raw notification content or secrets and no
receipt, ledger, or persisted business-event identifiers.

## Persistence boundary

This v1 is in-memory/read-only. It does not call `BusinessEventGraphRepository`
or write `business_events`, `business_event_evidence`, ledger, reconciliation,
or receipt tables. The current business-event evidence and allocation tables
are receipt/item-fiscal-fact oriented and their repository APIs persist graph
state. A future integration therefore needs a separately reviewed
evidence/persistence design; bank transactions must not be shoehorned into a
receipt field.

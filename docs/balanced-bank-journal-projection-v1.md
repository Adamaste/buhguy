# Balanced Bank Journal Projection V1

This slice consumes `bank-cash-flow-projection-v1` output and produces
deterministic, non-mutating journal candidates. It does not write ledger,
business-event, or reconciliation tables and does not perform receipt matching
or `INTERNAL_TRANSFER` matching.

## Balanced monetary rule

Every projected candidate has exactly two postings, one `DEBIT` and one
`CREDIT`, with identical exact decimal amount strings and currency. Amounts
are canonicalized as strings without JavaScript floating-point arithmetic.
The projection preserves the source bank transaction, cash-flow projection
version/key, scope, occurred-at, direction, and reason provenance.

The bank side is a concrete `FINANCIAL_ACCOUNT` reference only when the source
cash-flow projection has concrete account identity. Otherwise it is the
symbolic `UNRESOLVED_BANK_ACCOUNT`; this symbol is not account identity proof.

## Mappings

| Source evidence | Debit | Credit |
| --- | --- | --- |
| `PURCHASE + DEBIT` | `UNCLASSIFIED_PURCHASE` | bank side |
| `OUTGOING_TRANSFER + DEBIT` | `UNCLASSIFIED_OUTGOING` | bank side |
| `INCOMING_TRANSFER + CREDIT` | bank side | `UNCLASSIFIED_INCOMING` |
| exact `UNKNOWN + DEBIT` | `UNCLASSIFIED_OUTGOING` | bank side |
| exact `UNKNOWN + CREDIT` | bank side | `UNCLASSIFIED_INCOMING` |

`UNKNOWN` event semantics do not discard a proven monetary movement. The
`UNKNOWN` exception is narrow: source reason must be exactly
`EVENT_TYPE_UNKNOWN`, normalization must be `READY`, evidence quality must be
`EXACT`, amount/currency/occurred-at/scope must be present and valid, and
direction must be exactly `DEBIT` or `CREDIT`.

Direction only chooses which side is the bank side. It does not prove
purchase, income, salary, counterparty, or `INTERNAL_TRANSFER`. The
`UNCLASSIFIED_*` labels are bounded monetary semantics, not business
classification.

If direction is `UNKNOWN`, or required monetary/scope evidence is missing or
conflicting, the result has zero postings and remains `UNRESOLVED`. Other
cash-flow failure reasons, including ambiguous scope, account scope conflict,
non-ready/non-exact evidence, incomplete facts, direction conflict, and
unsupported event type, remain fail-closed.

## Loader boundary

`loadBalancedBankJournalProjection` delegates to the existing cash-flow
loader. The database interaction is `SELECT`-only; counts are unchanged by
the loader. Persistence, ledger integration, business-event creation,
reconciliation, receipt matching, and production E2E are future work.

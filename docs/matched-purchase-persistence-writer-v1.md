# Matched purchase persistence writer v1

`matched-purchase-persistence-v1` is the atomic write boundary for a reviewed
bank-to-receipt match. It accepts no caller-supplied projection as authority:
matching and enrichment are recomputed from the transaction client, then the
scope, bank transaction, receipt, and deterministic match identity are locked
before any mutation.

The transaction persists or validates one immutable `bank_receipt_matches`
row, one confirmed `PURCHASE` event with receipt evidence, one
`business_event_bank_evidence` row, one deterministic
`FINANCIAL_ACCOUNT:<financial_account_id>` ledger mapping, and one balanced
bank-funded active ledger entry. The bank movement is the sole funding fact;
the entry debits `UNCLASSIFIED_ACQUISITION` and credits the mapped financial
account. A fiscal-clearing entry is refined only by an append-only
supersession relation. Certification is refreshed from the resulting active
ledger state, so the matched entry does not create positive `FISCAL_NEW_MONEY`.

Every existing immutable row is semantically revalidated on replay. Conflicting
scope, amount, currency, provenance, account mapping, purchase, ledger,
supersession, or match state fails closed and rolls back the whole transaction.
The writer is deterministic and idempotent under repeated or concurrent calls;
it does not expose a CLI/HTTP path and is not production-wired in this stage.

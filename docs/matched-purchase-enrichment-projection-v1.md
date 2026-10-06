# Matched purchase enrichment projection v1

`matched-purchase-enrichment-projection-v1` is a deterministic, in-memory,
non-mutating plan over one `MATCHED` result from
`bank-receipt-matching-v1`. It does not create a business event, receipt
relationship, ledger entry, or second cash flow.

The bank movement remains the sole monetary funding fact. The receipt adds
purchase/acquisition evidence and fiscal detail. A compatible confirmed
`PURCHASE` is reused; no active purchase produces a deterministic proposed
identity; competing or contradictory active state fails closed.

The projection preserves both `bankOccurredAt` and `receiptDateTime` without
choosing a canonical economic timestamp. It never infers payer, purchase
owner, merchant, counterparty, income, expense, or `INTERNAL_TRANSFER` from
account ownership or source context.

For the current standalone fiscal shape, the read-only plan recognizes exactly
`Dr UNCLASSIFIED_ACQUISITION / Cr FISCAL_PAYMENT_CLEARING` for the same event,
amount, currency, and scope. It returns `REFINE_EXISTING_FISCAL_FUNDING` rather
than emitting another posting. Without that persisted shape it returns
`FUTURE_SINGLE_LEDGER_ENTRY_REQUIRED`; malformed or multiple entries return
`LEDGER_CONFLICT`.

The future target is only a semantic plan:
`Dr UNCLASSIFIED_ACQUISITION / Cr FINANCIAL_ACCOUNT`, using the exact matched
amount, currency, scope, and resolved bank account. It is not persistence.

Persistence is explicitly blocked in v1 because `business_event_evidence` is
receipt-only, `ledger_source_links` cannot link bank evidence, persisted
ledger has no reviewed supersession mechanism for replacing fiscal clearing,
and financial-account identity has no reviewed persisted ledger-account
mapping. The optional loader performs SELECT-only reads and never invokes
`persistStandalonePurchases`, `rebuildLedger`, `refreshLedgerForReceipt`,
certification persistence, or graph repository mutation methods.

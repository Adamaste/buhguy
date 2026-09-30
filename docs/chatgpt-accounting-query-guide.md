# ChatGPT Accounting Query Guide

## Routing

### Ordinary analytics

Start with `analytics_purchases` and `analytics_purchase_items` for spending,
products, sellers, price history, and period summaries. Do not reconstruct
purchase totals from raw receipts when these curated views answer the question.

### Why a result has a particular value

Traverse `receipts -> receipt_fiscal_facts -> business_events -> ledger_entries
and ledger_postings -> certification_facts -> analytics_*`. Report the layer
that made the decision and the evidence supporting it.

### Money movement

Use `ledger_entries`, `ledger_postings`, `certification_facts`, and related
business events for certified accounting movement. For bank evidence itself,
use `chatgpt_accounting.bank_transactions`; never claim bank cash flow from
`SUM(receipts.total_sum)`.

### Bank transactions

Start with `bank_transactions`, which is one row per normalized transaction.
Filter explicitly on `normalization_status`, `normalization_version`,
`event_type`, `direction`, `currency`, and `evidence_quality`. Join the
transaction-grain resolution views on `bank_transaction_id`:

- `bank_transaction_account_resolution` for `EXACT`, `MANUAL`, `RECONCILED`,
  or `UNKNOWN` account state and the safe resolved-account label;
- `bank_transaction_payment_instrument_resolution` for separate card or
  payment-instrument evidence;
- `bank_transaction_person_context` for aggregated capture context only.

Use an explicit account resolution (and its proven account-person relation)
for questions about “my” bank account. Never treat source-person context as
ownership, never infer an account from a card, and never convert UNKNOWN or
PARTIAL evidence into a person assignment. Do not join raw source-person
rows directly to transactions because that can multiply amounts.

The current proven operation envelope is Sber incoming/CREDIT v3. Yandex
remains a deployed provider normalizer; T-Bank, Alfa, Ozon, and VTB remain
incremental evidence coverage rather than assumptions of READY semantics.

### Items

Use `analytics_purchase_items` for ordinary item analysis. Use
`receipt_items` plus the proof chain for forensic analysis. An item line is not
an independent purchase.

### Prepayment, settlement, advance, return, and refund

Inspect `business_events`, `business_event_edges`, `business_event_evidence`,
`ledger_entries`, `ledger_postings`, and `certification_facts`. Do not add
prepayment and settlement as two independent purchases.

### Source ownership and provenance

Use `persons`, `fns_sources`, `fns_source_person`,
`receipt_source_observations`, and `fns_source_receipt_refs`. State explicitly
that source provenance means “observed through this FNS source”; it does not
prove payer, owner, or bank-account holder.

### Completeness and duplicates

Use `fns_source_receipt_refs`, `receipt_source_observations`, `receipts`, and
`fns_source_sync_state`. Test canonical identity using `receipts.fns_id`, not
person/source identity. Multiple observations are not duplicate receipts.

### Accounting gaps

Check normalization, graph, ledger, certification, then analytics. Treat
explicit non-acquisition, blocked, unresolved, and unavailable states as
classified outcomes unless the model says they are defects.

## Prohibited conclusions

Do not infer a precise amount when evidence is incomplete. Do not equate a
receipt with a purchase, a source person with a payer, a missing component with
zero, or `BLOCKED_EXPOSURE` with certified acquisition.

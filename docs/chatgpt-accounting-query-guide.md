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
business events. Never claim bank cash flow from `SUM(receipts.total_sum)`;
there is no bank evidence in this semantic layer.

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

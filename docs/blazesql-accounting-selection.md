# BlazeSQL Accounting Selection Manifest

## Selection procedure

1. Refresh the database schema in BlazeSQL.
2. Expand schema `chatgpt_accounting`.
3. Select every view listed below.
4. Do not select duplicate `public.*` raw/internal objects.
5. Save the selection and verify the schema through the read-only role.

For receipt existence, history, provenance, and user-specific questions, use
`chatgpt_accounting.user_receipts`. It is the canonical household-person
receipt inventory and excludes observations from disabled historical sources.
Use `chatgpt_accounting.analytics_purchases` for certified-fact drill-down; it
is not a complete receipt inventory and is not safe for an unqualified
monetary sum. It has one row per `certification_fact_id`; the same
`purchase_id` may repeat across facts or certification runs. Its public
projection omits the run/source-state tuple needed to select the current
snapshot. Use the current-snapshot spending reader for totals. In that view,
`seller` is the official FNS seller, while `bank_merchant` is the separate name from an
unambiguous linked bank transaction. `bank_merchant_source`
reports its source type (`ANDROID_NOTIFICATION`, `BANK_API`, or
`MANUAL_IMPORT`).
`merchant_display` prefers the bank name and reports its source in
`merchant_display_source`; it never replaces either source-specific field.
When joining `analytics_purchase_items` for detail, join on both
`purchase_id` and `certification_fact_id`. Never sum purchase amounts after
joining items, receipt observations, or person provenance.

## Current limitation for monetary totals

The existing BlazeSQL semantic schema does not expose the validated
current-snapshot reader, its snapshot-qualified canonical spending views, or
ledger supersession identity. Therefore it cannot safely produce a complete
current spending total by summing `analytics_purchases` or `ledger_entries`.
Use BlazeSQL's `chatgpt_accounting` views for read-only drill-down only; for a
defensible total, use the server-side read-only current-snapshot reader or the
read-only reconciliation report prepared with this change. This change does
not create a view, grant, or production object. Exposing the snapshot reader
inside BlazeSQL requires a separately reviewed and authorized read-only
semantic-layer change.

## Required views

- [ ] `chatgpt_accounting.receipts`
- [ ] `chatgpt_accounting.receipt_items`
- [ ] `chatgpt_accounting.receipt_fiscal_facts`
- [ ] `chatgpt_accounting.receipt_item_fiscal_facts`
- [ ] `chatgpt_accounting.normalization_issues`
- [ ] `chatgpt_accounting.business_events`
- [ ] `chatgpt_accounting.business_event_evidence`
- [ ] `chatgpt_accounting.business_event_edges`
- [ ] `chatgpt_accounting.business_event_allocations`
- [ ] `chatgpt_accounting.ledger_accounts`
- [ ] `chatgpt_accounting.ledger_entries`
- [ ] `chatgpt_accounting.ledger_postings`
- [ ] `chatgpt_accounting.ledger_source_links`
- [ ] `chatgpt_accounting.certification_facts`
- [ ] `chatgpt_accounting.receipt_source_observations`
- [ ] `chatgpt_accounting.user_receipts`
- [ ] `chatgpt_accounting.fns_source_receipt_refs`
- [ ] `chatgpt_accounting.persons`
- [ ] `chatgpt_accounting.fns_sources`
- [ ] `chatgpt_accounting.fns_source_person`
- [ ] `chatgpt_accounting.fns_source_sync_state`
- [ ] `chatgpt_accounting.analytics_purchases`
- [ ] `chatgpt_accounting.analytics_purchase_items`
- [ ] `chatgpt_accounting.reconciliation_runs`
- [ ] `chatgpt_accounting.reconciliation_results`
- [ ] `chatgpt_accounting.bank_sources`
- [ ] `chatgpt_accounting.bank_transaction_account_resolution`
- [ ] `chatgpt_accounting.bank_transaction_payment_instrument_resolution`
- [ ] `chatgpt_accounting.bank_transaction_person_context`
- [ ] `chatgpt_accounting.bank_transactions`

## Do not select

- `public.receipt_raw`;
- `public.bank_event_observations` and any bank raw/evidence payload;
- raw source-event identifiers, payload hashes, credentials, and device references;
- bank source keys and device/source identifiers;
- session, token, cookie, password, or secret configuration objects;
- internal `public.*` tables when the corresponding semantic view exists.

The `chatgpt_reader` role receives only schema `USAGE` and `SELECT` on the
listed views. It receives no write, ownership, DDL, sequence, or source-table
privileges.

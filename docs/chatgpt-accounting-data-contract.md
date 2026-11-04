# ChatGPT Accounting Data Contract

## Scope

`chatgpt_accounting` is a read-only semantic layer. It exposes curated views
for accounting analysis and audit while excluding `receipt_raw`, session
references, device references, tokens, cookies, passwords, and secret
configuration. The views do not change production data.

## Authoritative precedence

For accounting meaning, use this order:

1. `certification_facts` and `ledger_*`;
2. `business_events`, `business_event_*`;
3. `receipt_fiscal_facts` and normalization views;
4. fiscal receipt fields;
5. `analytics_*` as the convenient ordinary-analytics surface.

If an analytics result conflicts with the proof chain, investigate the proof
chain rather than selecting the more convenient number.

## Global semantics

- A receipt is not automatically a purchase.
- `receipts.total_sum` is not confirmed cash flow.
- An FNS source person is not necessarily the payer or economic owner.
- Multiple source observations can describe one canonical receipt.
- Missing, unresolved, blocked, or unavailable evidence is not zero.
- `BLOCKED_EXPOSURE` is an explicit accounting result, not a certified acquisition.
- A fiscal payment is not a confirmed bank payment.
- Prepayment and settlement must not be counted as two purchases.
- Bank transactions are immutable normalized evidence. `READY` means the
  provider parser proved the stored envelope, not that a payer, owner, or
  accounting entry was proved.
- Account assignment is read from the explicit transaction-resolution row.
  Source-person context is not account ownership proof, and a card reference
  never infers a financial account.

## View grain and joins

| View | One row means | Join key / cardinality |
| --- | --- | --- |
| `receipts` | One canonical receipt | `id`; one receipt has 0:N `receipt_items` |
| `receipt_items` | One item position | `receipt_id -> receipts.id`; N:1 |
| `receipt_fiscal_facts` | One receipt/version normalization | `(receipt_id, normalization_version)` |
| `receipt_item_fiscal_facts` | One item/version normalization | `(receipt_item_id, normalization_version)` |
| `normalization_issues` | One issue | `receipt_id` and optional `receipt_item_id` |
| `business_events` | One graph event | `id`; evidence/edges/allocations are 1:N |
| `business_event_evidence` | One event-to-evidence link | `event_id -> business_events.id` |
| `business_event_edges` | One directed event relation | `source_event_id`, `target_event_id`; N:M through edges |
| `business_event_allocations` | One allocation to an event | `target_event_id -> business_events.id` |
| `ledger_accounts` | One account in a scope | `(scope_id, id)` |
| `ledger_entries` | One ledger entry | `source_event_id -> business_events.id`; one entry has 1:N postings |
| `ledger_postings` | One debit or credit posting | `ledger_entry_id -> ledger_entries.id` |
| `ledger_source_links` | One audit link | `ledger_entry_id`, `business_event_id`, optional `receipt_id` |
| `certification_facts` | One certification metric for a subject | optional `ledger_entry_id`, `business_event_id`, `graph_evidence_id` |
| `receipt_source_observations` | One source observation of a canonical receipt | `fns_source_id`, `receipt_id`; many observations can map to one receipt |
| `fns_source_receipt_refs` | One source reference lifecycle | `(fns_source_id, source_receipt_id)` |
| `persons` | One accounting person metadata row | `id`; map through `fns_source_person` |
| `fns_sources` | One FNS source, without auth material | `id`; map through `fns_source_person` |
| `fns_source_person` | One source-person association | `(fns_source_id, person_id)` |
| `fns_source_sync_state` | One source sync state | `fns_source_id` |
| `analytics_purchases` | One certified acquisition fact; one business purchase can repeat across facts/runs | `certification_fact_id`; not safe to sum across the whole view |
| `analytics_purchase_items` | Item lines attached to one certified acquisition fact | `(purchase_id, certification_fact_id, item_position)`; item-grain only |
| `reconciliation_runs` | One reconciliation run | `id`; results are 1:N |
| `reconciliation_results` | One reconciliation metric | `run_id -> reconciliation_runs.id` |
| `bank_sources` | One bank capture source | `id`; source type/display metadata only, without source key |
| `bank_transactions` | One normalized bank transaction | `id`; one row per transaction; resolution/context columns are 1:1 or aggregated |
| `bank_transaction_account_resolution` | One account-resolution result | `bank_transaction_id`; UNKNOWN remains visible |
| `bank_transaction_payment_instrument_resolution` | One payment-instrument result | `bank_transaction_id`; separate from account resolution |
| `bank_transaction_person_context` | One aggregated source-person context | `bank_transaction_id`; context only, never account ownership |

## Canonical traversals

1. Receipt to items: `receipts.id = receipt_items.receipt_id`.
2. Receipt to provenance: `receipts.id = receipt_source_observations.receipt_id`, then `receipt_source_observations.fns_source_id = fns_sources.id`, then `fns_source_person` and `persons`.
3. Receipt to graph: `business_event_evidence.receipt_id = receipts.id`, then `event_id = business_events.id`.
4. Event to ledger: `ledger_entries.source_event_id = business_events.id`, then `ledger_postings.ledger_entry_id = ledger_entries.id`.
5. Event to certification: `certification_facts.business_event_id = business_events.id`.
6. Purchase to items: join `analytics_purchases` to `analytics_purchase_items` on both `purchase_id` and `certification_fact_id`. For totals, use one validated current snapshot from `canonical_spending_purchases_v1` or the current-snapshot reader; never sum across certification facts/runs.
7. FNS reference to canonical receipt: `fns_source_receipt_refs.receipt_id = receipts.id` when status is `RESOLVED`.
8. Person to source to observations: `persons.id = fns_source_person.person_id`, `fns_source_person.fns_source_id = fns_sources.id`, then `receipt_source_observations.fns_source_id = fns_sources.id`.
9. Bank transaction to normalized evidence: `bank_transactions.id = bank_transaction_account_resolution.bank_transaction_id` and the analogous payment-instrument/context views. Do not join bank source-person rows directly to transaction amounts; use the aggregated context view to avoid fan-out.

## Bank assistant semantics

The transaction view exposes `event_type`, `direction`, `amount`, `currency`,
`normalization_status`, `normalization_version`, and `evidence_quality`. It
also exposes explicit account and payment-instrument resolution states,
  safe display labels only for resolved identities, relation-safe owner and
  authorized-user person ids, and aggregated source-person context. Unresolved
  values remain visible as `UNKNOWN` or NULL rather than
being assigned to a person.

The current provider-operation evidence envelope is:

| Provider | Incoming / CREDIT | Outgoing / DEBIT |
| --- | --- | --- |
| Sber (`ru.sberbankmobile`) | PROVEN: current v3 envelope, including Person 1 account `0271` path | NOT_PROVEN |
| T-Bank (`com.idamob.tinkoff.android`) | NOT_PROVEN | NOT_PROVEN |
| Alfa (`ru.alfabank.mobile.android`) | NOT_PROVEN | NOT_PROVEN |
| Yandex (`com.yandex.bank`) | PROVEN only to the extent supported by the deployed v1 parser/evidence | NOT_PROVEN |
| Ozon Finance (`ru.ozon.fintech.finance`) | NOT_PROVEN | NOT_PROVEN |
| VTB (`ru.vtb24.mobilebanking.android`) | NOT_PROVEN | NOT_PROVEN |

This matrix is an evidence-routing guide, not a promise that every provider
currently reaches `READY`. Unsupported or ambiguous envelopes remain
`PARTIAL`/`UNKNOWN` and are not promoted by assistant queries.

`FNS_DETAIL_UNAVAILABLE` means the reference exists but detail evidence is
unavailable; it must not be silently converted into a missing or zero receipt.

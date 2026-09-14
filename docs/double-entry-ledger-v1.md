# Double-Entry Ledger V1

## Status

Implemented and validated locally and on a disposable PostgreSQL 18.6 clone. Production schema, data, timers and BlazeSQL permissions were not changed. The ledger is a downstream derivation of confirmed Business Event Graph rows, never of raw receipts directly.

## Schema

Migration `006_double_entry_ledger.sql` adds four generic tables:

- `ledger_accounts`: scoped technical/control account catalog.
- `ledger_entries`: one deterministic entry per derivation rule and confirmed source business event.
- `ledger_postings`: NUMERIC debit/credit postings with account and optional allocation/receipt reference.
- `ledger_source_links`: proof links from ledger entry to business event, graph evidence/allocation and fiscal receipt.

Every entry stores scope, currency, event time, semantic key, derivation rule/version, status, certification status and origin. Every posting is one-sided and non-zero; balancing is checked with exact PostgreSQL NUMERIC arithmetic.

The canonical currency for current FNS monetary values is explicit `RUB`. This is a currency convention for FNS amounts, not an invented bank account. Certification remains `FUNDING_UNRECONCILED` until bank/cash reconciliation exists.

## Accounts

| Code | Type | Meaning |
|---|---|---|
| `MERCHANT_ADVANCE` | ASSET | Value prepaid to a merchant before fulfillment |
| `FISCAL_PAYMENT_CLEARING` | CONTROL | Fiscal new-money evidence pending bank/cash reconciliation |
| `UNCLASSIFIED_ACQUISITION` | CONTROL | Confirmed acquisition before final expense/asset categorization |
| `MERCHANT_REFUND_RECEIVABLE` | RECEIVABLE | Return value owed by merchant before refund is proven |

No real bank or cash account is fabricated.

## Rules

`LEDGER_PREPAYMENT_V1` posts `Dr MERCHANT_ADVANCE / Cr FISCAL_PAYMENT_CLEARING`.

`LEDGER_FULFILLMENT_V1` posts `Dr UNCLASSIFIED_ACQUISITION / Cr MERCHANT_ADVANCE`; it creates no second cash outflow.

`LEDGER_STANDALONE_PURCHASE_V1` posts only normalized cash plus electronic-cash components: `Dr UNCLASSIFIED_ACQUISITION / Cr FISCAL_PAYMENT_CLEARING`. Unsupported or zero-new-money cases are `BLOCKED`.

`LEDGER_RETURN_V1` uses confirmed graph allocations and posts `Dr MERCHANT_REFUND_RECEIVABLE / Cr UNCLASSIFIED_ACQUISITION`. It requires the target purchase to have ready ledger coverage. It never creates a cash/bank refund.

`REFUND` is designed for future independently proven monetary refund evidence. Current production has zero `REFUND` events, so no refund postings are generated.

Unsupported confirmed graph events are represented explicitly as `LEDGER_UNSUPPORTED_V1` blocked entries with no postings; they do not disappear and do not block source ingestion.

## Certification

- `BUSINESS_CONFIRMED`: reserved for a future fully certified accounting state.
- `FUNDING_UNRECONCILED`: current ready ledger entries; business graph is confirmed but funding source is not bank-reconciled.
- `BLOCKED`: no safe V1 posting exists.

Balanced postings do not imply accounting certification.

## Current Production Projection

Read-only projection against the current 129-event production graph on a disposable clone:

| Rule | Entries | Postings | Status | Debit/Credit total |
|---|---:|---:|---|---:|
| `LEDGER_PREPAYMENT_V1` | 38 | 76 | 38 READY | 98,042.00 / 98,042.00 |
| `LEDGER_FULFILLMENT_V1` | 38 | 76 | 38 READY | 98,042.00 / 98,042.00 |
| `LEDGER_STANDALONE_PURCHASE_V1` | 7 | 12 | 6 READY, 1 BLOCKED | 2,682.29 / 2,682.29 |
| `LEDGER_RETURN_V1` | 8 | 14 | 7 READY, 1 BLOCKED | 2,683.29 / 2,683.29 |
| `LEDGER_UNSUPPORTED_V1` | 38 | 0 | 38 BLOCKED | 0 / 0 |

Total: `129` entries, `178` postings, `40` blocked entries, exact balance violations `0`.

Ready monetary dimensions:

- merchant advance created: `98,042.00`;
- merchant advance consumed by fulfillment: `98,042.00`;
- standalone acquisition supported: `2,682.29`;
- fiscal payment clearing movement: `100,724.29` credit;
- refund receivable supported: `2,683.29`;
- bank spending reported: not inferred;
- one standalone purchase and its return remain blocked because purchase ledger coverage is not ready.

## Golden Cases

The generic Xiaomi lifecycle is receipt `62` prepayment and receipt `54` fulfillment, both `32,380.00`:

- prepayment creates exactly one `32,380.00` clearing credit and advance debit;
- fulfillment creates exactly one `32,380.00` acquisition debit and advance credit;
- final merchant advance balance is zero;
- no `64,760.00` cash outflow is created.

The generic return test creates acquisition and then a return receivable. It leaves bank/cash refund at zero because `RETURN != REFUND`.

## Rebuild and Safety

`ledger project` is read-only. `ledger rebuild --persist` is idempotent and preserves manual/external rows. The destructive full `ledger rebuild --persist --replace` path is explicitly refused when certification facts reference system-derived ledger rows, because deleting those rows would violate the certification foreign key and would be an unsafe cross-layer operation. Bounded replacement for an affected event component remains the production path; a full rebuild must be coordinated on a disposable clone with certification data handled explicitly. Semantic keys and PostgreSQL uniqueness prevent duplicate entries/postings under concurrent builders. Injected failure rolls back the entire ledger transaction.

## Validation

- Local full suite: `81 PASS`, `0 FAIL`, `1 optional PostgreSQL test skipped` (`82` total without `TEST_DATABASE_URL`).
- Disposable PostgreSQL 18.6 integration suite: `1/1 PASS`, including idempotency, 25-worker concurrency, rollback, balance and source-data invariants.
- Disposable PostgreSQL 18.6 integration: `PASS`.
- First clone build: `129` entries, `178` postings, `96` source links, `0` balance violations.
- Second build: `0` new entries, `0` new postings, `0` new links.
- 25 concurrent builders: no duplicates or errors.
- Injected mid-build failure: rollback preserved the previous ledger.
- Clone source counts: receipts `1703`, items `5792`, raw `1703`.
- Clone graph counts: events `129`, edges `84`, allocations `8`.
- Graph validator: `PASS`.
- BlazeSQL permissions: not changed; no ledger tables granted.

Production deployment is intentionally not authorized or performed.
# Historical audit snapshot

Any counts in this document describe a disposable validation snapshot only and are not current production guarantees.

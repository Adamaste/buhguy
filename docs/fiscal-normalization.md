# Phase 1B Fiscal Normalization

Status: local implementation and verification only. Migration `004_fiscal_normalization.sql` is not deployed to production by this task.

## Boundary and design

`receipt_raw` and the fiscal columns in `receipts` remain source evidence. Phase 1B adds derived tables rather than rewriting that evidence:

- `receipt_fiscal_facts`: one row per receipt and `normalization_version`;
- `receipt_item_fiscal_facts`: one row per source item and version;
- `normalization_issues`: rebuildable, safe diagnostic facts.

No purchase, settlement link, return match, ledger, category, or financial report is created.

The current version is `fiscal-normalizer-v1`. Every result stores the Phase 1A source SHA-256 and a SHA-256 of the canonical normalized semantic object. Generated timestamps and database IDs are excluded from semantic content. Object keys are sorted; arrays retain order.

## Raw mappings

The mappings use only verified `receipt_raw.payload` paths:

| Normalized fact | Raw path | Semantics |
|---|---|---|
| `ffd_version_code` | `$.fiscalDocumentFormatVer` | source FFD code |
| `ffd_version` | same | `2 -> 1.05`, `3 -> 1.1`, `4 -> 1.2` |
| `fiscal_operation_type` | `$.operationType` | existing normalized 1..4 semantics |
| component values | `$.cashTotalSum`, `$.ecashTotalSum`, `$.prepaidSum`, `$.creditSum`, `$.provisionSum` | exact NUMERIC values |
| item payment | `$.items[*].paymentType` | item-scoped code 1..7 |
| item product | `$.items[*].productType` | preserved numeric fiscal code; no legal range invented |
| provider | `$.items[*].providerInn` | provider identity, separate from seller |
| product codes | `$.items[*].productCodeNew.code.gtin`, `rawProductCode` | optional fiscal evidence |

`payment_stage` is derived from the set of item payment codes and may be `MIXED`; it is never a receipt-level source `paymentType`.

## States and issues

Component states are explicit: `PRESENT_VALUE`, `EXPLICIT_ZERO`, `FIELD_MISSING`, `FIELD_NOT_SUPPORTED`, and `FIELD_INVALID`. Missing is never converted to zero. Known FFDs with complete exact components are `RECONCILED`; missing/invalid components are `INCOMPLETE`; an exact sum mismatch is `MISMATCH`; unknown FFD is `UNSUPPORTED`.

Unknown FFD produces `UNKNOWN_FFD_VERSION` and does not guess a semantic version. Other issues include `INVALID_OPERATION_TYPE`, `INVALID_PAYMENT_COMPONENT`, `INVALID_PAYMENT_TYPE`, `INVALID_PRODUCT_TYPE`, and `PAYMENT_COMPONENT_MISMATCH`. A normalization problem blocks only derived facts; the source receipt, items, and raw evidence remain valid.

Correction is `CORRECTION` only when a verified `correction` object is present. Otherwise known FFDs remain `UNKNOWN`, not silently `NORMAL`; unknown FFDs are `UNSUPPORTED`.

Household direction is deliberately separate from fiscal operation: 1/4 -> `OUT`, 2/3 -> `IN` in the FNS seller/customer context. This is not a ledger posting.

## Incremental, backfill, rebuild

`sync` stores new fiscal facts after the source transaction commits. A normalizer exception is reported as `fiscal_normalization_failure` without deleting valid evidence, and later receipts in the same page/run continue. When normalization is enabled, the result reports `source_ingest_success_count`, `normalization_ready_count`, `normalization_blocked_count`, `normalization_unsupported_count`, and `normalization_failed_count` separately. A non-ready normalization result makes the CLI exit non-zero only after the available source list has been processed.

Source progress is not gated on derived READY status: the current sync persists source evidence for every detail that succeeds and records run timestamps in `sync_state`; it does not hold a source cursor behind a blocked derived row. A blocked/unsupported receipt can be retried later with `normalize` or `normalize --rebuild` without re-ingesting a duplicate source bundle. This separation prevents poison-record starvation after a process restart.

`receipt-collector normalize` performs an idempotent backfill. `receipt-collector normalize --rebuild` deletes only derived Phase 1B tables and rebuilds them from `receipt_raw`; this is a development/test operation and is not run against production by this task.

## Invariants

Source tables are not updated by normalization. One receipt/item has at most one result per version. The same source and version produce the same semantic hash. Item payment remains item-scoped, mixed payment remains visible, mismatch is explicit, and no business purchase relationship exists. Derived rows can be rebuilt without raw payload rewriting.

## Verification

Verification completed locally: 44/44 unit tests, 14/14 PostgreSQL integration tests, and the syntax check passed. The PostgreSQL suite covers migration from zero, the 001->004 chain, derived-table schema, normalization backfill/rebuild, source preservation, failure injection, unsupported/mismatch poison receipts, restart continuation, concurrency and idempotency. Production verification is read-only only; migration 004 is not applied there. The current production preflight remains 1691 receipts, 5762 items and 1691 raw rows; operation types are 1:1407, 2:283, 3:1, and raw FFD codes are 2:51, 3:1, 4:1639.

Operational gate: `PHASE 1B OPERATIONAL GATE PASS`.

# Certification Freshness Monitoring v1

This is a manually invoked, read-only probe. It does not materialize,
refresh, replay, backfill, schedule, deploy, or persist certification.

## Run

From an exact reviewed checkout with a read-only database role:

```sh
DATABASE_URL="$READ_ONLY_DATABASE_URL" node scripts/certification-freshness-probe.mjs \
  --scope default --statement-timeout-ms 120000 --lock-timeout-ms 5000
```

The JSON output contains only scope, source-state identity, run identifiers,
timestamp, status, and reason code. It does not print receipt, bank, fiscal,
account, or secret data.

## Status contract

- `READY`: the authoritative current source state has exactly one complete,
  integrity-checked unbounded READY run.
- `STALE`: a prior READY run exists, but its source state differs from live
  source state; no current run is treated as ready.
- `MISSING`: no exact current run exists and no prior READY run is available.
- `CONFLICT`: multiple exact runs or an authoritative conflict is present.
- `CORRUPT`: an exact run is non-READY or its persisted facts/results fail
  the existing current-snapshot integrity contract.
- `TECHNICAL_ERROR`: the read-only transaction, timeout, or database probe
  failed. The safe reason code is `READ_ONLY_TIMEOUT` or
  `READ_ONLY_PROBE_ERROR`.

The probe computes the existing authoritative source-state fingerprint once
inside one `REPEATABLE READ READ ONLY` transaction, then invokes the existing
transaction-bound current-snapshot reader with that identity. Local statement
and lock timeouts are rolled back before the connection returns to the pool;
PostgreSQL 16 and 18 are supported by the existing SQL contract.

## STOP conditions

Stop and investigate on `CONFLICT`, `CORRUPT`, `TECHNICAL_ERROR`, an unexpected
scope, or any source-state identity disagreement. `STALE` and `MISSING` are
visible non-ready outcomes, not authorization to write. A separate reviewed
materialization approval is required before any certification write.


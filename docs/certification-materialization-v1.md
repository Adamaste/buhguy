# Certification Materialization v1

This document defines the guarded one-shot procedure for creating the current
full unbounded `READY` certification snapshot. It is not an automatic refresh,
writer trigger, replay, or backfill mechanism.

## Contract

`materializeCurrentCertification()` uses one PostgreSQL client and one
`SERIALIZABLE` transaction. It applies bounded `lock_timeout` and
`statement_timeout`, locks the accounting scope, computes the authoritative
source-state key and non-persisting projection in that transaction, and never
uses `replace=true` or deletes historical runs, facts, or results.

An existing exact unbounded `READY` run is reused only after every persisted
fact and result matches the current projection and semantic identity. Otherwise
the operation fails closed. A new run, facts, and results are committed
atomically only after the persisted rows are independently re-read and match.
Serialization, lock, timeout, source-state, duplicate, and semantic conflicts
rollback the transaction.

## Approval gate and production runbook

Before any production use, obtain explicit approval for this one scope and
source state. From an isolated exact-master checkout:

1. Verify the exact master and all applicable master CI checks.
2. Verify service health, schema migration head, permissions, active
   transactions, locks, and a fresh validated PostgreSQL backup.
3. In a separate `REPEATABLE READ READ ONLY` transaction, compute the current
   source-state key and projection. Stop if the state is missing, stale,
   conflicting, non-READY, or differs from the reviewed decision.
4. Compare the same-state per-currency facts/results and household/category/
   person gross, returns, net, and unresolved buckets using exact decimal
   arithmetic. Do not compare aggregates from different source states.
5. With the approved write-capable role, invoke exactly one guarded
   `materializeCurrentCertification` call with bounded timeouts. Do not run
   `rebuildCertification({replace:true})`, generic migration runners, writers,
   replay, backfill, or accounting catch-up.
6. Verify the committed run is the exact source state, unbounded, `READY`, and
   that all fact/result semantic keys and per-currency reconciliations match.
7. If any precheck, lock, timeout, source drift, conflict, or postcheck fails,
   stop and rollback. Do not retry blindly; take a new read-only snapshot.

Post-materialization validation is read-only. Confirm the current snapshot
reader is `READY`, persistence counts changed only by the approved run/facts/
results, and no ledger, receipt, bank, classification, grant, or view data was
changed. A later bank/receipt ingestion makes the source state stale; repeat the
read-only precheck and approval gate before any new materialization.

## Clone rehearsal

The disposable PostgreSQL integration suite covers full creation, current
reader `READY`, idempotent retry with no new rows, serializable concurrent
source-change rejection, and injected failures after run/facts/results with
rollback to the exact pre-call counts.

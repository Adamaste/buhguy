# Production Schema-Readiness Runbook: Migration 019

Status: reviewed rehearsal only. This document does not authorize production
DDL, DML, grants, deployment, certification refresh, writer execution, replay,
or backfill.

## Current production finding

The exact-master read-only probe found PostgreSQL 18.6 with schema migration
018 current. Migration 019 and the separately managed analytics artifact 011
are absent. The least-privilege `receipt_collector` role cannot read the
certification source path (`42501`); no grant change is authorized by this
runbook. The next validation must remain blocked until a separately reviewed
read-only role/path is available.

## Rehearsal result

A fresh custom-format production backup was created and validated with
`pg_restore --list` before rehearsal. It was restored into a uniquely named
disposable PostgreSQL clone, never over production.

On the clone, the exact repository migration runner (`migrate()` from
`src/database.js`) applied migration 019 from schema head 018. A second run
was a no-op. Analytics 011 was then installed separately, as the runtime
migration loader intentionally does not load `db/analytics` artifacts; a
second installation was also idempotent.

The rehearsal verified six migration tables, eight canonical spending views,
the taxonomy seed and 21 category seeds, indexes and foreign-key dependencies,
unchanged restored business/bank/receipt/certification/ledger/matched-purchase
row counts, and a clone-only service-role compatibility check. A terminated
clone-only DDL transaction left no probe table, demonstrating transactional
rollback after interruption. The disposable clone and temporary role were
removed after validation. No production grants or rows changed.

## Preconditions before any production approval

1. Confirm the exact approved master and a terminal GREEN master CI.
2. Confirm the production schema head is 018 and migration 019/views 011 are
   still absent; do not substitute latest run id for source-state validation.
3. Confirm all referenced parent tables, composite keys, data types,
   constraints, and existing row counts from a `REPEATABLE READ READ ONLY`
   inventory. Capture active sessions, waiting locks, and recent ingestion
   health without stopping ingestion.
4. Create a fresh custom-format PostgreSQL backup as `postgres`, retain it
   outside the release checkout, record its SHA-256, size, ownership/mode,
   and pass `pg_restore --list`. A backup failure is an immediate STOP.
5. Obtain explicit approval for production schema mutation and a separately
   reviewed execution window. The service role must not be broadened as a
   workaround; if validation requires more access, provision a dedicated
   narrowly scoped read role in a separate reviewed change.

## Execution order after approval

The operator must use the repository migration mechanism, not hand-edited SQL.
Use a maintenance session with `lock_timeout` and `statement_timeout` set to
reviewed bounded values. Stop before the first migration statement if there is
any waiting lock, unexpected active writer, schema drift, backup mismatch,
missing parent object, or non-018 migration head.

1. Reconfirm the backup and preconditions immediately before execution.
2. Apply migration 019 through the reviewed migration runner in one
   transaction. Do not run analytics SQL in that transaction.
3. Verify the migration row, tables, constraints, indexes, seed taxonomy and
   categories, and unchanged pre-existing data counts.
4. Install `db/analytics/011_canonical_spending_analytics_v1.sql` separately
   in a bounded transaction after migration 019 is verified.
5. Verify all eight views and dependencies, then run the exact-master
   non-persisting resolver only in a `REPEATABLE READ READ ONLY` transaction.
6. Do not create or refresh a certification snapshot in this rollout.

## STOP conditions and recovery

STOP immediately on lock timeout, statement timeout, failed constraint/seed,
unexpected schema head, non-idempotent rerun, changed pre-existing rows,
view dependency failure, or any permission/grant request outside the approved
plan. Do not retry blindly.

Migration 019 is transactional and the rehearsal showed an interrupted DDL
transaction rolls back. For a failed production transaction, verify the
migration row and object inventory before any retry. If the transaction has
committed but postchecks fail, do not drop objects or manually reverse them:
freeze follow-on work, preserve logs/backup, and use the separately reviewed
backup restore/rollback procedure in an approved maintenance window. Never
restore over production automatically.

## Post-application compatibility gate

The ingestion service must remain running; no service restart is part of this
schema-only step. Confirm existing bank, receipt, certification, ledger, and
matched-purchase reads remain unchanged, then separately validate the new
schema with the narrowly approved read path. Only after those checks pass may
the current-snapshot validation be reviewed as a separate operation.

No writer, classification, accounting persistence, replay, backfill, or
analytics exposure is enabled by migration 019 or artifact 011 alone.


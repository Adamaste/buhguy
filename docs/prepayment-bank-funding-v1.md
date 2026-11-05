# Prepayment settlement and bank funding V1

This feature links a proven bank payment to an already confirmed FNS prepayment lifecycle. It does not create a second purchase or a second expense.

## Activation boundary

`PREPAYMENT_SETTLEMENT_START_AT` is a separate opt-in and must remain unset by default. Persistence is disabled when it is unset. When configured, both the prepayment and settlement receipts must have a source observation in the requested accounting scope whose `observed_at` is at or after the boundary. Fiscal `date_time` is not used as a substitute for receipt arrival time. No historical backfill is part of this feature.

## Evidence required

- The FNS receipts form one uniquely confirmed prepayment/settlement lifecycle: supported operation types, reconciled payment components, compatible RUB currency and exact amounts, and the same complete fiscal item multiset. Item order may differ; multiplicity and each item's complete attributes are preserved.
- The lifecycle receipts have verified FNS source observations in the same scope and satisfy the configured arrival-time boundary.
- Exactly one eligible bank transaction is present for the lifecycle, and that bank transaction is eligible for exactly one lifecycle. It must be a `PURCHASE` / `DEBIT` with `READY` normalization, `EXACT` evidence, exact RUB amount and time within five minutes of the prepayment receipt.
- Existing provider/account binding, account-owner scope proof, source scope, and bank-ledger projection checks must pass. Existing bank-receipt matches or conflicting ledger links block persistence.
- Alfa notifications additionally require a verified Android notification lifecycle ID; the raw ID and notification text are not stored in the funding evidence snapshot.

Ambiguous or incomplete evidence remains unlinked. Merchant names do not prove a payment.

## Ledger behavior

The prepayment lifecycle remains the sole acquisition. Funding evidence and a source link are attached to its existing prepayment ledger entry. If the same bank transaction already has a valid active bank-only purchase entry, an append-only `BANK_ONLY_PREPAYMENT_REFINEMENT` supersession points to the prepayment lifecycle entry. The previous ledger record is preserved and becomes inactive; no second active acquisition is allowed. Replays reuse the validated evidence and link. Conflicts fail closed.

`PREPAYMENT_ONLY` and `ADVANCE_ONLY` receipts do not become ordinary matched purchases. A settlement receipt completes the lifecycle but does not create another cash outflow.

## Deployment boundary

This change adds migration 028 and code only. Do not apply the migration or set `PREPAYMENT_SETTLEMENT_START_AT` without a separate deployment approval, current backup and operational preflight. Keep `BANK_ONLY_PURCHASE_LEDGER_START_AT` and all existing bank settings unchanged. Do not run a backfill or replay historical bank events.

## Local validation (2026-11-04)

Node 22 unit checks: 559 passed, 0 failed, 21 skipped. Full integration suite passed against a disposable local PostgreSQL 18 cluster, including the migration-028 path with migration 026 absent. A synthetic 29211.66 RUB regression starts with an empty ledger, creates exactly one active acquisition and verifies replay preserves that amount and cardinality. Bank-first refinement, FNS-first processing, ambiguity and cutoff tests pass.

Migration 027 retains its approved bytes and SHA-256. Its apparent working-tree change was stale index metadata; refreshing the index cleared it without editing the file. No production migration, deployment or historical catch-up was performed.

For deployment review: verify backup freshness and runtime writers, approve and apply 027 then 028 using the single-pending-migration guards, deploy the reviewed artifact, and separately approve any precisely scoped historical recovery. Do not widen the bank-only cutoff or invoke a mass catch-up to recover one purchase.

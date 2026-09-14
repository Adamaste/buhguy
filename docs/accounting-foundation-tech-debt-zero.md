# Accounting Foundation Tech-Debt Zero Audit

Date: 2026-09-08

Scope: read-only production audit plus disposable PostgreSQL clone validation. No production schema, data, auth, timer, or service mutation was performed.

## Production baseline

The final read-only snapshot was:

| Layer | Counts |
|---|---:|
| receipts / receipt_items / receipt_raw | 1703 / 5792 / 1703 |
| fiscal facts / item fiscal facts | 1703 / 5792 |
| business events / evidence / edges / allocations | 1248 / 1210 / 84 / 8 |
| ledger entries / postings / source links | 1248 / 2414 / 1214 |
| duplicate `fns_id` / canonical tuples | 0 / 0 |
| ledger balance violations | 0 |

The sync and PostgreSQL backup timers were both enabled and active. The sync service had `Result=success` for its current start and was still active while the read-only check was made.

## A. Full Ledger replace and Certification FK

On a fresh production clone, direct `rebuildLedger({ replace: true })` originally failed at the expected FK:

`certification_facts_ledger_entry_id_fkey`

The local runtime now fails closed before any delete with `LEDGER_REBUILD_CERTIFICATION_DEPENDENCY` when a full replace would remove system-derived ledger rows referenced by certification facts. Clone counts were unchanged after the rejected operation. The bounded event-component replacement path is not changed.

A coordinated disposable-clone-only procedure explicitly removed certification run history, rebuilt the ledger, then persisted certification. It converged to 1248 ledger entries, 2414 postings, 1214 links, 3541 certification facts and 8 certification results with zero balance violations. This procedure is not exposed as an implicit production command.

## B. Historical concurrency

The original stress run reproduced a PostgreSQL `40P01 deadlock_detected` at concurrent `ledger_accounts` upserts. The wait graph showed concurrent `INSERT ... ON CONFLICT DO UPDATE` transactions, followed by an idle transaction holding a posting lock.

The local fix acquires a transaction-scoped advisory lock keyed by accounting scope before account-catalog upserts. A disposable clone rerun completed 15 concurrent non-replace rebuild attempts across three rounds with:

- errors/deadlocks: 0;
- ledger counts before and after: 1248 / 2414 / 1214;
- duplicate semantic ledger entries: 0.

## C. Certification result-count discrepancy

The current production database contains historical append-only certification history: 1120 runs and 3363 result rows. The current deterministic projection and the latest certification run each contain 8 result rows and 3541 proof facts on the clone. Therefore, comparing all historical `reconciliation_results` to one current report is not a semantic mismatch; it is an unscoped historical-row count.

The read-only certification probe compares projection, latest run and all-history counts explicitly. No production cleanup was performed.

## Tests and skipped tests

Local suite: 120 tests, 116 passed, 0 failed, 4 skipped. The four skipped tests require `TEST_DATABASE_URL`; they are environment-gated PostgreSQL integration tests for Analytics, Certification, Ledger and purchase-details views. Clone probes covered the Ledger/C certification and concurrency paths directly. The skipped tests must not be reported as passed.

## Deployment boundary

The advisory-lock and full-replace guard exist only in the local working tree. No production runtime files were copied, no migration was applied, no production data was changed, and no timer/service configuration was changed.

## Reproducibility

Read-only and clone-only scripts are in `scripts/tech-debt-*`. Captured JSON evidence is in `artifacts/accounting-foundation-tech-debt-zero/`.
# Historical audit snapshot

The counts in this document are retained as historical evidence from a disposable validation snapshot. They are not project defaults or current production guarantees.

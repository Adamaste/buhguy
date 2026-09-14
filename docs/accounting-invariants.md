# Accounting Invariants

These are acceptance conditions for a future accounting core, not claims that the current POC already satisfies them.

1. Raw evidence is immutable, addressable and content-hashed.
2. Every normalized value is traceable to raw evidence and parser version.
3. No receipt or item is duplicated by replay; no legitimate correction is discarded as a duplicate.
4. No allocation is negative or exceeds the evidenced source amount without an explicit reversal rule.
5. A settlement of an advance cannot create a second cash outflow.
6. Return allocations cannot exceed recognized/fulfilled purchase value.
7. Double-entry postings balance per transaction and per closed period.
8. Unknown, conflicting and ambiguous evidence remains visible in an exception queue.
9. Missing is not silently interpreted as zero, ordinary purchase or no return.
10. Incremental processing equals full rebuild from immutable evidence.
11. Reordering, retrying and concurrent ingestion are deterministic and idempotent.
12. No cross-user/account identity merge is possible without explicit scope.
13. Closed periods cannot change silently; restatements are versioned.
14. Decimal money precision and timezone policy are explicit.
15. Every certified analytic number has a reproducible query and evidence path.
16. Backup/restore preserves raw evidence, parser versions, rules and ledger history.

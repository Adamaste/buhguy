# Accounting Invariants v3.1

1. Raw evidence is immutable, content-hashed and addressable.
2. Every parsed field identifies source path, parser version, FFD raw code and semantic version.
3. `FIELD_NOT_SUPPORTED`, `FIELD_MISSING` and `FIELD_ZERO` are distinct states.
4. No receipt/item/source event is duplicated by retry or concurrent ingestion.
5. Every allocation has scoped source/target IDs, amount, quantity, rule version and explanation.
6. Allocations cannot exceed source amount/quantity without an explicit reversal.
7. A settlement using an advance cannot create a second cash outflow.
8. Returns cannot exceed recognized/fulfilled amount or quantity.
9. Mixed item payment types are split at item/payment-component level.
10. Fiscal operation direction, household cash direction and business event type are separate.
11. Gift certificate purchase increases household stored-value asset; redemption decreases it.
12. Every ledger transaction balances debits and credits.
13. Suspense/unresolved balances remain visible and block certification when material.
14. Incremental processing equals full rebuild from immutable evidence.
15. Reordering, late arrival, retry and concurrent ingestion are deterministic.
16. No cross-user/account identity merge occurs without explicit scope.
17. Closed periods change only through versioned restatement.
18. Money precision, FX, timezone and rounding policy are explicit.
19. Backup and restore preserve evidence, parser versions, rules, allocations and postings.
20. Every certified figure has reproducible query and evidence lineage.

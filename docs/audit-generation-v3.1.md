# Audit v3.1 Generation

This pass is read-only. It must not run migrations, write production tables, alter FNS auth/session, or change systemd.

## Reproduction

1. Obtain read-only PostgreSQL access to `finance_receipt_collector`.
2. Run `psql "$DATABASE_URL" -f scripts/accounting-audit-v3.1.sql` and capture aggregate output.
3. Run the row-level candidate/return queries documented in `artifacts/accounting-audit-v3.1/lifecycle-research-candidates.json` and `return-audit.json`; their `definition` fields state the exact predicates. The full file-to-query mapping is in `artifact-manifest.json`.
4. Compare the output with `artifacts/accounting-audit-v3.1/corpus-summary-v3.1.json`, `ffd-support-matrix.json`, `property-inventory.json`, and `operational-status.json`.
5. Regenerate `full-field-inventory.json` using the recursive query in section 2. It reports every leaf JSON path, JSON type, occurrence count, null count and hash-only cardinality. Regenerate the row-level JSON with the corresponding CTEs in the manifest; do not substitute broader or narrower predicates without changing the artifact version.

## Privacy

Internal row-level artifacts may contain receipt IDs, timestamps, amounts, seller/provider INNs and technical merchant refs. They must never contain buyer email/phone/name, full raw payloads, cookies, auth headers, tokens, passwords or private keys. Property values are not exported by the generator because their content can be personal or merchant-sensitive.

## Snapshot caveat

The independent architecture-review figure of 52 candidate rows and 48 settlement receipts is not reproducible against the current 1691-row production snapshot with the stated predicates. Current production gives 42 seller/amount/payment/date pairs and 2 strict fingerprint matches. Possible causes are a different snapshot, a different fingerprint definition, or an undocumented predicate; no rule is promoted based on the discrepancy.

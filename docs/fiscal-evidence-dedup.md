# Fiscal Evidence Deduplication

Status: Phase 1A implementation, local only. No production migration or deploy is performed by this change.

## Scope

This layer identifies and deduplicates one fiscal document replaying through FNS. It does not match a prepayment to a settlement, infer a business event, or create an accounting/ledger match. A prepayment and a full settlement remain two fiscal receipts even when seller, amount, items, and timestamps look alike.

## Identity

Two independent identity channels are checked:

1. FNS source identity: `receipts.fns_id` (existing non-null unique constraint).
2. Canonical fiscal identity: the complete tuple `fiscal_drive_number`, `fiscal_document_number`, `fiscal_sign`.

The canonical tuple is protected by `receipts_canonical_fiscal_identity_unique`, a partial unique index that applies only when all three values are non-null. `kkt_reg_id` is not part of the key because the current production evidence shows the three-field tuple is already unique; seller, INN, amount, date, items, `paymentType`, and time are never identity keys.

If both channels resolve to different rows, or only one channel resolves while a complete incoming tuple is present, ingestion fails closed with `FISCAL_IDENTITY_CONFLICT`. No merge or overwrite is attempted. An incomplete tuple does not use a similarity fallback; it may use the existing FNS source identity, otherwise ingestion is explicitly unavailable.

## Replay and content protection

The normalized receipt, all items, and raw evidence are inserted in one transaction. An exact replay compares a SHA-256 fingerprint of the raw JSON after recursively sorting object keys. JSON array order is preserved. A replay returns `created=false`, `replayed=true`; it does not delete/reinsert items and does not replace raw evidence.

The repository also takes a transaction-scoped PostgreSQL advisory lock derived from the two source identity channels before probing/inserting. This makes simultaneous identical ingests serialize cleanly; the unique constraints remain the final protection for independent writers and for different lock-key paths.

Only these explicitly listed transport fields are ignored by the fingerprint: `receivedAt`, `received_at`, `rawUpdatedAt`, `raw_updated_at`, `requestId`, `request_id`, `requestNumber`, `request_number`, `session`, `headers`, and `auth`. They are not fiscal evidence. Any other changed field is material. A same-identity payload with a different fingerprint fails closed with `FISCAL_CONTENT_CONFLICT`, preserving the original receipt, items, and raw payload.

The fingerprint is computed from the incoming payload and the stored `receipt_raw.payload`; it is not itself an identity key.

## Database barrier

Migration `003_fiscal_identity_hardening.sql` first aborts if existing complete canonical tuples are duplicated, then creates the partial unique index. It contains no `DROP`, `DELETE`, business backfill, or destructive operation. The existing `fns_id` uniqueness remains the source-identity barrier.

## Observability and sync behavior

Normal replay remains an already-processed receipt, not an error. Identity and content conflicts increment `errors` and expose `fiscalIdentityConflicts` / `fiscalContentConflicts` only when non-zero. Logs contain the receipt summary ID, safe error code, and message; raw payloads and credentials are not logged. An authentication failure remains non-zero and is not reported as an empty successful sync.

## Required regression cases

DEDUP-001..015 are covered by `tests/fiscal-evidence.test.js`, `tests/postgres.integration.test.js`, and the existing sync/normalization tests. Run `npm run test:integration`; the runner uses `TEST_DATABASE_URL` when supplied, otherwise creates and removes a temporary Docker PostgreSQL instance. In this verification pass Docker was unavailable locally, so a separate temporary database on PostgreSQL 18.6 was used through an SSH tunnel and was deleted afterward.

The integration result was 10/10 PASS: fresh migration, 002-to-003 upgrade, dirty canonical duplicate fail-safe behavior, direct source/canonical uniqueness enforcement, 50 independent same-document races, concurrent distinct documents, identity conflict, content conflict, harmless transient replay with the sanitized Xiaomi two-document case, and rollback after receipt/items/raw injection points. No production schema or data was changed. The final production read-only preflight remained `receipts=1691`, `receipt_items=5762`, `receipt_raw=1691`, duplicate `fns_id` groups `0`, duplicate canonical groups `0`, and identity disagreements `0`.

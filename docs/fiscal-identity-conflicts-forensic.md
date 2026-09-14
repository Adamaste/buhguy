# Fiscal Identity Conflicts Forensic Result

## Scope

This is a read-only forensic result. No production schema, data, authentication state, timers, or graph rows were changed.

## Observed facts

- The first and repeated production sync each reported nine `FISCAL_IDENTITY_CONFLICT` errors.
- The implemented conflict is fail-closed: an incoming `fns_id` resolves to one stored receipt while its canonical tuple `(fiscal_drive_number, fiscal_document_number, fiscal_sign)` resolves to a different stored receipt.
- The current production snapshot has `receipts=1694`, `receipt_raw=1694`, `receipt_items=5775`, and zero duplicate non-null canonical identity groups.
- The permitted browserless refresh passed and the current FNS list returned `totalCount=1703`.
- All nine current conflict details were fetched read-only. Their exact canonical tuples were absent from the current `receipts`/`receipt_raw` snapshot. Some of their document numbers occur with different drive/sign combinations, but that does not prove which historical representation was correct.

## Case evidence

`artifacts/fiscal-identity-conflicts/conflicts.json` records all nine current conflict inputs with buyer email redacted. Incoming safe fields and content hashes are present. A/B receipt IDs and comparison predicates are `null` because no current DB row matched any exact incoming tuple and the historical conflict-time DB mapping is not retained in the available evidence.

Consequently A/B topology, content equality, `fns_id` semantics, `kkt_reg_id` relevance, historical origin, and financial impact are not proven. The evidence establishes a source/snapshot discrepancy, not its root cause. No category such as source reassignment or bad historical identity is asserted.

## Remediation

No deterministic production remediation is authorized. Preserve the current fail-closed Phase 1A behavior. A future run must first capture a valid current FNS list/detail response and independently compare it with the database rows; it must not merge, rewrite, delete, or relax uniqueness based on these journal-only records.

## Final verdict

## Prospective scheduled capture

The next normal `receipt-collector-sync.timer` run was observed with temporary instrumentation and no manual sync. It captured exactly 9 conflicts. All 9 used the same branch: `FNS_ID_MATCH_BUT_TUPLE_NOT_FOUND`. In every case the incoming detail had a complete fiscal tuple, the tuple lookup returned `NULL`, and the `fns_id` lookup returned one existing row with a different stored tuple and a different material content hash. The list summary exposed only the list identifier and business summary; it did not expose fiscal identity fields, while the detail response did, so list-vs-detail tuple equality was not observable (`list tuple = unavailable`, not evidence of equality or inequality). The detail response also did not expose a separate `key` field, so the list identifier cannot be proven equal to the detail identifier from this capture.

The sync completed with the expected non-zero status because the nine conflicts remain visible. Source counts before and after remained `receipts=1694`, `receipt_items=5775`, `receipt_raw=1694`; no legitimate source delta occurred. Peak service memory was about `71 MiB`. The temporary drop-in, forensic file and VPS capture were removed; timer cadence and enabled/active status were restored.

This prospective evidence identifies the runtime root cause: the list item carries the compound FNS key, but the detail payload has no `key`; `normalizeReceiptDetail()` therefore falls back to `fiscalDocumentNumber` for `normalized.id`. The sync persists that fallback as `receipts.fns_id`. On the next replay, the same document number resolves to an old stored row while the current detail tuple is different, producing `FNS_ID_MATCH_BUT_TUPLE_NOT_FOUND`. All nine cases follow this pattern. The current canonical tuple remains valid; the defect is the list/detail identifier propagation and historical rows require separate, approved repair. No remediation was performed.

**FISCAL IDENTITY CONFLICT ROOT CAUSE IDENTIFIED**
# Historical audit snapshot

This forensic note records a historical validation snapshot and must not be interpreted as a current production census.

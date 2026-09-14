# Multi-User FNS Foundation V1

## Scope

This is a local implementation and disposable-clone verification only. Production was not migrated, runtime was not deployed, and no accounting rows were changed.

## Model

- `accounting_scopes` remains the household/accounting boundary.
- `persons` identifies people only within a scope.
- `fns_sources` identifies independent FNS accounts/sessions. It stores only non-secret filesystem references and enabled state.
- `fns_source_person` is an `OBSERVED_BY` association, not a payer or ownership claim.
- `receipt_source_observations` is the many-to-many provenance bridge from source observations to one canonical `receipts` row.
- `fns_source_sync_state` stores independent per-source operational health and counters.

Canonical receipts, raw evidence, normalization, graph, ledger, and certification remain source-neutral. A second source observing the same fiscal tuple and material content reuses the canonical receipt and creates only an observation. A source reference mapping to another receipt, or material content disagreement, fails closed.

Sessions remain filesystem-backed by `SessionStore`, whose atomic writes use mode `0600`. The SQL migration has no token, cookie, authorization-header, or private-key columns.

## Runtime

`FNS_SOURCES_CONFIG` is an optional non-secret JSON configuration file. Each enabled entry contains `sourceKey`, `sessionDir`, optional person metadata, and non-secret references. The scheduler creates one `SessionStore`/`FnsClient` per source and processes sources independently; a source failure is recorded in that source's sync state and does not stop the next source. Without the config, the legacy single-source path remains unchanged.

Shared canonical receipt replays on the multi-source path do not rerun downstream derived accounting work. This prevents duplicate graph, ledger, or certification work while preserving the existing single-source behavior.

## Clone Verification

Fresh preflight snapshot used for the disposable clone: `receipts=1705`, `receipt_items=5794`, `receipt_raw=1705`; duplicate `fns_id` and canonical tuples were both zero. The supplied historical `1703/5792` counts were stale relative to this live snapshot and were not forced.

Migration 008 backfilled one `legacy-default` source observation for every existing receipt. Clone checks then verified:

- second person/source could observe the same canonical receipt without a second receipt/raw/items row;
- repeated same-source observation was idempotent;
- a second existing receipt could be observed by the second source independently;
- two concurrent source observations of one canonical receipt converged to one receipt;
- reusing one source reference for another receipt failed with `FNS_SOURCE_OBSERVATION_CONFLICT`;
- per-source sync errors remained isolated;
- graph, ledger, certification, and source counts were unchanged except for observation rows;
- duplicate source and canonical identities remained zero.

Machine-readable evidence is in `artifacts/multi-user-fns-foundation/clone-verification.json`. The clone runner is `scripts/run-multi-user-fns-clone.mjs`.

## Migration / Rollback

Migration `008_multi_user_fns_foundation.sql` is additive and idempotent. It creates only new provenance and operational tables and backfills metadata-only legacy source observations. A production rollback must be a controlled restore from a pre-deploy backup or a separately reviewed migration; dropping the new tables is intentionally not performed by the candidate. No production rollback was needed because production was not mutated.

## Acceptance

Local tests: 118 passed, 4 PostgreSQL integration tests skipped because no local `TEST_DATABASE_URL` was configured, 0 failed. Clone verification passed. Production remained at migration `007_reconciliation_certification.sql`, with no `persons` or `fns_sources` relation present.

## Readiness

The foundation is ready for a separately approved production deployment. This task deliberately stops before that deployment.
# Historical audit snapshot

The preflight counts in this document describe one disposable validation clone and are not current production values.

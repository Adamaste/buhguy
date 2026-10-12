# Controlled accounting no-churn runtime deployment — review-only plan v1

**Prepared:** 2026-10-12  
**State:** PLAN ONLY — NOT APPROVED, NOT EXECUTED  
**Baseline at authoring:** GitHub `master` `f68652c98a7a8b81c941be046917c78149fadac5` (PR #165 code and PR #166 handoff merged).  
**Current production release (last operator report, not independently reverified here):** `8e18a9d65c933045820b0771afbcdd1c28546956`.

## 1. Purpose, boundaries and exact change

Prepare a **separately authorized** controlled runtime rollout of the already-merged PR #165 accounting no-op/churn fix. A GitHub merge does not mean production was deployed. This document is an operator review artifact only; creating or merging it grants **no** authority to connect to production or change it.

The existing scheduled catch-up path invokes `rebuildCertification(..., { persist: true, replace: true, reuseUnchanged: true })` at the new source version. The `replace: true` option is **still present**: PR #165 adds safe unchanged-READY reuse and no-op ledger projection guards so routine unchanged cycles need not delete/reinsert facts, results, or ledger rows. It is incorrect to assert the source has no `replace=true` call. Changed source-state snapshots can still require legitimate writes; blocked or conflicting state must fail closed.

**In scope for a future, individually approved window:** immutable exact-code runtime artifact, controlled application release switch, service/timer sequencing, read-only identity/invariant checks, and bounded observation of normal accounting catch-up. Approval must explicitly enumerate any one-shot sync/catch-up with financial-write capability.

**Out of scope:** PostgreSQL DDL/migration, grants, privilege or secret changes, certification backfill/materialization outside the ordinary approved sync scope, historical replay, matched-purchase preview/writer, Android changes, CI dispatch, financial data repair, manual VACUUM/REINDEX/pg_repack, disk-shrink maintenance, database restore, and additional session termination. Each would require a separate proposal and approval. PR #163 and the consumed fourth-preview authorization stay blocked.

## 2. Verified history versus preflight requirements

- PR #165 was merged in commit `43b513ceb2cf9d2d821158d8c5303a6fd83a2fc2`; its tested code head was `18bbed0f4112cf0bf6a378505fced7e457bac088`. PR #166 subsequently updated the handoff and merged into the current `master`.
- The recorded **local** exact-PR-HEAD validation: Node 22.13.1, `npm run check` PASS, `npm run test:unit` 457/457, and disposable PostgreSQL 16 and 18.6 (26 migrations + 61 integration tests on each) PASS. These are recorded operator/Codex results, **not** fresh verification of an as-yet-built deployment artifact and **not** GitHub Actions runs.
- GitHub Actions automatic push/PR checks are intentionally paused until the quota reset is confirmed on or after 2026-11-01 and triggers are restored. Do not dispatch hosted CI under the current policy. For new functional code changes, exact-HEAD isolated local tests are mandatory; doc-only changes need diff/format review.
- Last operator-reported production free space was ~465.5 MiB after closure of two stale sessions. This is **historical**; current space, WAL headroom, backup location, and releasable bytes are unknown. Zero estimated dead tuples does not mean files shrank.
- The former artifact was reported verified with a 326-file manifest and archive SHA-256 `abac4c17ce93e27aa340b4e9ce629794b38d67b6b3a5df86c7b94388de7114b5`. That hash describes the **old** artifact, not the target release; never reuse it to validate a new artifact.

## 3. Pre-approval preparation (offline; no production access)

1. Re-read `docs/BUHGUY-CURRENT-HANDOFF.md`, `docs/BUHGUY-ROADMAP.md`, `AGENTS.md`, and `docs/OPERATIONS.md`. Recheck current `master`, PR status, and diffs at execution planning time. Freeze an exact candidate **full SHA**; if master changes, determine whether the runtime tree changed and repeat the applicable validation.
2. In an isolated clean local worktree with **no inherited production credentials**, verify Node >=22; run `npm ci`, `npm run check`, `npm run test:unit`, and `npm run test:integration` against disposable Docker PostgreSQL as documented in `docs/BUHGUY-LOCAL-TESTING.md`. Report actual tested SHA, host class, all counts, errors, and skipped tests; never treat skipped PostgreSQL tests as PASS. Do not use production as the test host.
3. Reuse the established immutable release process, not an ad hoc live file copy. Build a complete runtime artifact from the frozen Git commit; pin dependency closure, inspect the file list and no-secrets exclusion, generate per-file Git blob and SHA-256 manifest, verify deterministic text line endings and archive SHA-256, re-extract in isolation, and pass syntax/import/CLI smoke checks. Record the candidate manifest and checksums in a private operator artifact store, not as raw logs or secrets in Git.
4. Compare the candidate with the previous release: exact changed files, module dependencies, service entrypoints, compatibility with PostgreSQL 18.6 and Node 22, and whether `finance-bank-ingestion.service` shares any release path or dependency. A service outside the defined scope must not be implicitly restarted. Review actual deployment symlink/path, systemd unit state, and rollback mechanism with the operator before authorizing a window.
5. Prepare a **capacity worksheet**: updated filesystem free bytes, artifact expansion and temporary copy needs, WAL/backup space, and available recovery space. Because the last free-space reading was small, do not presume a release or local backup fits. Define and independently verify sufficient headroom based on measured artifact and rollback sizes, with backup retained on independent verified storage. **STOP** if headroom or a restorable backup is not proven; no disk reclamation is authorized by this plan.

## 4. Separate approval packet and immutable evidence

Before any production connection or change, obtain an explicit operator approval specifying: candidate SHA and archive hash; release path and files; permitted service/timer actions; exact time window; whether one controlled normal sync with its usual financial writers is approved; responsible operator; tested backup/restore destination; minimum free-space budget; rollback trigger; permitted read-only checks and monitoring interval. A review of this document or PR is **not** that approval.

Operator must independently attest to:
- verified deployed-old release identity and all installed file hashes (not only a symlink);
- recent successful **restorable** database backup with location, integrity/ownership checks, capacity and recovery access; backup and restore themselves remain independently authorized actions;
- known-good prior complete runtime artifact retained, with verified restore path and credentials excluded from any artifact;
- systemd service/timer definitions and current state, no conflicting in-flight sync, and separate bank-ingestion health;
- current filesystem/inode/free-space and relevant database health, no blocking idle transaction/snapshot or unexpected storage pressure.

## 5. Proposed bounded window — do not execute without approval

**A. Read-only baseline:** under the approved least-privilege path, capture database identity/version, application release identity, timer/service state, health endpoints, current source-state fingerprint, the latest READY certification run ID/status/fingerprint, counts and **stable identity markers** for `certification_facts`, `reconciliation_results`, `reconciliation_runs`, ACTIVE ledger entries/postings/source links and supersession chains. Capture only bounded aggregate identifiers and counts; no raw financial rows, receipts, bank notifications, amounts tied to people, credentials, or tokens in reports. State whether the source snapshot is stable or moving.

**B. Maintenance window and candidate validation:** operator confirms backup/capacity/rollback readiness and that `receipt-collector-sync.service` is inactive. Quiesce `receipt-collector-sync.timer` before changing the release; do **not** interrupt an active sync or start a second run. Preserve existing enablement state for restoration. Verify artifact commit, manifest and archive again before an atomic release pointer switch. Do not use partial `src/` copies or the old `scripts/deploy-tech-debt-zero.sh` one-file technique for this multi-file runtime release.

**C. Controlled activation:** only the explicitly authorized runtime service(s) may be restarted/reloaded. Confirm installed file hashes equal the reviewed target manifest, Node and module startup succeed, the ingestion service (if independently affected) remains healthy, and all untouched services retain their prior configuration. No schema migration, grant, secret/session change, or Android action is part of activation.

**D. Controlled accounting observation:** only if separately authorized, run one bounded normal catch-up under the existing supported path, or observe the first scheduled run after restoring the timer. Never run the matched-purchase preview as part of this validation. Avoid a blind rerun after failure. Capture success/failure and provenance with safe aggregate telemetry.

**E. Read-only no-churn postcheck:** for a **verified identical source-state fingerprint** and a READY snapshot, compare pre/post certification run identity and content/row identity markers; unchanged certification should reuse the run with no certification-fact/result delete/insert cycle. Check ACTIVE ledger count, stable identities, balanced postings, and no duplicate economic purchase, lost overlay, broken supersession chain, or new identity conflict. If source state **changed**, classify writes as possible legitimate work and **do not claim a no-op PASS**; compare only the relevant invariants and plan another separately approved stable-window observation if needed. PostgreSQL `pg_stat_*` estimates can be supporting signals, never sole proof of no-churn or disk reclamation.

**F. Finish:** monitor the agreed bounded period across normal sync cadence; confirm timer state and service liveness against baseline, output safe PASS/FAIL/UNCONFIRMED evidence. Keep records private. Record deployed commit, artifact hashes, source-state comparison basis, no-churn verdict, roll-forward/rollback decision, and any separately approved operations. Update the handoff in a reviewed PR after an actual deployment only when supported by evidence.

## 6. Immediate STOP and rollback rules

STOP before cutover if the manifest/dependency or old release identity mismatches, current filesystem capacity is insufficient, backup integrity/restorability is unknown, an in-flight sync cannot safely quiesce, a required service is unhealthy, or execution scope is ambiguous. STOP during/after cutover on unexpected financial row churn for a demonstrably unchanged source state, ledger imbalance, duplicate ACTIVE purchase/posting, missing current certification, repeated sync failure, authorization/scope drift, or unexplained resource pressure.

After a post-cutover STOP, preserve only safe diagnostics; do not automatically retry the financial operation. The operator may activate the already-verified previous immutable runtime artifact **only under the approved rollback scope**, validating hashes and service/timer state. **Do not automatically restore the database or attempt to reverse legitimate financial writes**. A DB restore or row-level repair needs its own incident decision and explicit approval. If neither clean rollback nor forward operation is safe, leave writers paused and escalate instead of guessing.

## 7. Review exit criteria and next handoff

The **planning stage** is complete when this document is reviewed for factual consistency and an operator supplies a deploy-specific approval packet; it is not a production success criterion. Until then the project status remains `P0_ACCOUNTING_CHURN_MERGED_AWAITING_DEPLOY_APPROVAL`. The fourth matched-purchase preview remains a distinct `TECHNICAL_ERROR` with all ten aggregates `UNCONFIRMED`; its authorization is consumed. PR #163 remains draft/unmerged, and no additional preview or private SSH/role activity is authorized.

After review, the **next decision** is whether to separately authorize a narrowly defined deployment window. Do not proceed automatically.

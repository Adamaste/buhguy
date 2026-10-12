# BUHGUY Current Handoff

This document is the operational starting point for a new ChatGPT/Codex session.

## Session bootstrap rule

This file is the authoritative operational handoff for a new ChatGPT/Codex session. A new session must not ask the user to reconstruct project history that is available here or in GitHub.

At the start of any technical work on `Adamaste/buhguy`:

1. read this file completely;
2. read `docs/BUHGUY-ROADMAP.md`;
3. verify the current GitHub `master`;
4. inspect only the relevant detailed docs/code/PR/CI needed for the active task;
5. continue from the explicit current blocker/next action below rather than restarting diagnostics.

Do not repeat closed stages. If this document disagrees with GitHub about code, merge status, CI, or artifacts, GitHub wins. After a meaningful completed stage, update this handoff in a reviewed PR before moving on.

- Last updated: 2026-10-12
- Current implementation baseline: `43b513ceb2cf9d2d821158d8c5303a6fd83a2fc2` (PR #165 merged into master on 2026-10-11; **not deployed** to production).
- Current phase: `P0_ACCOUNTING_CHURN_MERGED_AWAITING_DEPLOY_APPROVAL`; PR #165 is merged and locally tested on PostgreSQL 16/18, but the production service still runs the older release with unconditional `replace=true` certification.
- Current blocker: production code still uses pre-fix accounting catch-up. Controlled deploy requires separate approval, verified artifact/runtime identity and post-deploy no-churn observation. Physical disk reclamation remains a separately approved operation; the distinct PR #163/fourth-preview technical-error blocker remains unresolved.

## Controlled no-churn deployment plan prepared (review-only, 2026-10-12)

The documentation-only plan `docs/accounting-no-churn-controlled-deploy-plan-v1.md`
now covers the frozen master artifact gate, exact-head disposable local tests
while hosted CI is paused, backup/restorability and constrained disk/WAL
headroom, both FNS and bank-ingestion service path checks, separately scoped
approval, controlled cutover, and rollback/STOP rules.

Its production no-churn verdict specifically requires an **unchanged
source-state fingerprint** and reuse of an intact READY certification run
without replacing its persisted rows. New source data may legitimately change
that fingerprint and make a previous run stale; such a case is **UNCONFIRMED**
for no-churn, not proof of failure or success. The review worksheet is
deliberately unfilled; no current production preflight has been performed.

The review-only deployment plan was merged into `master` by PR #167 on
2026-10-12 at `cd77a287606fe8389ed836f31bb719b2cc8195d6`. The PR
changed documentation only; no deployment, CI dispatch, production
connection, backup operation, service/timer change, financial write, session
termination, space-reclamation task, matched-purchase preview, or diagnostic
PR #163 merge was performed.

**Next gate:** operator review of actual deploy readiness: independently
verified exact artifact and installed runtime identity, available capacity,
restorable backup, and rollback path. Only then request a **new explicit,
bounded production deployment approval**. Neither the reviewed plan nor its
merge grants that authorization. The project phase remains
`P0_ACCOUNTING_CHURN_MERGED_AWAITING_DEPLOY_APPROVAL`.

## Accounting churn merge and stale-session closeout (2026-10-11)

**PR #165 merged** to master as `43b513ceb2cf9d2d821158d8c5303a6fd83a2fc2` from reviewed HEAD
`18bbed0f4112cf0bf6a378505fced7e457bac088`. Exact HEAD Node 22.13.1
checks were reported PASS (457 unit tests), as were disposable PostgreSQL 16
and 18.6 runs (26 migration + 61 integration tests for each engine) on the
user's Windows/WSL2 Docker workstation. `git diff --check` passed; no
GitHub-hosted CI ran under the authorized temporary quota pause. PR #165
reduces unchanged certification and ledger writes, preserves protected
matched-purchase overlays and independent append, and safely handles
PostgreSQL 18 timeout/pool client lifecycle.

A separate explicitly authorized, one-time operational cleanup terminated
**only** PostgreSQL backends `806016` and `806250` after strict
PID/start-time, database, socket, backend_xmin and client-script identity
recheck. Their originating Node scripts were
`/tmp/cert-postcheck.mjs` in detached SSH/runuser sessions. The idle
transactions rolled back, both backends disappeared, and no surviving session
held the original `backend_xmin=6957445`. PostgreSQL and
`finance-bank-ingestion.service` health checks passed. No other sessions,
financial rows, application configuration or service were altered; no manual
VACUUM was performed. Estimated dead-tuple counters for
`certification_facts`, `fns_source_receipt_refs`, and `ledger_entries`
were 0 after the cleanup, which **does not imply a physical table shrink**.

Last operator disk reading after session termination: 488,284,160 bytes
(~465.5 MiB) free. The three previously measured relation sizes were
~759.3 MiB, ~181.5 MiB, and ~160.2 MiB respectively; exact physically
reclaimable bytes remain unconfirmed. The active production release is still
`/opt/accountant/releases/8e18a9d65c933045820b0771afbcdd1c28546956`
with the old unconditional certification `replace=true` path.
**Merging PR #165 is not a deployment.**

**Next action:** review the prepared narrowly scoped production deploy
plan (`docs/accounting-no-churn-controlled-deploy-plan-v1.md`); obtain and
record verified artifact identity, restorable backup, capacity and rollback
evidence and **separate explicit authorization** before any production
deployment or financial write. Do not run further production matched-purchase previews:
the fourth authorization has been consumed, and PR #163 remains a separate
unresolved diagnostic issue. Physical table shrink needs independent
space/backup/maintenance approval.

## PR #165 local PostgreSQL gate and pooled-client lifecycle fix (2026-10-11)

PR #165 now contains the minimal fix at exact HEAD
`18bbed0f4112cf0bf6a378505fced7e457bac088`: the certification
materialization error listener is attached for one acquisition and removed in
`finally` before pool release. A PostgreSQL 18 transaction-timeout disconnect
still destroys the affected client through `release(true)` and retains the
existing safe timeout classification, rollback, and fail-closed behavior.

The user Windows development machine has Docker Desktop installed and its
Linux engine available. Exact-HEAD local checks used Node `v22.13.1`:

- `npm run check`: PASS
- `npm run test:unit`: PASS, 457/457
- `git diff --check`: PASS
- PostgreSQL 16 disposable Docker gate: PASS, migration 26/26 and 61
  integration tests, including pooled-client listener reuse and timeout
  recovery
- PostgreSQL 18.6 disposable Docker gate: PASS, migration 26/26 and 61
  integration tests, including the same lifecycle and timeout coverage

Both disposable containers were removed after each run. No production
credentials, database, SSH path, service, role, grant, financial row, or
runtime configuration was accessed or changed. GitHub Actions remains paused;
these are local results for the exact PR HEAD, not a hosted CI claim.

The historical PR #163 diagnostic-stage record and the fourth-preview
technical-error/consumed-authorization blocker below are intentionally
preserved and remain historical evidence, not current success claims.

## Accounting no-op review follow-up (historical pre-gate checkpoint, 2026-10-11)

At this earlier checkpoint, PR #165 was still open and unmerged at head
`7e7906a7ed53d9f5168b1fcb1d9ccbc369469e0a`. Its follow-up separates
unchanged protected bank overlays, independent new ledger entries, and true
identity/ownership drift. It also validates an intact A->B->C supersession
chain by requiring every chain to terminate at the current ACTIVE entry.
A protected purchase can therefore coexist with a safe append for an
independent new purchase, while full no-op replay remains byte-stable and
conflicts fail closed. A disposable PostgreSQL regression now covers
protected purchase A, independent purchase B, replay, and preservation of
A's history and links. Node 22 unit/check passed locally; PostgreSQL
integration remains **NOT RUN** because Docker and `TEST_DATABASE_URL` are
unavailable. Skipped integration is not PASS.

This update preserves the historical PR #163 section and the fourth-preview
technical-error/blocker record below. No production access, writer,
deployment, maintenance, or financial mutation was performed.

- Production artifact: exact master `8e18a9d65c933045820b0771afbcdd1c28546956`, 326 manifest files, archive SHA-256 `abac4c17ce93e27aa340b4e9ce629794b38d67b6b3a5df86c7b94388de7114b5`; installed manifest and hashes match, service health passed
- Current Yandex evidence: master-signed APK is installed; observation 18 / transaction 16 has provider `com.yandex.bank`; its full source event id exactly matches a current `ru.yandex.taximeter` record on `notification_channel_1` when using the stored event-time millisecond as postTime; credential use and backend creation are corroborated
- First-phone diagnostics: `FIRST_PHONE_STALE_DIAGNOSTICS=DEVICE_PROVEN_FIXED`. PR #66 merged as `69b9c7d069176ef23a2d36949bb2c078bc165a12`; CI run `37060443083` passed its test and Android jobs. The signed collector was installed in place with app data, source configuration, allowlist, credential state, and notification-listener access preserved; the safe shell probe refreshed live diagnostics without a bank capture or backend mutation
- Current evidence: observations 72, 75, and 79 are RECONCILED to financial account 1 through historical replay provenance; observations and bank_transactions remain immutable and no backfill was performed
- Current Yandex status: normalizer v1 remains deployed and unchanged; Yandex Pay outgoing v2 is merged but not deployed
- Next action: prepare an exact-master controlled deploy proposal for separate authorization; do not deploy, write financial rows, run VACUUM/REINDEX/pg_repack, DROP, pg_terminate_backend, replay or certification materialization without an independently scoped approval. Retain separate PR #163/fourth-preview blocker.

## Accounting churn remediation checkpoint (2026-10-10)

The preceding disk cleanup removed 17 confirmed disposable clone databases and
reclaimed 462.4 MB; the primary production database and business data were not
changed. Read-only metadata showed substantial dead tuples in
`certification_facts`, `fns_source_receipt_refs`, and `ledger_entries`, while
two long-lived `idle in transaction` sessions remained unaddressed.

The reviewed code path showed that scheduled sync performed a full accounting
catch-up and then persisted certification with `replace=true` on every run.
The resulting delete/insert cycle was the confirmed churn mechanism for full
certification snapshots. `fns_source_receipt_refs` lifecycle updates were not
classified as redundant because `last_seen_at` is part of its source lifecycle
contract.

PR #165 adds exact snapshot reuse for an unchanged READY certification,
replaces the current full snapshot only after source-state change, and skips
unchanged active ledger projections without writes. It adds regression coverage
for orchestration, repeated certification, source-state change, rollback, and
ledger write counters. The feature branch was locally checked with Node 22:
`npm run check` passed, the targeted accounting/certification/ledger/sync set
passed 29/29, and the full suite passed 457 tests with 61 PostgreSQL-dependent
tests skipped because no disposable PostgreSQL was available. The project
integration command reported `NOT RUN`, not PASS.

The two production `idle in transaction` sessions were not terminated. A
future approved read-only diagnostic must identify their exact role, owner,
`backend_xmin`, transaction age and query state before any separate decision;
no automatic termination is permitted.

After the no-op fix is verified and reviewed, physical table shrink remains a
separate maintenance operation requiring backup, temporary space, lock/WAL
budget, clone rehearsal, and explicit production approval.

## Fourth one-shot production read-only preview result (operator report, 2026-10-10)

The user separately and explicitly authorized the **fourth** one-shot
production read-only matched-purchase preview on 2026-10-10. The operator
reported exact master `f5530daf2d07f5258a31cc589c33bb817748e7a1`,
scope `default`, period
`2026-09-27T13:48:18Z`–`2026-10-10T16:18:16.138Z`,
`PREVIEW_EXECUTED=YES`, `PREVIEW_RUN_COUNT=1`. This authorization has
been **consumed**, even though the command failed.

Previously private local stdout/stderr/exit artifacts were inspected without
new production access. Stdout contained one valid **technical error** envelope:
`ok=false`, `status=TECHNICAL_ERROR`,
`reasonCode=READ_ONLY_PREVIEW_FAILED`, `data=null`; stderr was empty and
native exit code was 1. `TECHNICAL_ERROR_ENVELOPE_VALID=YES` is **not**
an aggregate-output validation pass:
`JSON_CAPTURE_VALIDATED=NO`, `PREVIEW_READINESS=TECHNICAL_ERROR`,
and **all ten preview matching/eligibility counts remain `UNCONFIRMED`**.
The exact-master runner catches errors without emitting an error stage.
`ROOT_CAUSE=UNCONFIRMED` — do not assert any particular SQL, connection,
permission, timeout or matcher failure.

Operator-reported persistence postcheck found no changes in the compared
counts (`NO_OBSERVED_CHANGE_IN_COMPARED_COUNTS`). Exact certification delta
is `UNCONFIRMED` because the complete fact baseline was not captured.
The report states temporary role cleanup `COMPLETE`, SSH cleanup
`COMPLETE`, and `PRODUCTION_FINANCIAL_WRITES=NO`. These are operator
reports, not independent live verification.

A minimal diagnostic-stage branch was pushed at
`dc6ef11e220e8b097510ce764d14ddde17e45431`, now under **draft
PR #163**. Initial local synthetic stage tests, targeted checks,
`npm run check`, and `git diff --check` were reported PASS, but the full
suite failed in a Windows sandbox (`EPERM`/`fetch failed`) and isolated
PostgreSQL integration was **NOT RUN** (Docker unavailable).
Independent review of PR #163 identified stage coverage and strict JSON
capture compatibility gaps. PR #163 must not merge until repaired and the
exact-head local/disposable PostgreSQL acceptance gate passes per
`docs/BUHGUY-LOCAL-TESTING.md`. No GitHub Actions runs were triggered.

**Next gate:** finish local-only diagnostics, fix/test the strict stage-coded
envelope, then decide whether an independently approved narrowly bounded
production diagnostic is even needed. There is **no authorization** for a
fifth preview, new production tunnel, grants or role, writer, deployment,
replay, catch-up, certification materialization, or automatic retry.

## Local SSH forwarding lifecycle rehearsal completed (operator report, 2026-10-10)

The operator reported a **local-only**, privately stored PowerShell 7
lifecycle wrapper fix: the old SSH child process inherited the invoking
sandbox/job lifetime and disappeared across separate Codex calls. The
previous harness also lacked PID start-time identity checks and could
mistake an occupied port for healthy forwarding. The corrected private
wrapper uses a persistent process outside the ephemeral sandbox,
PID-plus-start-time identity, readiness and forwarded-endpoint liveness,
bounded timeouts, PID reuse/occupied-port rejection, and idempotent cleanup.
It reuses the independently rehearsed local JSON capture rather than
rebuilding it using JavaScript template literals.

Operator-reported gates:
- `SSH_PERSISTENCE_ACROSS_COMMANDS=PASS`
- `FORWARDED_ENDPOINT_TEST=PASS`
- `READINESS_LIVENESS=PASS`
- `FAILURE_CASES=PASS` (occupied port, premature exit, PID reuse,
  stale process state, repeat cleanup)
- `CLEANUP_NO_LEAKS=PASS`, with local test server stopped and ports freed
- `PRODUCTION_TOUCHED=NO`, no repository code changes or PR for the
  private-only launcher; `READY_FOR_NEW_AUTHORIZATION=YES`.

The source of the private PowerShell wrapper and its synthetic runtime
evidence were **not** copied into GitHub and have not been independently
code-reviewed from the repository. These results document the operator's
local rehearsal, not a production-level preview success. The first preview's
aggregate JSON remains unrecovered, all matched-purchase preview decision
counts are `UNCONFIRMED`, and the old certification delta's writer remains
`UNCONFIRMED`.

**Gate:** a fourth production preview is NOT authorized by these local
results. Obtain fresh explicit one-shot approval first and apply the
existing temporary-role/private-loopback/read-only/strict-output-validation
and independent cleanup runbook without changes to financial data.

## Third preview attempt and independently approved cleanup (2026-10-10)

The operator reported a locally validated PowerShell 7 capture harness
(`ProcessStartInfo.ArgumentList`, separate private stdout/stderr capture,
strict aggregate allowlist). Synthetic E2E cases passed: READY/exit 0,
REVIEW_REQUIRED/exit 2, TECHNICAL_ERROR/exit 1, malformed or extra stdout,
unexpected stderr, and process crash. This was a **local rehearsal**, not
evidence that the production runner executed.

In the third separately authorized one-shot cycle, the private SSH loopback
did not persist across the local command boundary. The database identity
probe failed and the actual production preview runner was **NOT EXECUTED**.
`PREVIEW_READINESS` and all ten matching/eligibility counts remain
`UNCONFIRMED`; `JSON_CAPTURE_VALIDATED=NO`;
`PERSISTENCE_POSTCHECK=NOT_RUN`; `CERTIFICATION_DELTA=NOT_RUN`.
Do not turn those unknown values into zero or infer a ready state.

The third temporary PostgreSQL role was
`buhguy_preview_ro_20261010_third`. The initial cleanup stopped with the
role set to `NOLOGIN`, but all 23 column-level grants still present and five
own `idle / ClientRead` loopback sessions remaining. A subsequent
**separately explicit user authorization** approved only the targeted
termination of these five role-owned sessions, after checking exact role,
database, backend identity/state and absence of drift. Operator-reported
final cleanup:
- all five approved sessions terminated; zero role sessions remained;
- no unrelated sessions touched;
- all 23 explicit column SELECT grants plus schema USAGE/database CONNECT
  revoked, no role-specific effective grants or owned objects remaining;
- `DROP ROLE` succeeded and the role was absent from `pg_roles`;
- SSH tunnel closed; `PRODUCTION_FINANCIAL_WRITES=NO`.

The normal `PUBLIC` baseline database CONNECT / schema USAGE privileges
remain unchanged. They are **not** residual grants belonging to the deleted
temporary role. No new preview JSON, payment matching decisions, or
certification provenance were obtained. The third one-shot authorization
and the separate targeted termination authorization are both consumed.

**Next action:** a synthetic/local-only persistence and teardown rehearsal
for SSH forwarding using an isolated test target. Verify process ownership
across launcher boundaries and durable port binding; close the process
without leaving sessions. Do **not** start a fourth production preview,
recreate the temporary role, open a production tunnel, access production
data or enable financial writers without a further explicit approval.
GitHub Actions remains paused under the temporary October policy.

## Certification postcheck provenance follow-up (2026-10-10)

The operator investigated the first preview's unexplained certification-table
postcheck change **without production access or code changes**. The original
JSON could not be recovered (terminal output truncated; no separate file).
A local rehearsal of direct safe JSON capture completed PASS, but no real
preview readiness or match counts have been recovered.

The observed before/after counts and maximum sequence IDs were:
- `reconciliation_runs`: count 1 -> 1; max ID 4125 -> 4126
- `certification_facts`: count 5875 -> 5875; max ID 13487702 -> 13493577
- `reconciliation_results`: count 8 -> 8; max ID 24702 -> 24710

The only established bounding window is
2026-10-10T11:51:50.675Z–2026-10-10T12:09:21.935Z. The identical row
counts and exactly count-sized ID deltas are **consistent with** a full
certification snapshot replacement. They do not prove a particular SQL
statement or writer. The source-controlled
`runAccountingCatchup() -> rebuildCertification(persist=true, replace=true)`
path is one plausible source; ledger/writer-triggered refresh, explicit CLI,
guarded materialization, and scheduled sync paths also exist. The one-shot
matched-purchase preview is READ ONLY and has no certification write path.

`WRITER_PROVENANCE=UNCONFIRMED` and
`UNAUTHORIZED_WRITE_EVIDENCE=NOT_PROVEN`. The retained local artifacts
contain no historical PostgreSQL statement audit, actor identity, or
authoritative run metadata for this interval. Do not infer an actor or
legitimate schedule from the counts, nor expect missing historical
statement-level logs to be recreated retroactively. If reliable existing
server logs or run metadata later become available, review them via an
independently authorized narrow READ ONLY investigation; no further
unbounded archaeology is a release gate for a non-mutating preview.

A second production read-only preview remains separately authorized only
after new explicit approval, because the previously approved one-shot cycle
was consumed. It must record stdout in a private file, validate exactly the
safe JSON contract/exit status, report only aggregates, recheck isolation
and persistence, and remove the temporary role. This is **not** permission
to write, catch up, certify, backfill, or deploy.

## Temporary GitHub Actions pause and local test gate (2026-10-10)

GitHub notified the Adamaste account that its 2,000 included Actions minutes
are fully used for the current billing period, resetting 2026-11-01. The
user explicitly requested no automatic GitHub-hosted test runs until reset,
and authorized running all checks locally on a development machine or isolated
test server. In `.github/workflows/ci.yml`, the `push` and `pull_request`
triggers are temporarily removed; `workflow_dispatch` remains available for
exceptional explicitly authorized use only. Neither routine pushes nor PRs
should spend Actions minutes during the pause.

The test suite itself is unchanged. For backend/financial code PRs use
exact-HEAD Node 22 check/unit/integration results, with PostgreSQL 16 via the
existing **disposable Docker test database** runner, never the production DB.
Android changes require isolated local Android SDK/Gradle tests. Do not merge
functional PRs when required local integration tests were skipped. Review
real PR diffs and threads, not a fictitious green CI status. Details and
the November restore steps are in `docs/BUHGUY-LOCAL-TESTING.md`.

The active P0 step remains recovering the first preview's lost aggregate
result from existing local artifacts without production access, and
clarifying unexplained certification changes. Pausing GitHub CI does not
authorize production role creation, rerunning preview, data mutation,
deployments, or certification materialization.

## First one-shot preview result and cleanup (2026-10-10)

The operator's report for the separately approved, one-time production cycle
used master `6ccea4e067c1432b4f76607317d49e88aea6b722`. The temporary
role was created, verified with privilege/scope/SSH gates PASS, and the
read-only runner was invoked once. However, terminal-output overflow
prevented recovery of its safe aggregate JSON. `PREVIEW_READINESS`,
`PERSIST_REQUIRED`, `ALREADY_PERSISTED`, `BLOCKED`, `AMBIGUOUS`,
`UNMATCHED`, and `INELIGIBLE` are **UNCONFIRMED**, not zero or PASS.

The operator reported the role switched to NOLOGIN, all grants revoked, role
dropped, tunnel closed, no production financial writes initiated by this
operation, and no runtime change. Independently verifiable historical
artifacts of the preview result were not supplied. The persistence postcheck
reported changes restricted to certification tables, described as
potentially concurrent activity; that cause has **not** been independently
established. Since automatic certification refresh was not previously
activated, confirm provenance before declaring these changes benign.
Do not automatically repeat, repair, backfill, materialize, or run a writer.

The prior production approval covered this single execution and is consumed.
First search only existing local bounded output/transcript artifacts for the
original safe JSON (do not query production or expose secrets). If recovery
fails, practice direct stdout-to-private-file capture plus strict JSON schema
validation locally with synthetic results before seeking a fresh, explicit
approval for a new one-shot production role/preview cycle. See the runbook's
output-capture section.

## Read-only matching preview access preparation

PR #155 and PR #156 are merged. The verified master is
`8e2268f47eb80e8b69b5b88e3a1d65517cbe622d`; master CI
`38048318293` passed. PR #156 removed wildcard reads from the matching and
enrichment SQL path without changing the authoritative matcher or writer.

The merged runner needs SELECT on 23 existing `public` tables, with an exact
column allowlist documented in
`docs/matched-purchase-preview-readonly-role-v1.md`. The prior bounded catalog
audit found seven missing table SELECTs on `receipt_collector`, and that role
also has DML, so it must not be reused. `chatgpt_reader` has no access to the
path. One current accounting scope, `default`/id `1`, was observed, but
column grants are not row isolation; the fixed operator scope and one-scope
preflight are therefore mandatory.

The next operational step is not yet executed: an independently approved
administrator may create a short-lived LOGIN role with only the documented
column SELECT grants, use the existing private SSH loopback for the exact
master local runner, perform exactly one bounded `REPEATABLE READ READ ONLY`
preview with literal scope `default`, verify aggregate persistence state is
unchanged, and revoke/disable/drop the role. No role, grant, preview, writer,
materialization, deployment, replay, backfill, or production data change was
performed for this preparation.

## Account-transfer preparation closeout

The GitHub source of truth was rechecked at master
`bab619143a1bfde82bb9e126a1b47b9dd460d979`. PR #152, `feat: add
non-production canonical spending MCP transport`, remains OPEN and is not
merged. Its implementation, dependencies, and transport are not part of the
current recommended path.

The local Windows SSH configuration is already prepared for the next account:
the per-user OpenSSH config contains the `github-buhguy` alias, uses only the
registered `github_buhguy_ed25519` identity for that alias, and preserves the
existing included host configuration. Git origin in the primary local repo is
`git@github-buhguy:Adamaste/buhguy.git`. A local-only inventory was created
outside the repository; it must never be committed or uploaded.

All existing worktrees and the primary worktree's uncommitted state are
preserved. A new session must use a fresh clean worktree for changes and must
not reset, clean, stash, checkout, or overwrite the primary dirty worktree.
See `docs/BUHGUY-ACCOUNT-TRANSFER.md` for the manual account-transfer steps.
## Permanent engineering rule: SIMPLE-FIRST / REUSE-FIRST

For every structural change, first evaluate and reuse existing repository
components before introducing a new service, protocol, publication layer, or
parallel accounting implementation. The decision record must compare
implementation cost, execution speed, dependency count, diagnostic complexity,
operational support burden, security surface, and failure/recovery behavior.
Add a new component only when the existing mechanism cannot satisfy the
reviewed contract, and record the concrete gap and the smallest alternative.

This rule is permanent. The canonical spending read service from PR #150 is a
thin adapter around the existing queryCanonicalSpending() and current
source-state/READY guard; it is not a second SQL accounting implementation or
PostgreSQL publication layer.

## Canonical spending read service v1 closeout

PR #150 was squash-merged in cd73f80010906362e1c45ab1a8813573e3667323.
The implementation remains read-only and reuses the authoritative
queryCanonicalSpending() path. Its exact-head CI passed as run
37936606016: unit tests, PostgreSQL integration, full suite, and syntax/check
gates passed; Android jobs were skipped because the diff was backend/docs-only.

The service enforces authenticated server-side scope authorization, rejects
foreign explicit scopes, ignores caller timeout settings in favor of bounded
server values, and exposes only a curated fail-closed result. Contradictory
READY results, unsafe reason text, and malformed nested data are rejected as
CORRUPT without financial data. The disposable return proof remains
100.00 RUB gross, 20.00 RUB returns, and 80.00 RUB net.

Performance evidence is limited to a small disposable fixture: the current
exact-head measurement used fixture_rows=4 and reported fingerprint
2.32 ms, full READY guard 7.01 ms, and period query with guard 16.14 ms.
Earlier fixture values 3.43/8.90/24.31 ms are historical test measurements.
None is a production benchmark or latency forecast.

Custom MCP registration is not confirmed for the real ChatGPT account. OpenAI
availability depends on the account plan and client support, so no MCP
transport is to be designed or implemented until registration and the required
client path are explicitly verified. The next stage is to confirm the actually
available ChatGPT integration path, then conduct security review of a
least-privilege production READ ONLY connection and authoritative
current-state probe. No production grants, DDL, deployment, materialization,
writer, replay, backfill, or automatic certification refresh is authorized by
this closeout.


## Canonical spending read-only query API v1 (merged)

PR #146 is merged in master `f64d2399516aac2efff38feb2c9cf1ab046ebe49`. PR #148 is merged in master `b42403ac305ff72cecf4dbd28816ced0ea663202`; its disposable PostgreSQL return proof establishes `100.00 RUB` gross, `20.00 RUB` returns, and `80.00 RUB` net. The
read-only query API reuses the authoritative current-snapshot source-state
fingerprint and READY guard, executes inside one bounded
`REPEATABLE READ READ ONLY` transaction, keeps explicit scope/period/timezone
and currency separation, and returns decimal-string gross/returns/net values
at purchase grain without double-counting item fan-out. STALE, MISSING,
CONFLICT, CORRUPT, and ACCESS_ERROR remain explicit fail-closed outcomes.
Bank-only or otherwise unresolved spending is reported as incomplete/excluded
from certified acquisitions; certified acquisitions are not the complete set
of personal expenses.

The disposable PostgreSQL fixture proves non-zero purchase and return-period behavior,
including `100.00 RUB` gross, `20.00 RUB` returns, and `80.00 RUB` net,
duplicate protection, period boundaries, multi-currency separation,
item-grain fan-out protection, pagination, source-state drift, and
category/person/unattributed reconciliation. This closes the return-case
proof gate for the read-only publication design; it does not activate
production publication.

No direct SELECT on canonical `public` objects is granted to
`chatgpt_reader`. The production read-only access path remains unfinished:
the next security-reviewed design must execute the current-snapshot guard and
period query through an approved least-privilege read-only connector/service,
then publish only curated safe results through `chatgpt_accounting`. A
simple latest-run view is not equivalent to authoritative current-snapshot
validation. No grants, DDL, deployment, writer, materialization, replay,
backfill, or production mutation occurred in PR #146.



## Spending correctness MVP and certification arithmetic review

PR #142 is merged in master `b0531f12325ba2419743b8f46169abda6c64da6e`. Its read-only spending consumers use exact decimal minor-unit arithmetic and reject mixed certification source states without combining currencies or item-grain rows.

PR #144 is merged in master `312ecf2e331d833d68d70b2f98f5a969b5fbef00` as the certification-layer exact-decimal correction. It replaces monetary Number()/toFixed(2) arithmetic in src/certification.js with NUMERIC(18,2)-compatible BigInt minor units while preserving existing business rules, public contracts, semantic identities, idempotency, and certification invariants. Its exact head is 21b73e3321ab2e217f581d12fa1f0cd587ecc3da and exact-head CI 37833139812 passed unit, PostgreSQL integration, full suite, syntax and repository checks; Android jobs were correctly skipped for this backend-only diff. The correction is merged and remains non-production until the separately authorized read-only validation; no deployment occurred. No migration, production write, deployment, grant change, replay, backfill, or automatic materialization occurred. The next operational stage is production read-only canonical spending validation, followed by a ChatGPT-facing read-only API.

## Production certification materialization v1 (completed)

The exact master `ca5a4dfbf8831f85a0b2fe63892935e8dd6210cb` passed master CI
`37789258443`. After a fresh read-only preflight, the first authorized
materialization for Person 1 scope `default`/id `1` used source state
`fd410badc5b1d1ac33b22ddebfeb31902b733ef9dfef03347fe77380334a6b01`.
`NO_CURRENT_CERTIFICATION` was the permitted initial state: no exact current
unbounded READY run existed before the call. The preflight projection had
5,843 facts and 8 results, all RUB; exact decimal reconciliation gave gross
`2211660.87`, returns `5782.29`, and net `2205878.58`.

Exactly one guarded public `materializeCurrentCertification()` call was made
with the approved bounded options and no retry. It committed READY run `3961`
with 5,843 facts and 8 results. The independent exact-master read-only reader
then returned READY for the same source state. All eight analytics views were
present; the current household, category, and person summaries reconciled in
RUB to gross `2211660.87`, returns `5782.29`, and net `2205878.58`. The
validated backup was created outside the release checkout with SHA-256
`cfabf2c6b7f898dc7471d85f66216f9c53c3e84ae60f8a13612ec6ef091544aa`.

The service remained healthy and ingestion remained active. No bank, receipt,
ledger, matched-purchase, business, classification, grant, or view data was
changed by the operation; only the approved certification run, facts, and
results were added. Historical certification rows remain immutable. Future
source changes must be handled by a fresh read-only preflight and separately
approved materialization; no automatic refresh, replay, backfill, or writer
trigger is enabled.

## Guarded one-shot certification materialization (historical implementation record)

At that historical implementation stage, master was
`2f05c5928f92fc34cdade326733b31dd6b74ceaf`. The implementation PR added
`materializeCurrentCertification()` as a
guarded one-shot full unbounded certification writer. It uses one
`SERIALIZABLE` PostgreSQL transaction, bounded lock and statement timeouts,
an accounting-scope lock, one authoritative source-state/projection snapshot,
immutable historical runs, atomic run/fact/result insertion, exact semantic
identity revalidation, and rollback on conflicts, timeouts, failures, or
serialization retries. The production call requires the exact SHA-256
`expectedSourceStateKey` from the approved read-only preflight; missing or
mismatched identity fails before any INSERT. It never uses `replace=true`,
deletes history, or invokes the matched-purchase writer.

The disposable clone test contract covers creation of a full READY snapshot,
current-snapshot reader READY compatibility, same-state per-currency
household/category/person reconciliation, missing and wrong expected keys,
idempotent retry without extra rows, concurrent source-change fail-closed
behavior, overall timeout, and injected failures after run/facts/results with
exact rollback. Household/category/person
gross, returns, net, and unresolved/unclassified buckets must reconcile by
currency using exact decimal arithmetic before any production approval.

Production remained read-only during that implementation stage. The completed
materialization is recorded above; any future materialization requires
a fresh validated backup, explicit authorization for the exact scope and
source-state key, a repeatable-read read-only precheck, same-state fact/result
and per-currency reconciliation, bounded write transaction, and read-only
postcheck. `NO_CURRENT_CERTIFICATION` is allowed when no exact unbounded
`READY` run exists for the approved state; an existing foreign, conflicting,
corrupt, or non-READY exact run is a STOP, as are source drift, lock/timeout,
semantic mismatch, or failed postcheck. No automatic
refresh, replay, backfill, deployment, classification, or accounting catch-up
is permitted.

## Production read-only canonical spending current-snapshot validation

The exact merged master `bdeb1fb607fb68d36bf146ffa1584761616f923c` was
validated by CI run `37756941658`, including PostgreSQL integration, full
suite, Android, and signed Android. The production probe used only
`REPEATABLE READ READ ONLY` transactions and recorded a safe duration of about
1.2 seconds.

For Person 1 scope `default` (scope id `1`), the probe found:

- `SCHEMA_019_PRESENT=NO`;
- `ANALYTICS_011_VIEWS_PRESENT=NO`;
- no live-source matching unbounded `READY` certification run;
- `CURRENT_CERTIFICATION_STATUS=MISSING`;
- certification integrity and household/category/person reconciliation were
  blocked because the required schema/read-model layer is not present.

The least-privilege service database role could not read the certification
source tables (`42501`); the safe preflight was therefore repeated with the
local PostgreSQL administrative path, still inside read-only transactions.
No grants were changed. Persistence snapshots were identical before and after
the probe, and no certification refresh, writer, migration, deployment,
classification, replay, or backfill was performed. The next action is to
review schema readiness before any repeat validation; do not install missing
tables or views as part of this closeout.

## Controlled matched-purchase expansion design v1 (historical)

The exact-master read-only expansion review used master
`b0f1e8222bd84a1a8923c1285871ee67d5a8dd67` with
`internalTransferMaxTimeDeltaMs=5000` and
`receiptMaxTimeDeltaMs=300000`. Two separate `REPEATABLE READ READ ONLY`
previews were identical. They found 13 current MATCHED pairs: the persisted
canary `164/15857` was `NOOP_ALREADY_PERSISTED`, and 12 additional pairs were
`PERSIST_REQUIRED` with `REFINE_EXISTING_FISCAL_FUNDING`. The canary was
excluded from the expansion set. No writer was invoked.

The review found no new competing edge when the diagnostic receipt window was
expanded to 3600000 ms. The 19 currently unmatched eligible PURCHASE/DEBIT
bank rows had no compatible eligible receipt within one hour; no window bucket
or ambiguity evidence justifies changing the 300000 ms policy.

All 12 current candidates are classified `LOW` using only proven structural
facts: isolated at five minutes and one hour, exact FNS-derived RUB, existing
standalone refinement, concrete same-scope account mapping, no persisted match
or bank evidence, no supersession/conflict, and deterministic repeated
preview. This is a risk classification, not probabilistic confidence.

The recommended execution shape is `ONE-BY-ONE`, with batch size 1 and stop
on the first failure. Each item requires a fresh precheck, one atomic public
writer call, post-write invariant validation, and a same-item idempotency
check before any next item is considered. Any source-state change,
certification disagreement, ambiguity, conflict, non-determinism, or double
funding is a STOP condition. No automatic rollout, SQL bulk insert, runtime
trigger, replay, backfill, deployment, or identity mutation is authorized.

## Controlled matched-purchase expansion execution review (historical)

The reviewed pre-execution design is recorded in
`docs/matched-purchase-controlled-expansion-execution-v1.md`. It was a design
and read-only review only. At that historical stage no writer call, production persistence, deployment,
replay, backfill, accounting catch-up, or identity mutation is authorized by
this document.

The fresh exact-master review used master
`a6233f13c31787d289ce9d275f2df4cbe3fb49ee` (docs-only squash merge after
master `b0f1e8222bd84a1a8923c1285871ee67d5a8dd67`) with the production policy
`internalTransferMaxTimeDeltaMs=5000` and
`receiptMaxTimeDeltaMs=300000`. Two separate `REPEATABLE READ READ ONLY`
transactions returned identical `READY` previews: 13 matched pairs, one
existing canary `NOOP_ALREADY_PERSISTED`, and 12 current
`PERSIST_REQUIRED`/`REFINE_EXISTING_FISCAL_FUNDING` candidates. There were
zero blocked, review-required, ambiguous, or ledger-conflict decisions.

The one-hour diagnostic window found the same 13 pair identities, with no new
competing edge. The production policy remains five minutes; no widening is
recommended. The current diagnostic population has 19 unmatched eligible bank
purchase rows with no compatible eligible receipt within one hour.

The canary still has exactly one match, one bank evidence row, one
`3158966 -> 4168251` supersession, one ACTIVE ledger entry, two balanced
postings, no active fiscal-new-money fact, and canonical receipt currency
NULL. The fresh ACTIVE source state has not yet had a coherent certification
run materialized, so this remains a mandatory pre-write gate rather than an
execution authorization.

## Matched-purchase canary postmortem (historical)

The first production canary core persistence succeeded for bank transaction
`164`, receipt `15857`, and purchase event `297272`. Match `1` and bank
evidence `1` were persisted; the existing purchase was reused; the new
bank-funded ledger entry `4168251` superseded standalone entry `3158966`
append-only; its two postings balance at `2200.00 RUB`; exactly one ACTIVE
SYSTEM_DERIVED entry remains; and no double funding was observed. Canonical
receipt currency remains NULL, and the other eleven preview matches remain
unpersisted.

The post-fix exact-master certification snapshot was materialized for the
stable source state as READY run `3848` with 5837 facts and 8 results. A
direct same-state certification refresh returned `reused=true` and
`refreshed=false`; the run, facts, and results were byte-identical.

The one authorized post-fix public writer replay returned the same match,
event, bank-evidence, active-ledger, and enrichment identities. The complete
selected matched-purchase and ledger state was byte-identical, with no new
semantic rows, postings, links, supersession, or double funding. The active
bank-funded entry remains `4168251`; standalone entry `3158966` remains
immutable history. The fresh backup was validated before the operation, and
the sync timer was restored to its original enabled/active state with a
healthy inactive oneshot service.

This closes the first matched-purchase production canary. The remaining
eleven matches remain unpersisted. Broader runtime rollout from the active
`8e18a9d65c933045820b0771afbcdd1c28546956` release is a separate task and is
not implied by this canary.

## Controlled matched-purchase expansion result v1

The controlled expansion result is recorded in
`docs/matched-purchase-controlled-expansion-result-v1.md`. It ran from exact
master `25883d586654194d899ea6cbfea06c4beafd76b6` while the active
bank-ingestion runtime remained `8e18a9d65c933045820b0771afbcdd1c28546956`.
The sync timer was frozen only for the operation and restored to its original
enabled/active state; the ingestion service was not stopped.

The fresh validated PostgreSQL backup was
`finance_receipt_collector-20261007T150545Z.dump.gz` with SHA-256
`070db017194259646e806125a84490cfc5bb273ee8538a631943556b759068f0`.
The baseline source state was stable and certification run `3859` was READY;
the final source state is
`dfaca835c8a9c9678fd778a8e04783940a7f0053d42edc5b1ce305cbbd02f2aa` with
READY run `3871`.

Exactly the 12 reviewed transactions
`111, 326, 112, 394, 305, 95, 177, 291, 245, 299, 182, 81` were processed in
order. Each used one public writer call and one identical replay. The final
state contains exactly 13 matches including the original canary, 13 bank
evidence rows, and 13 supersessions; no unreviewed match was persisted. Each
reviewed event has exactly one ACTIVE `SYSTEM_DERIVED` ledger entry and two
balanced postings. Certification is coherent and current-state facts exclude
superseded fiscal funding. `EXPANSION_RESULT=GREEN`.

The only production mutation was the explicitly authorized 12-item writer
expansion and its idempotent replays. No deployment, historical replay,
backfill, accounting catch-up, or identity mutation occurred.

## Matched-Purchase Production Window Policy v1

The matching-window sensitivity review is closed by
`docs/matched-purchase-production-window-policy-v1.md`. For production
receipt matching, `receiptMaxTimeDeltaMs=300000` is the inclusive absolute
event-time policy. Exact scope, amount, and currency remain mandatory, and
the complete bipartite matcher remains fail-closed without nearest or greedy
selection.

The policy covers all 32 eligible Person 1 PURCHASE/DEBIT bank rows. It is
the smallest tested threshold that captured the stable final set of 12
isolated one-to-one pairs; 120000 ms omitted one pair, while 300000 through
3600000 ms added no edges, ambiguity, or pair identity changes. Sber had no
receipt-compatible pair, which is not a reason to widen the policy. Absence
of a match remains acceptable.

The internal-transfer window is not frozen as policy because production has
no proven internal-transfer pair. The 5000 ms value may be used only as a
conservative parameter for the current read-only preview after revalidating
purchase and edge-set invariance against 3600000 ms.

## Controlled Production Read-Only Matched-Purchase Preview

Using exact master `4dfea0c5159541d668c5ab1a008dd22f09943de7`, schema 018, and
Person 1 scope `default/id1`, the authoritative preview was run twice in
fresh `REPEATABLE READ READ ONLY` transactions. The bounded population was 32
eligible PURCHASE/DEBIT bank rows. With `receiptMaxTimeDeltaMs=300000`, the
internal-transfer invariance recheck produced the same 12 match identities
at both 5000 ms and 3600000 ms; all 12 were isolated exact amount/currency
pairs.

Both previews were `READY` with 12 `PERSIST_REQUIRED` decisions, zero
`NOOP_ALREADY_PERSISTED`, zero `BLOCKED`, zero ambiguity, zero
`LEDGER_CONFLICT`, and zero review-required decisions. All 12 decisions were
`REFINE_EXISTING_FISCAL_FUNDING`; no FUTURE_SINGLE or bank-funding reuse path
was selected. The repeated preview produced identical decisions and stable
match/enrichment/orchestration identities.

Before/after persistence snapshots were identical in both transactions:
`bank_receipt_matches=0`, `business_event_bank_evidence=0`,
`ledger_entry_supersessions=0`, `ledger_source_links=2006`,
`business_events=2063`, and `ledger_entries=2063`. The writer was not
invoked. No orchestration result was persisted, and no deployment, replay,
backfill, accounting catch-up, or production mutation occurred.

Master CI `37604435364` passed all applicable jobs, including PostgreSQL
integration/full suite and signed Android. The next stage is `controlled
first matched-purchase persistence canary execution`: one selected pair is
documented with explicit safeguards before any writer execution is considered.

## Matched purchase writer FNS compatibility closeout

PR #122 is merged in exact master
`4dfea0c5159541d668c5ab1a008dd22f09943de7`. The atomic matched-purchase
writer now revalidates the shared FNS currency contract inside its
authoritative transaction: FNS-source-proven receipts may derive RUB while
canonical `receipts.currency` remains NULL, and proof loss or explicit
non-RUB currency fails closed. The production-shaped PostgreSQL regression
covered the existing standalone PURCHASE refinement, immutable old ledger
history, one active bank-funded replacement, and deterministic replay. No
writer was invoked in production, and no migration, deployment, replay,
backfill, or production mutation occurred.

## Bank business-event candidate projection v1

PR #95 is merged in master `1a14d93be8148ffc02b8d137229dc5940d1eaada`.
`bank-business-event-candidate-projection-v1` is a non-mutating, in-memory
projection chain:

`bank transaction`
-> `bank-cash-flow-projection-v1`
-> `balanced-bank-journal-projection-v1`
-> `bank-business-event-candidate-projection-v1`

`PURCHASE + DEBIT` produces a PURCHASE candidate; proven outgoing and incoming
transfers produce directional TRANSFER candidates; exact UNKNOWN with proven
DEBIT/CREDIT produces `UNCLASSIFIED_MONETARY_MOVEMENT`. The projection never
infers `INTERNAL_TRANSFER`. It verifies the journal content-address key,
restricts bankSide to a concrete financial account or
`UNRESOLVED_BANK_ACCOUNT`, and requires coherent account-resolution provenance.

No receipt matching, business-event persistence, ledger persistence, database
mutation, production wiring, deployment, replay, or backfill was added.

## Bank internal transfer matching v1

PR #97 was squash-merged into master `628a57d8d4a6b2beff002e7bfa69a5c00860d292`.
`bank-internal-transfer-matching-v1` is a non-mutating, in-memory projection
over validated bank-business-event candidates and their balanced journals.

An `INTERNAL_TRANSFER` candidate is created only from two independently proven
opposite-direction `TRANSFER` candidates with concrete distinct financial
accounts, exact equal amount and currency strings, the same accounting scope,
an explicit finite caller-supplied bounded `occurredAt`/event-time window, and
exactly one common explicit `OWNER` person. `AUTHORIZED_USER`, source context,
device/provider identity, and payment-instrument identity do not prove account
ownership. One-sided transfers remain one-sided; ambiguous connected
components fail closed without greedy or nearest matching.

The matcher regenerates and revalidates candidate/journal coherence at its
boundary, validates the ownership snapshot contract, and emits only the two
relevant common-owner evidence assertions in matched provenance. Matching is
one-to-one and deterministic; no candidate is reused or fanned out.

No persistence, ledger writes, receipt matching, replay, backfill, deployment,
or production mutation was added. The next separate stage after this matcher
is `bank-ledger-projection-v1`; ledger persistence remains unimplemented.

## Bank ledger projection v1

PR #99 was squash-merged into master `6d218ad67ab1fb49a4b2cfc3e49b5d683c0682b0`.
`bank-ledger-projection-v1` is a deterministic, content-addressed,
non-mutating in-memory projection over validated balanced journals, business
event candidates, and the internal-transfer overlay. Standalone purchase,
outgoing-transfer, incoming-transfer, and unclassified monetary movements
retain their validated balanced-journal semantics. A proven internal transfer
consumes exactly two bank sources and emits one economic balanced posting pair;
the symbolic unclassified counterpart postings of the matched pair are not
propagated. Unmatched or ambiguous transfers remain standalone.

Ledger-invalid sources are excluded before matching. Money is handled as exact
canonical strings without Number/float arithmetic, and results remain
deterministic under input reordering. The projection preserves source
provenance, exact source consumption, and the outgoing candidate time while
retaining the incoming time in provenance.

No business-event persistence, ledger persistence, receipt matching, database
mutation, production wiring, migration, replay, backfill, or deployment was
added. The subsequent bank-to-receipt matching stage is now implemented below;
ledger persistence remains unimplemented.

## Bank-to-receipt matching v1

PR #101 was squash-merged into master `bec6fe8b8f0746993f82fd83c205ff96c1eb9f94`.
`bank-receipt-matching-v1` is a deterministic, fail-closed, non-mutating
matcher over the authoritative bank-ledger projection and normalized fiscal
receipt evidence.

Only projected bank `PURCHASE` entries with a concrete financial account and
explicit same-scope `OWNER` evidence are eligible. This OWNER relation proves
bank-account ownership only; it is not payer proof. Eligible receipts are
strict `fiscal-normalizer-v1` READY electronic full-settlement evidence:
sale/OUT, reconciled components, exact positive `ecash_total_sum`, explicit
zero cash/prepaid/credit/provision, complete item-fact coverage with payment
type 4 for every item, known currency, a single resolved accounting scope, and
the current non-correction state. Cross-scope, mixed/cash/prepayment/credit,
return/refund, correction, incomplete, or ambiguous evidence fails closed.

Matching requires exact scope, amount, currency, and an explicit bounded
inclusive event-time window. The matcher builds the complete bipartite graph:
isolated one-to-one compatible components match; zero-edge eligible nodes stay
UNMATCHED; competing connected components are AMBIGUOUS with no greedy or
nearest-time selection. The receipt amount basis is exact
`ecash_total_sum`; money is not compared with floating-point tolerance.

The bank movement remains the sole cash-flow fact. A match emits only an
evidence relationship and statuses; it creates no second ledger entry,
posting, business event, migration, reconciliation mutation, replay, backfill,
or deployment. Existing `STANDALONE_PURCHASE_V1` receipt-only history is not
rewritten. Multi-item receipt coverage and full receipt-scope evidence are
preserved by the SELECT-only loader, and `fns_source_person.OBSERVED_BY` is
not used as payer evidence.

PR #101 exact-head CI run `37368023085` ultimately passed the test job,
PostgreSQL integration gate, full suite, and Android job after GitHub-hosted
runner cancellations/delays; `android-signed` was correctly skipped for the
pull_request event.

## Matched purchase enrichment projection v1

PR #103 was squash-merged into master `d354fb5eb9ff2cf40eb1e72faf65e3a03d9cfbf8`.
`matched-purchase-enrichment-projection-v1` is a deterministic, non-mutating,
in-memory projection over the validated bank-to-receipt match and its existing
upstream bank cash-flow, balanced-journal, business-event-candidate, and ledger
projections:

`bank transaction`
-> `bank-cash-flow-projection-v1`
-> `balanced-bank-journal-projection-v1`
-> `bank-business-event-candidate-projection-v1`
-> `bank-ledger-projection-v1`
-> `bank-receipt-matching-v1`
-> `matched-purchase-enrichment-projection-v1`.

The bank movement remains the sole monetary funding fact. A matched receipt
enriches exactly one purchase and never creates a second cash flow. The existing
`STANDALONE_PURCHASE_V1` is reused conceptually; no receipt-side second posting
or silent standalone-history rewrite is introduced. Persistence remains blocked
and unimplemented as a write path; its reviewed contract is recorded below.

The minimal persistence design must address four reviewed gaps:

1. `business_event_evidence` cannot link bank transaction or match evidence.
2. `ledger_source_links` cannot link bank evidence.
3. Persisted ledger lacks reviewed refinement/supersession semantics for
   replacing `FISCAL_PAYMENT_CLEARING` with concrete bank funding.
4. `financial_account` identity has no reviewed persisted ledger-account mapping.

The persistence contract/schema design was reviewed and closed by PR #105.
The schema foundation was implemented and merged by PR #107 as migration 018
with PostgreSQL constraint coverage. No matched-purchase writer, deployment,
replay, backfill, or production mutation was performed.

## Matched purchase persistence contract v1 closeout

PR #105 was squash-merged into master `7419e6524ad07f2ed540368011ad96ff81995fe9`.
The `matched-purchase-persistence-contract-v1` design was reviewed and merged;
the persistence design gate is closed. It defines immutable bank-receipt match
evidence, separate business-event bank evidence, one-to-one match constraints,
append-only ledger refinement/supersession, active-ledger certification state,
and deterministic financial-account ledger mapping.

No migration, code, runtime write path, deployment, replay, backfill, or
production mutation was performed for the design stage. Migration 018 now
provides the reviewed schema foundation; its PostgreSQL constraint coverage
passed. The next stage is `matched purchase active-ledger runtime semantics`.

## Matched purchase persistence schema foundation closeout

PR #107 was squash-merged into master
`949c1f57e093626748545098e80004b76eb24103`. Migration 018 establishes the
reviewed one-to-one bank-receipt match, separate business-event bank evidence,
financial-account to ledger-account mapping, additive bank source links, and
append-only ledger supersession constraints.

No deployment, replay, backfill, runtime matched-purchase writer, or production
mutation occurred. The next stage is `matched purchase active-ledger runtime
semantics`:

- certification, reconciliation, and analytics ledger reads must select only
  ACTIVE entries;
- superseded entries, postings, and source links remain immutable history;
- `sourceState`/`source_state_key` must change when supersession state changes;
- superseded `FISCAL_PAYMENT_CLEARING` must not contribute
  `FISCAL_NEW_MONEY` or acquisition totals;
- destructive ledger refresh/rebuild must fail closed or become
  supersession-aware, so it cannot delete/reforge protected history or
  resurrect a second active fiscal-clearing entry.

This stage does not add a matched-purchase persistence writer, deployment,
replay, backfill, or production mutation.

## Matched purchase persistence schema foundation production rollout

Master `7c116d7498ff154cf2c81b53b8b86b7c22136939` was used only as an
isolated migration source. The active backend runtime was not deployed or
restarted; its production path remains `/opt/accountant/receipt-collector`,
and the ingestion service remained healthy. Migration 018 was applied through
the reviewed migration runner as the sole authorized production mutation.

The pre-migration schema was 017 and migration 018 was the only pending
migration. A fresh PostgreSQL backup was created before the change, validated
with gzip and `pg_restore --list`, retained with `postgres:postgres` ownership
and mode 600, and recorded with SHA-256
`67a4b7394d3550ec0bf8245c45b6a50f35d8456eedf01f79f41536cbfc510469`.
The post-migration schema is 018 with exactly one new schema-migration row.
`bank_receipt_matches`, `business_event_bank_evidence`, and
`ledger_entry_supersessions` are present and empty. Historical counts and
common-column fingerprints remained unchanged; the pre-existing ledger state
was unchanged, including its pre-existing no-posting entries and zero debit /
credit imbalance among entries with postings. The runtime service remained
active and `receipt-collector-sync.timer` remained enabled and active.

No grants changed. No matched-purchase writer or preview was invoked; no
deployment, replay, backfill, or production business-data mutation occurred.
The next action is `matched-purchase production matching-window policy
review`; no preview or writer execution is authorized until that policy is
reviewed.

## Matched purchase active-ledger runtime semantics closeout

PR #109 was squash-merged into master
`46f79f0b1937a1f1cab1778df6c990d0813fb7ef`. Certification, reconciliation,
and analytics now consume only ACTIVE ledger entries. The canonical
`sourceStateKey` includes ACTIVE entries, postings, source links, scope/model
identity, and supersession state; inserting a supersession therefore changes
the source state. Stale certification facts from older source states are not
reused as current coverage. Superseded entries, postings, and links remain
immutable history, and destructive refresh/rebuild fails closed with
`LEDGER_SUPERSESSION_PROTECTED`.

No matched-purchase writer, deployment, replay, backfill, migration, or
production mutation occurred. The next stage is the `atomic matched-purchase
persistence writer`: revalidate authoritative inputs, run one atomic
transaction, persist or reuse `bank_receipt_matches`, reuse or create exactly
one PURCHASE, persist bank evidence, validate or create the deterministic
financial-account ledger mapping, create or reuse one bank-funded ACTIVE ledger
entry, append supersession when refining fiscal clearing, and refresh
certification using ACTIVE semantics. Replay must be deterministic and
idempotent; disagreement or ambiguity fails closed. This stage must not yet
deploy, replay, backfill, or mutate production.


## Matched purchase persistence writer v1 closeout

PR #111 was squash-merged into master `9b6b1499a3700be783e746c5f7ccc3e228084ed7`.
`matched-purchase persistence writer v1` is an atomic, deterministic,
idempotent implementation. It recomputes authoritative bank/receipt matching
inside the transaction, persists immutable/idempotent bank-receipt match
evidence, and refines existing standalone PURCHASE evidence append-only.

The FUTURE_SINGLE and REFINE paths are covered. Financial-account ledger
mapping is deterministic, exactly one bank-funded ACTIVE ledger entry is
enforced, replay and concurrency converge deterministically, and conflicting
provenance fails closed. Rollback and protected-ledger refresh behavior are
covered; ACTIVE certification excludes duplicate fiscal funding.

No migration, deployment, replay, backfill, or production mutation occurred.
The next stage is `matched-purchase writer orchestration / controlled
production-readiness validation`:

- decide when and how authoritative eligible matches invoke the writer;
- provide a non-mutating preview/dry-run of intended writes before any
  production mutation;
- expose eligibility/block reasons and idempotency identifiers;
- preserve fail-closed ambiguity handling;
- define operational retry and observability behavior.

This stage must not yet deploy, replay, backfill, or mutate production.

## Matched purchase writer orchestration preview v1 closeout

PR #113 was squash-merged into master
`812e4c67e991d770d783aff960bb7cfb8b75979d`. The
`matched-purchase-writer-orchestration-v1` preview is strictly non-mutating:
it uses the authoritative matching and enrichment loaders, requires explicit
finite matching windows, and emits deterministic `PERSIST_REQUIRED`,
`NOOP_ALREADY_PERSISTED`, and `BLOCKED` decisions. `AMBIGUOUS`, `UNMATCHED`,
and `INELIGIBLE` evidence remains visible.

The orchestration key is stable across successful persistence because it is
content-addressed from the reviewed stable semantic identity rather than the
current action. Explicit stale match selection fails closed. PostgreSQL tests
prove SELECT-only query behavior, a READ ONLY transaction, unchanged
persistence-table snapshots, stable pre/post-writer identity, authoritative
loader isolation, and safe summary observability. Orchestration has no writer
execution path and no sync or accounting-catchup wiring.

No migration, deployment, replay, backfill, or production mutation occurred.
The next action is `controlled production read-only matched-purchase preview`:
inspect production schema/runtime identity first, run the exact preview for
the Person 1 scope with explicitly reviewed windows through a read-only DB
path, record only safe summary/decision identifiers, classify the result as
`PERSIST_REQUIRED`, `NOOP_ALREADY_PERSISTED`, `BLOCKED`, `AMBIGUOUS`,
`UNMATCHED`, or `INELIGIBLE`, and verify before/after persistence-table
counts/hashes are unchanged. Do not invoke `persistMatchedPurchase`, enable
automatic execution, deploy a writer trigger, replay, backfill, or mutate
production in this stage.

## FNS receipt currency contract v1 closeout

PR #116 was squash-merged into master
`21ba5218ba5b1c33ba624fdd7f7a5da37f3cc6d5`. `fns-receipt-currency-v1` is a
shared, evidence-scoped resolver: FNS-source-proven receipts may derive `RUB`
when explicit currency is absent, while explicit `RUB` remains explicit
payload evidence. Explicit non-RUB or malformed currency fails closed.
The derivation is source-contract evidence, not matcher heuristics, and both
`receiptCandidateKey` and `matchKey` include the currency-resolution
provenance. Standalone purchase uses the same resolver.

The canonical `receipt_raw` and `receipts.currency` values remain unchanged.
No migration, normalization rebuild, replay, backfill, deployment, bank
identity change, or production mutation occurred. The next operational step
is a production read-only FNS currency eligibility recheck; it must not invoke
orchestration or `persistMatchedPurchase`.

## Production FNS currency eligibility recheck closeout

The exact-master read-only recheck completed in a repeatable-read transaction.
The Person 1 scope contained 2763 receipts; the previously identified 1845
receipts that failed only the currency predicate now derive `RUB` under
`fns-receipt-currency-v1`, so `RECEIPTS_STILL_FAILING_CURRENCY=0` and
`ELIGIBLE_RECEIPTS_AFTER_CURRENCY_CONTRACT=1845`. Canonical
`receipts.currency` values and all persistence-table state were unchanged; the
transaction was rolled back and no production data was mutated.

The same review found 32 authoritative `PURCHASE / DEBIT` bank rows without a
concrete `financialAccountId`. Existing account identity evidence is therefore
not sufficient to begin matching-window work. The next stage is the read-only
`production bank account identity provisioning review`; it must not infer
ownership from provider/source identity or execute any account, reference,
binding, or transaction-resolution mutation.

## Controlled user-confirmed bank account identity provisioning

The production identity review found exactly 28 authoritative `PURCHASE /
DEBIT` transactions for `com.yandex.bank` and 4 for
`ru.sberbankmobile`, all previously `UNKNOWN` with no financial account.
The user explicitly confirmed that payment instruments 4 and 5 are their own
cards belonging to one personal Yandex RUB account, and that the Sber rows
belong to their own Sber account in Person 1 scope.

After a validated PostgreSQL backup, exactly one active Yandex RUB financial
account (id 4) was created in the default scope with one `OWNER` relation
using `USER_CONFIRMED_IDENTITY`. Instruments 4 and 5 were linked to it. The
28 Yandex transactions and 4 Sber transactions were resolved through the
reviewed account-resolution path as `MANUAL` with
`USER_CONFIRMED_IDENTITY`; Sber account 1 was reused unchanged.

No `bank_account_references` or source/provider bindings were created or
changed. Bank transactions and immutable observations remained unchanged, as
did all matched-purchase persistence tables. The installed production runtime
remained on the previously deployed artifact; no deployment, replay, backfill,
orchestration preview, writer invocation, or accounting mutation occurred.

An exact-master read-only eligibility check using an explicit finite
diagnostic window reported 32 eligible bank purchases, zero target OWNER-gate
failures, and 356 eligible receipts in that window. This was not a matching
policy decision and did not run matching-window sensitivity. The next stage is
`matched-purchase production matching-window policy review`.

## T-Bank ordinary purchase validation baseline

PR #91 was squash-merged into exact master `f50426f76a3c7b7a732ac3d703a73e7dbd04fdf8`.
It adds the reviewed Yandex Pay outgoing v2 specialization with additive dispatch:
existing direct-package Yandex purchase/incoming behavior and the Yandex Pro
alias remain on the existing provider parser. Yandex Pay v2 has not been
deployed. No replay, backfill, account-resolution mutation, or accounting
persistence occurred.

A read-only production/device baseline was completed on 2026-10-05 before any
new T-Bank operation. Backend health and PostgreSQL were active; the global
bank evidence totals were 372 observations (maximum id 489) and 372
transactions (maximum id 373). The T-Bank corpus contained 99 observations
through observation 489 / transaction 373. Existing T-Bank purchase-like
notifications remain generic `PARTIAL / UNKNOWN` evidence without a reusable
transaction-amount or currency grammar, so `EXISTING_TBANK_PURCHASE_GRAMMAR=NONE`.

The authorized Android device `R5GL30GK60F` was connected, the notification
listener was enabled/live, the collector was installed and launchable, T-Bank
was allowlisted with notification delivery permitted, and the source/server
and credential configuration markers were present. The outbox had zero pending
events; capture, delivery, callback, and listener diagnostics were available;
no collector-specific runtime crash or permanent-rejection backlog was found.
No Android configuration, credentials, allowlist, listener state, database
row, account resolution, ledger, business event, or reconciliation state was
changed during this baseline.

The controlled ordinary purchase completed after this baseline produced one
new lifecycle window: primary observation `492` / transaction `375`, companion
observation `491` / transaction `374`, and empty companion
observation `496` / transaction `376`. All three used the exact T-Bank
provider/Android/schema transport metadata and persisted through
`tbank-bank-normalizer-v2`; the earlier apparent metadata gap was a reporting
formatting error, not missing immutable metadata.

`492/375=PRIMARY`, `491/374=COMPANION`, and `496/376=EMPTY_COMPANION`.
`ONE_MONETARY_CANDIDATE_PER_PURCHASE=BOUNDED_HEURISTIC`.

Observation `492` has title, description, and text; description and text are
equal; the body has a purchase-like lexical marker, an availability marker,
two currency-marker occurrences, and a masked-reference-shaped position.
No merchant/counterparty-shaped position or explicit debit/outgoing marker was
proven. Its event time is present. The operator-confirmed amount matches one
body monetary position, while a second monetary position remains separate but
its balance role is unproven. Observation `491` is a non-title structured
companion with one monetary/currency position that does not repeat the
controlled transaction amount; observation `496` is empty/non-monetary.

`TBANK_FIRST_PURCHASE_MARKER=PROVEN`; `TBANK_FIRST_PURCHASE_DEBIT_MARKER=NOT_PROVEN`;
`TBANK_FIRST_PURCHASE_AMOUNT_POSITION=1`; `TBANK_492_CURRENCY_PROVEN=YES`;
`TBANK_492_BALANCE_POSITION_SEPARATE=UNPROVEN`.

The complete T-Bank corpus has one exact match for the `492` structural
predicate, namely this controlled window; there are no top-up or outgoing
transfer collisions and no historical reusable purchase match. Persisted
normalization remains `PARTIAL / UNKNOWN / UNKNOWN` with no amount or
currency, and account resolution remains `UNKNOWN`. Therefore
`TBANK_PURCHASE_AUTHORIZATION=SECOND_CONTROLLED_PURCHASE_REQUIRED`: a second
independent purchase with a different amount would materially test repeatability,
separate the transaction amount from the secondary position, and validate the
single-primary lifecycle rule. No second operation is requested or performed
in this closeout.

No parser, account resolution, cash-flow, journal, business-event, ledger, or
reconciliation persistence was changed. No replay or backfill occurred.

The second independent ordinary T-Bank purchase produced one primary
observation `503` / transaction `380` and no companion. It repeats the exact
`492` structural family: purchase-like marker, description/text equality, two
monetary positions, and the first position matching the independently known
controlled amount. RUB and event time remain proven; no reusable DEBIT/outgoing
marker is present. The complete reviewed corpus now contains two exact family
matches, two proven controlled purchase matches, and no top-up, outgoing-transfer,
or non-monetary collisions. Account resolution remains `UNKNOWN`.

`TBANK_PURCHASE_AUTHORIZATION=INSUFFICIENT` and
`TBANK_PARSER_V3_AUTHORIZED=NO`: a third same-family purchase would not prove
the missing runtime DEBIT semantic, so `THIRD_TBANK_PURCHASE_REQUIRED=NO`.

## Direct Yandex Pay ordinary-purchase validation baseline

The direct Yandex Pay/Yandex Bank path with
`sourcePackage=com.yandex.bank` is distinct from the Yandex Pro alias
`sourcePackage=ru.yandex.taximeter`. A read-only audit found an existing
direct-package production E2E lifecycle: primary observation `454` /
transaction `355`, with companion observations `453` / `354` and `455` / `356`.
The primary persisted as `PURCHASE / DEBIT / READY / EXACT` through
`yandex-bank-normalizer-v1`, with the exact reviewed `Покупка на <decimal>
RUB ...` family, direct package, channel `notification_channel_1`, and event
time. Historical or Pro observations are not counted as direct Yandex Pay
samples.

At the fresh read-only baseline, backend health was `PASS`; the authorized
device `R5GL30GK60F` had a live notification listener, direct Yandex package
capture was available, notification AppOps were permitted, collector
configuration and credential markers were preserved, diagnostics were visible,
and the outbox had zero pending events. The baseline global totals were 379
observations (maximum id 503) and 379 transactions (maximum id 380) before
the later unrelated ingestion rows; latest direct Yandex Pay and Yandex Pro
ids were read without exposing payloads.

`EXISTING_DIRECT_YANDEX_PAY_PURCHASE_E2E=YES` and
`NEW_YANDEX_PAY_PURCHASE_REQUIRED=NO`. No new Yandex Pay operation is
authorized by this closeout. No parser, deployment, configuration, database,
account-resolution,
replay, backfill, accounting, business-event, or ledger change was made.

## Yandex Pro ordinary-purchase validation closeout

The existing Yandex Pro production lifecycle is proven: primary observation
`390` / transaction `314` arrived with physical `sourcePackage=ru.yandex.taximeter`,
canonical provider `com.yandex.bank`, and
`notificationChannel=notification_channel_1`. Event time and the reviewed
purchase grammar were present, and persisted semantics were
`PURCHASE / DEBIT / READY / EXACT`. Provenance passed; account resolution
remains `UNKNOWN`. Observations `389` and `391` are separate incoming events,
not companions of the primary.

`EXISTING_YANDEX_PRO_PURCHASE_E2E=YES` and
`NEW_YANDEX_PRO_PURCHASE_REQUIRED=NO`. No new Yandex Pro operation is
authorized by this closeout. No parser, deployment, configuration, database,
account-resolution, replay, backfill, accounting, business-event, or ledger
change was made.

## Controlled purchase campaign closeout

The provider campaign status is: Sber `CLOSED_PROVEN`; Alfa
`CLOSED_EVIDENCE_LIMIT`; T-Bank `CLOSED_INSUFFICIENT_DEBIT_EVIDENCE`;
Yandex Pay `CLOSED_PROVEN`; Yandex Pro `CLOSED_PROVEN`; VTB
`SKIPPED_PAID_NOTIFICATION_POLICY`; and Ozon
`SKIPPED_PAID_NOTIFICATION_POLICY`.

`CONTROLLED_PURCHASE_CAMPAIGN=CLOSED` and
`FURTHER_CONTROLLED_PURCHASES_REQUIRED=NO`. No additional controlled
purchase is needed for this campaign. Future natural provider events remain
opportunistic and do not authorize manufacturing operations.

## Sber purchase normalizer v6 production rollout

PR #81 was squash-merged into exact master
`8e18a9d65c933045820b0771afbcdd1c28546956`; master CI run
`37227747635` passed `test` with the PostgreSQL integration gate and full
suite, `android`, and `android-signed`.

The backend was promoted from the immutable `326`-file manifest artifact with
archive SHA-256
`abac4c17ce93e27aa340b4e9ce629794b38d67b6b3a5df86c7b94388de7114b5`.
Remote extraction, manifest hashes, atomic promotion, active release path,
and service health all passed. The deployed runtime imports
`sber-bank-normalizer-v6`. Schema migration `017` remained current; no
migration, grant, credential, configuration, replay, backfill, or bank-row
rewrite was performed.

The sanitized v6 in-memory smoke returned
`PURCHASE / DEBIT / READY / EXACT`; insufficient-funds and transfer-shaped
near-misses remained fail-closed. Production bank counts were unchanged by
the deploy: `330` observations with max id `415` and `330` transactions with
max id `331`. The latest Sber observation/transaction at baseline was
`415/331`.

The exact signed collector artifact from master CI run `37227747635` was
installed in place on `R5GL30GK60F`. Artifact id `11313270332` produced APK
SHA-256
`95de6007e136d5cb52a005c8588c2701d774e5036256244d74648ec938a945ac`;
the CI signing verification reported certificate SHA-256
`cb619643bbfb6b9235c85c560ba26967d2ca0f28db01fb6a7b9b3d6be484486a`.
Application data, source/server settings, allowlist, credential state, and
notification-listener access were preserved. The package started without a
crash; the outbox baseline is `0` pending events and capture diagnostics are
available. The APK was installed in place with `adb install -r`; the earlier
`ANDROID_CHANGED=NO` rollout summary field was erroneous and does not describe
this verified in-place update.

`PROVENANCE_CAPTURE_READY=YES`. The fresh correlation baseline was recorded
at `2026-10-04T22:43:36+03:00`: total/max observations `330/415`,
total/max transactions `330/331`, latest Sber `415/331`.

## Sber purchase normalizer v6 production E2E closeout

One ordinary user purchase produced one primary financial observation,
`420`, linked to transaction `334`, plus companion/non-ready observations
`416`, `418`, and `422`. These four rows represent one economic purchase, not
four purchases. Android collector/backend transport passed, and the primary
persisted as `sber-bank-normalizer-v6`, `PURCHASE`, `DEBIT`, `READY`,
`EXACT`, with currency `RUB`. The controlled amount correlation passed, but
the real amount is intentionally not retained in repository artifacts.

The purchase reference kind remains `NULL`/unknown. Account resolution remains
`UNKNOWN` with `financial_account_id=NULL`; no card/account identity
inference was performed. Historical observations through `415` were not
rewritten. Production totals after natural ingestion were `334` observations
and `334` transactions; these are totals, not maximum ids.

The persisted transaction was also checked only in memory through the merged
projection path:

- bank transaction -> `PROJECTED` cash-flow projection with
  `movementType=PURCHASE`;
- balanced journal projection -> `Dr UNCLASSIFIED_PURCHASE` and
  `Cr UNRESOLVED_BANK_ACCOUNT`.

The journal projection was read-only and in-memory. No ledger, business-event,
or reconciliation persistence occurred; no manual account resolution,
replay, or backfill occurred.

`SBER_V6_PURCHASE_E2E=PASS` and no additional Sber purchase is required
specifically for validation. The next operational validation is Alfa, using
one natural purchase only after a clean Android/backend baseline.

## Alfa natural purchase forensic closeout

The fresh Alfa transport E2E produced observations `437`, `438`, and `439`,
linked to transactions `341`, `342`, and `343`. These three notifications are
one economic purchase evidence window, not three purchases. Observation `437`
is the primary candidate: it carries the structured transaction-like monetary
position. Observation `438` is a separate structured update/companion variant
with a title monetary position and an additional body monetary structure after
a balance-like marker. Observation `439` is the empty companion. Each has its
own immutable source event identity; they are not independent economic
samples.

The current deployed `alfa-bank-normalizer-v4` did not recognize this purchase
family. All three persisted transactions remained generic
`bank-normalizer-v1`, `PARTIAL / UNKNOWN`, with no persisted amount, currency,
direction, or account identity. The transport path passed and ordinary
ingestion created immutable rows.

Privacy-safe forensic comparison found no exact historical match for this
purchase family among the production Alfa corpus. The user-confirmed amount
correlates with a body monetary position in the primary candidate and with the
title position of the structured companion, but this single window does not
establish a reusable grammar. The companion body also contains a
decimal/integer monetary structure and a balance-like marker; its role was not
independently proven as a balance or an additional transaction amount at this
stage.

No explicit purchase/payment lexical marker or directly proven `DEBIT` marker
was present in the reusable runtime structure. Merchant position and a masked
card/account reference position were not proven for this family. Android event
time is available as envelope evidence, but it does not resolve the monetary
or business semantics.

Therefore:

- `INDEPENDENT_MATCHING_PURCHASE_SAMPLES=0`;
- `ALFA_PURCHASE_GRAMMAR=SINGLE_SAMPLE_ONLY`;
- transaction amount position is not proven reusable;
- secondary balance position is not independently proven;
- no Alfa purchase parser change is authorized;
- current cash-flow and balanced-journal projections correctly produce no
  monetary candidate for transactions `341`, `342`, and `343`, because their
  persisted normalization is `PARTIAL / UNKNOWN`;
- no additional Alfa operation is required now unless future natural evidence
  is specifically needed.

`ORDINARY_PURCHASE_INGESTION=YES`; `MANUAL_PRODUCTION_MUTATION=NO`.
Historical rows were not rewritten; no account resolution, replay, backfill,
ledger, business-event, or reconciliation persistence occurred. The primary
development sequence remains bank cash flow -> business events -> proven
two-sided internal transfers -> ledger -> receipt matching.

## Alfa pairwise purchase forensic follow-up

The second independent ordinary Alfa purchase produced observations `456`,
`458`, and `460`, linked to transactions `357`, `358`, and `359`. It was a
second economic operation, not a replay or a new synthetic test operation.
The lifecycle topology matched the first window: `456/357` is the primary
structured notification, `458/358` is the structured update/companion, and
`460/359` is the empty companion. Each observation has a distinct immutable
source identity. Both windows used the same Alfa provider, Android adapter,
schema version, source package/channel shape, and description/text equality.

Across the two primary notifications, the same body/text structural family
contains two monetary positions: an integer-shaped position followed by a
decimal RUB position. The decimal position is the same ordinal position in
both samples and matches the respective operator-confirmed purchase amount;
therefore `TRANSACTION_AMOUNT_POSITION_PROVEN=YES` for this structural family.
The other primary monetary position changed independently, but has no explicit
balance or availability marker and remains `SECONDARY_MONETARY_FIELD`, not a
proven balance. In the two structured updates, the title integer position
matches the corresponding purchase amount, while a separate body decimal
position follows the explicit `остаток` marker. That update-side position is
balance-like, but it is not evidence that the primary secondary field has the
same role.

The primary family has no stable explicit purchase/payment lexical marker. Its
primary amount is not preceded by a sign; the ASCII hyphen-minus `U+002D`
appears immediately before the correlated amount only in the structured
update title. The same minus-before-amount convention is present in the
reviewed exact F5 outgoing-transfer family, while no independently proven
incoming or non-monetary Alfa counterexample uses it. This supports a narrow
DEBIT signal, but not PURCHASE. Controlled ground truth is `PURCHASE` and
`DEBIT`, and runtime promotion remains fail-closed:

- `REUSABLE_PURCHASE_MARKER_PROVEN=NO`;
- `REUSABLE_DEBIT_SEMANTICS_PROVEN=YES` only for the sign-bearing monetary
  update shape;
- `MERCHANT_POSITION_PROVEN=NO`;
- `REFERENCE_PRESENT=YES`, with `REFERENCE_KIND=UNKNOWN` and no ownership
  inference;
- `INDEPENDENT_MATCHING_PURCHASE_OPERATIONS=2` at the controlled-evidence
  level, but `ALFA_PURCHASE_GRAMMAR=INSUFFICIENT_EVIDENCE`.

The full Alfa sign audit found eight current exact F5 outgoing primary
observations with the minus convention, plus two historical F5-shaped rows
that are not current runtime evidence. No independently proven incoming or
non-monetary minus counterexample was found. A plus-shaped update exists, but
it is not independently proven incoming, so plus is not an incoming proof.

The canonical monetary lifecycle member for both controlled purchases is the
primary (`437/341` and `456/357`). The update members (`438/342` and
`458/358`) repeat the transaction-correlated title amount and also carry a
separate body field after `остаток`; the empty companions are `439/343` and
`460/359`. A later same-shaped Alfa lifecycle (`461/360`, `462/361`,
`464/362`) was observed outside the controlled window and is not counted as
another controlled purchase. Promoting every minus-bearing notification would
therefore create a duplicate monetary row for one economic operation.

Accordingly:

- `UNKNOWN_DEBIT_SEMANTICS_AUTHORIZED=YES` as a narrow semantic observation,
  not as permission to promote every notification;
- `CANONICAL_MONETARY_LIFECYCLE_MEMBER=PRIMARY`;
- `GENERIC_MINUS_PROMOTION_DOUBLE_COUNT_RISK=YES`;
- `F5_TRANSFER_PLUS_MINUS_COMPANION_DOUBLE_COUNT_RISK=NO` for the reviewed
  F5 corpus, whose companions are empty rather than a second monetary row;
- `SAFE_SINGLE_MONETARY_ROW_RULE_PROVEN=NO`;
- `ALFA_V5_AUTHORIZATION=DEBIT_PROVEN_BUT_LIFECYCLE_UNSAFE`;
- `PURCHASE_SEMANTICS_AUTHORIZED=NO`.

The required future implementation boundary is an explicit transaction-grain
lifecycle/dedup rule that selects one canonical primary and does not promote
the repeated update as a second monetary transaction. No parser, cash-flow,
journal, business-event, ledger, or reconciliation persistence was changed or
run for this forensic step.

The primary family is not an exact historical match; the update/companion
shape has a near historical envelope with a different sign form. The current
persisted projection remains fail-closed for transactions `357`, `358`, and
`359`: no cash-flow candidate and no balanced-journal candidate were
persisted. No Alfa parser change is authorized, no third purchase is required
solely for validation, and any future evidence must add a genuinely new
runtime marker or independent family rather than repeat this same topology.

## Alfa transaction-lifecycle correlation forensic

The available Android/backend lifecycle identity fields are the provider and
source package/channel metadata, event time derived from Android notification
post time, observed-at capture time, the immutable source-event identity, and
the per-observation structural/normalization facts. The Android capture
contract also has notification key, notification id, notification tag, title,
text, big text, subtext, and channel id before persistence. The backend keeps
one immutable observation and one bank transaction per source event. The
notification key/tag and raw payload are not available through the safe
semantic projection; channel is metadata and is not part of source-event-id
derivation.

The first controlled lifecycle was `437/341`, `438/342`, `439/343`; the
second was `456/357`, `458/358`, `460/359`. In each, the primary structured
notification preceded a structured update and then an empty companion. A
natural same-shaped lifecycle was also observed as `461/360`, `462/361`,
`464/362`; it matches the topology and structural member shapes, but is not
counted as a controlled purchase. Within the controlled triplets, provider,
source package, channel shape, adapter, schema version, and description/text
equivalence agree, while source-event identities and payload identities are
distinct.

The evidence supports a bounded lifecycle heuristic, not a deterministic
identity key. A safe prospective rule would require the same canonical
provider/source metadata, exact primary/update/empty structural families, an
ordered event-time topology, matching proven monetary evidence where present,
and fail closed whenever more than one candidate group remains. Time and
structural shape alone collide in the corpus: the update shape recurs in
`438`, `458`, and `462`, the empty shape has multiple historical members, and
amount/time proximity is not a unique economic-operation identity. The exact
Android notification key/tag needed for stronger identity is not available at
this layer. Therefore `ALFA_LIFECYCLE_CORRELATION=PROVEN_BOUNDED_HEURISTIC`,
with ambiguous groups retained rather than merged.

For lifecycle semantics, the primary is the canonical monetary member, the
structured update is direction evidence only, and the empty member is
non-monetary. One economic operation per group is a prospective rule only;
the existing immutable observations and bank transactions are not collapsed.
The recommended implementation boundary is a separate post-ingestion Alfa
lifecycle/canonicalization projection, not single-observation parser logic.
It must preserve all observations, select one primary only when the bounded
rule is unambiguous, and otherwise emit no canonical monetary result.

No Alfa implementation is authorized by this forensic result, and
`PURCHASE` semantics remain unproven. No prospective unknown-DEBIT cash-flow
or journal projection was run. A naive per-notification projection would
retain a duplicate-count risk; no production accounting output was created.
The result authorizes only further reviewed lifecycle-design work, not parser
promotion, persistence, replay, backfill, or accounting mutation.

## Alfa lifecycle canonicalization v1 closeout

PR #88 was squash-merged into exact master
`f4909f46e587f4f0ff5ee624ce853ab6abf2c020`. The implementation is a standalone
`alfa-lifecycle-canonicalization-v1` post-ingestion projection. It is
non-mutating: it does not rewrite historical `bank_transactions`, persist
cash-flow or journals, create business events, perform reconciliation, or
authorize production wiring.

The canonical lifecycle is transaction-grain and fail-closed:

- the primary is the sole monetary member;
- the structured update is `DEBIT` direction evidence only;
- the empty companion is non-monetary;
- an unambiguous reviewed lifecycle produces exactly one
  `UNKNOWN / DEBIT / READY / EXACT` canonical candidate;
- ambiguous or same-amount-overlapping lifecycles produce no canonical
  monetary candidate;
- `PURCHASE` and `INTERNAL_TRANSFER` are deliberately not inferred.

The exact F5 outgoing transfer remains exclusively owned by
`alfa-bank-normalizer-v4`; the lifecycle projection does not classify a title
amount alone as F5. No accounting scope is fabricated. Missing proven scope
fails closed, while an explicitly scoped in-memory UNKNOWN/DEBIT candidate may
produce `Dr UNCLASSIFIED_OUTGOING / Cr bank side` only when the normal
cash-flow/journal prerequisites are independently satisfied.

This closeout added no DB migration, production wiring, production mutation,
replay, backfill, or deployment.

## Alfa primary purchase-grammar discrimination forensic

Read-only inspection of the immutable primary observations `437` and `456`
found the same privacy-safe structure. The title has two dynamic word slots
joined by an ASCII hyphen-minus and contains no title amount. Description and
text are present and equal. Each is one non-semicolon-delimited body with the
same ordered skeleton: four dynamic word slots, a colon, an integer-shaped
position followed by a period, one dynamic word slot, a decimal-dot numeric
position, and three trailing dynamic word slots. The second numeric position
is the controlled transaction-amount position; the body carries a RUB marker.
No masked reference position was proven in the primary. Android provider,
`android-notification` adapter, schema version `1`, and non-null envelope
event time are required. The body has no `Перевод на` transfer anchor and no
`Получатель` field.

This primary grammar is structurally disjoint from the exact F5 transfer
grammar: it has one unsplit body rather than four ordered semicolon sections,
no F5 transfer/recipient anchors, no two F5 masked-reference positions, and
no F5 title amount form. The distinction is based on the complete grammar,
not merely on the absence of a recipient word.

The whole Alfa corpus contains three economic windows matching the exact
primary structural predicate: controlled windows `437/341` and `456/357`,
plus the natural same-shaped window `461/360`. The latter has no user-provided
purchase ground truth and is retained as an unknown-family collision rather
than silently classified as purchase. No exact primary transfer or incoming
collision was found, and no exact non-monetary collision was found. There are
no additional body-shape near matches under the exact predicate; other
historical, F5, informational, and companion families remain outside this
grammar and fail closed. Counts are economic windows, not notification rows.

The two controlled primaries prove the reusable amount position and RUB
currency position. They do not by themselves authorize PURCHASE for the
natural same-shaped unknown window. The narrow DEBIT signal remains carried
by the correlated minus-bearing update; because lifecycle identity is only a
bounded heuristic and not a deterministic key, it cannot safely promote an
arbitrary primary to DEBIT. Therefore the authorization decision is
`ALFA_PRIMARY_GRAMMAR_AUTHORIZATION=INSUFFICIENT`: primary-only promotion
would be single-row-safe for the two controlled windows, but a reusable
runtime semantic parser is not authorized. The update remains corroborating
direction evidence only, and the empty member remains non-monetary.

No lifecycle projection was implemented, no parser was changed, and no
prospective cash-flow or balanced-journal projection was run. A future
implementation must remain a separate post-ingestion, fail-closed
primary-only projection with explicit ambiguity handling; it must never
promote the update as a second monetary record. Future cash-withdrawal, fee,
or other non-proven families remain unsupported.

## Person 1 account-identity readiness audit

The read-only production audit completed against the exact master above. The
primary Android source has one unique accounting scope, and the account
identity foundation is healthy. The canonical coverage snapshot was internally
consistent: `311` bank transactions, `16` account-resolved, and `295`
unresolved. The `76` transactions without an account-resolution row are all
intentional pre-foundation legacy rows; there are zero post-foundation
resolution-row gaps. This is row-completeness history, not a runtime coverage
invariant failure.

Production currently has no `MASKED_CARD` bank transactions, so the zero
payment-instrument-resolution rows do not indicate a pipeline defect. Sber
account-reference resolution is production-proven, including the exact
`MASKED_ACCOUNT` path to financial account `1`. Sber v5 outgoing
`DEBIT`/account resolution is structurally ready, but its fresh production E2E
remains `PENDING_NATURAL_EVENT`.

`RECONCILIATION_DEVELOPMENT_READY=YES` and
`PRODUCTION_RECONCILIATION_E2E_READY=NO`. Full account coverage is not
required before reconciliation development, and no administrative account,
binding, or card-link mutation is required before development. Alfa, T-Bank,
Ozon, Yandex, and VTB identity work remains fail-closed and opportunistic.

The merged `bank-cash-flow-projection-v1` slice is a non-mutating projection
over normalized bank transactions. The next slice is a balanced journal
projection over those results. Every proven monetary operation must ultimately
map to one balanced two-sided journal entry with total debit equal to total
credit. The bank transaction supplies evidence for amount, currency,
occurred-at, direction, and an explicitly resolved bank account when present;
the journal projection must keep unresolved counter-sides bounded and
unclassified rather than inventing income, expense, counterparty, or
internal-transfer meaning. `UNKNOWN` business/event semantics do not make a
proven monetary movement disappear: when scope, amount, currency, occurred-at,
and `DEBIT`/`CREDIT` direction are all proven, the projection may and should
emit a balanced monetary pair with an `UNCLASSIFIED_*` counter-side.

The mapping is:

- `PURCHASE + DEBIT` may produce a purchase/payment candidate;
- `OUTGOING_TRANSFER + DEBIT` produces an outgoing-transfer candidate, not a
  purchase;
- `INCOMING_TRANSFER + CREDIT` produces an incoming-transfer candidate;
- `UNKNOWN` event semantics may still produce a monetary candidate when the
  movement evidence is complete and direction is proven.

For a proven `DEBIT`, the bank side is the journal credit and the other side
is `UNCLASSIFIED_OUTGOING` unless a more specific proven event mapping exists.
For a proven `CREDIT`, the bank side is the journal debit and the other side
is `UNCLASSIFIED_INCOMING`. These labels do not mean expense, purchase,
income, or salary. If `financialAccountId` is not explicitly proven, use only
an explicit unresolved side such as `UNRESOLVED_BANK_ACCOUNT`; this is not
account identity proof and must not be treated as a concrete financial
account.

If direction is `UNKNOWN`, or amount, currency, occurred-at, scope, or other
required evidence is missing or conflicting, no balanced monetary candidate is
created and the row remains unresolved.

Direction alone never determines business-event type, and source ownership
never proves payer or beneficiary. Account identity is used only when
explicitly resolved. `INTERNAL_TRANSFER` requires independently proven
evidence on both sides and proven own-account identities.

A receipt is additional purchase evidence and detail, not a second money
movement. A bank-backed purchase may exist without a receipt; a later receipt
match must enrich the existing purchase/business event rather than post the
same amount again. Receipt-only and ambiguous matches remain independent
evidence states.

The proven mappings are `PURCHASE + DEBIT` -> `Dr UNCLASSIFIED_PURCHASE / Cr
bank side`, `OUTGOING_TRANSFER + DEBIT` -> `Dr UNCLASSIFIED_OUTGOING / Cr
bank side`, and `INCOMING_TRANSFER + CREDIT` -> `Dr bank side / Cr
UNCLASSIFIED_INCOMING`. Direction alone never infers purchase, income,
`INTERNAL_TRANSFER`, counterparty, or any other business meaning.

The balanced journal projection is validation-only: it must not persist
business events, ledger entries, reconciliation decisions, or internal
transfers. No production E2E of this projection has been performed; runtime
wiring remains absent.

Do not post to the ledger or mutate production in this slice. Bank-to-receipt
candidate matching remains a later reconciliation slice, not the immediate
blocker for Person 1 MVP. When that later slice begins, it must keep bank and
receipt evidence independent, prefer READY/RECONCILED fiscal electronic-
payment evidence such as `ecash_total_sum`, and generate candidates rather
than accounting truth.

## Alfa normalizer v4 production deployment

PR #69 was squash-merged into exact master
`c27f1d56ddba55b22c797ffcfc8b0e7e6741883e`. Master CI run
`37195827483` passed `test` with the PostgreSQL integration gate, `android`,
and `android-signed`.

The backend was promoted from a 316-file immutable artifact with archive
SHA-256
`a6a06f5a5f2fa19275ab5254b52e03ff19cf2f2bde6d8bba605e412f3662fa46`.
The pre-deploy rollback backup, remote artifact integrity check, atomic
promotion, installed manifest/hash verification, and service health all
passed. Schema migration 017 was already current; no migration, grant,
credential, Android, replay, or backfill operation was performed.

The deployed runtime imports `alfa-bank-normalizer-v4`. A non-mutating smoke
test against a sanitized F5 fixture returned
`OUTGOING_TRANSFER / DEBIT / READY / EXACT`; a representative near-miss
remained fail-closed. The historical controlled Alfa observation `353` /
transaction `281` remains its original `alfa-bank-normalizer-v3`
`PARTIAL / UNKNOWN` projection and was not replayed or backfilled. Production
bank counts and max ids were unchanged across deployment (`307/307`, max
observation `384`, max transaction `308`).

The exact F5 v4 semantics preserve `accountReferenceKind=NULL`; no account,
card, or ownership inference was added. A fresh post-deployment Alfa v4 E2E
remains `PENDING_NATURAL_EVENT`. Sber v5 fresh E2E and VTB transport remain
opportunistic and do not block development. At that deployment stage, the next
parser candidate was a separate narrow reviewed slice; the current primary path
is now Person 1 account identity readiness.

## Source/provider account binding production rollout

PR #64 is merged in exact master
`2a91dd065d31000b84ea753a29ef708251b87866`; master CI #222
(`37041466349`) passed `test`, `android`, and `android-signed`.

Production rollout completed from a 311-file immutable artifact with archive
SHA-256 `670b3c153ce86a650e10df1a9b7a15e23b36984257d26cbf748ace28971f50be`.
Pre-deploy backup, atomic promotion, installed manifest/hash verification,
service health, and timer health all passed. Migration
`017_bank_source_provider_account_bindings.sql` is current.

The binding table exists and intentionally contains zero rows. The runtime role
has only the reviewed column-level SELECT needed for binding lookup and cannot
INSERT/UPDATE/DELETE bindings. No real binding, financial account, historical
replay/backfill, new bank operation, Android change, credential change, existing
bank-row rewrite, or account-resolution rewrite occurred.

The primary Android source key is `android-adam-samsung-s938b`. Production
currently inventories three financial accounts, and no Yandex financial account
exists yet; therefore no Yandex source/provider/account binding can be created
without a separate explicit account-provisioning decision.

External HTTPS from the rollout operator path was not confirmed in the final
report, while local backend `/healthz` returned 200 and the service and timer
were active. Treat that as an access-path observation, not evidence that the
backend rollout failed.

Provider-reported balance snapshots/reconciliation are not an active project
stage. Bank cash-flow accounting should continue from observed transactions and
explicit account identity evidence; do not infer missing transactions from
balance differences.

## Android source provenance production rollout

Master CI #200 (`36924491330`) passed. The backend exact master
`e83bacb3206de1b3f8ee153929aec12c783ea486` is deployed from a 309-file
immutable artifact with archive SHA-256
`0fb94c620e76049d0626416a642ec4e65f84675ad1b56e3555c2885116d6936d`.
Manifest and installed hashes match, and service health passed. No database
migration, historical replay, backfill, grant, credential, or bank-row change
was performed by the deploy.

During rollout diagnosis, a temporary production-access failure was isolated to
the network route rather than the application release: access recovered after
changing the `happ-xray` route, with HTTPS `/healthz` returning 200 and SSH
completing successfully. One soft reboot had been performed before the route
issue was isolated; no hard reboot was performed. The full recovery gate passed
before this deployment.

The master-signed collector artifact `11193376632` was verified by the CI
certificate gate and installed in place on `R5GL30GK60F`. The expected APK
SHA-256 is
`7e731822ccea40879dbdfb1ddf5ff88e627379e104272a4ca93ca6f3556fd4f1` and the
stable signing certificate SHA-256 is
`cb619643bbfb6b9235c85c560ba26967d2ca0f28db01fb6a7b9b3d6be484486a`.
Application data, source/server settings, credential state, allowlist,
and notification-listener access were preserved. The application started
after the update, and the fresh diagnostic window showed no AndroidRuntime
crash or permanent-rejection burst.

The transport contract remains canonical provider `com.yandex.bank`, with
`sourcePackage` always sent and `notificationChannel` sent only when the
actual channel is non-blank. Existing observations 266-270 retain no
retroactive source-app attribution. Fresh production observation `309` /
transaction `251` then proved the new transport provenance end to end:
`sourcePackage=ru.yandex.taximeter` and
`notificationChannel=notification_channel_1` were persisted, while the
transaction remained linked to observation `309` and normalized through
`yandex-bank-normalizer-v1` as `READY / INCOMING_TRANSFER / CREDIT`. The real
transaction amount and notification content are intentionally not retained in
this handoff. Android source provenance is therefore closed and production-proven.

## Yandex Pro StrongUnknown rollout

PR #61 is merged in exact master
`9427d8a89973d0fcbc86cdd2e43f9e2125a0e9ce`; master CI #208
(`37018385335`) passed `test`, `android`, and `android-signed`.
The backend was not changed or redeployed, and no database migration was
performed.

Signed artifact `11232201233` was installed in place on `R5GL30GK60F`. Its
APK SHA-256 is
`8d516fa76f38ea692a9e0898609a8dfaa9732511c7f032f554bee6736ed82890`, and
the stable signing certificate matched
`cb619643bbfb6b9235c85c560ba26967d2ca0f28db01fb6a7b9b3d6be484486a`.
Application data, source/server settings, allowlist, credential state,
notification-listener access, and outbox health were preserved/verified after
the in-place update.

The classifier now captures `StrongUnknown` only for an exact proven Yandex
Pro financial anchor when the supported grammar is incomplete or unsupported.
`Financial` and `StrongUnknown` use the existing immutable capture/outbox path;
ordinary `Unknown` and `NonFinancial` remain locally dropped. StrongUnknown
does not prove event type, direction, amount, currency, or ownership, and the
backend remains fail-closed. No StrongUnknown event has yet been observed in
production. No new bank operation was performed for this rollout.

## Alfa F5 v3 partial normalizer (historical)

At that historical stage, the read-only Alfa corpus review covered 23 observations across four
forensic top-level families: integer-title F5, decimal-title F5,
empty/companion, and other historical envelopes. The earlier exact structural
classification retained 11 historical subfamilies; this is a separate metric,
not the current forensic family count. Seven F5 primaries share one real-derived
four-section body skeleton,
with integer and comma-decimal(two digits) title variants. The then-active v3 staged
path requires title/body amount equality, title-case transfer/recipient anchors,
both proven masked-reference positions, uppercase `RUB`, and Android envelope
event time. It preserves `eventType=UNKNOWN`, `direction=UNKNOWN`, and unknown
reference kind; no ownership or card/account inference is performed. Unmatched
Alfa families and companions remain on generic normalization. Observation 260
failed closed under v2 without semantic corruption because the old synthetic
body grammar used lowercase anchors; v3 corrects only that evidence-backed
grammar. No additional research transfer or fresh Alfa E2E was required at that
stage; the historical v3 partial-parser stage was closed after its production
E2E.

## Alfa F5 v3 production E2E closeout

Master CI run `36907264462` passed for master
`58e2610406425aa7faf84080cf2ee77583b867c4`. The immutable production
artifact contains 309 files and has archive SHA-256
`f45269892ea3e536881b72023e8739f8995adef772d48f8b3212b43f9ce3591f`.
The release manifest and installed file hashes matched, and the bank-ingestion
service remained healthy.

The fresh Alfa primary was observation `263` / transaction `213`; no separate
companion was observed. It matched the exact staged four-section v3 envelope:
title/body amount equality, RUB, Android event time, both reference segments,
and a masked reference were present. The controlled amount matched without
retaining the real amount in this handoff. The persisted result is
`normalizationStatus=PARTIAL`, `evidenceQuality=PARTIAL`,
`eventType=UNKNOWN`, `direction=UNKNOWN`, and `accountReferenceKind=NULL`.
Account resolution remains `UNKNOWN` with no financial account id, and no
payment-instrument or account/card identity inference was performed.

No historical rows were replayed or backfilled, and no accounting or identity
side effects were created. Alfa F5 is closed. At that historical stage, the
next provider stage was Yandex transfer/top-up forensic; card-purchase evidence
was deferred until a real purchase occurred naturally.

## T-Bank v1 top-up partial parser evidence (historical)

The T-Bank forensic corpus covered 51 historical observations across 22 exact
structural families. Two independent controlled top-up observations, `214` and
`217`, share one body family; `218` is a separate empty companion. The title is
absent in one sample and present in the other, so it is not required by the
parser. The exact proven body boundary is:

`Пополнение на <integer> ₽, счет RUB. <dynamic words> Доступно <comma-decimal> ₽`

The first integer-RUB position is proven transaction amount, the second
comma-decimal position after `Доступно` is a separate balance/availability
value and is ignored, and Android envelope `eventTime` is used for occurredAt.
The narrow `tbank-bank-normalizer-v1` was authorized only as `PARTIAL`; it
preserved `eventType=UNKNOWN`, `direction=UNKNOWN`, and null account/card
references. At that stage, no READY parser or ownership inference was
authorized. No further controlled top-up sample was required.

## T-Bank v1 top-up partial normalizer production E2E (historical)

The exact master `8e56566717e346fb56371ddcb9216de68777bade` was promoted
through the immutable runtime procedure after a dependency-closure install.
The service is healthy, schema 016 remains current, and the pre-E2E baseline
was observation `218` / transaction `172`.

One fresh Alfa-to-T-Bank notification arrived after that baseline as
observation `221` / transaction `175`. It was the primary T-Bank top-up
notification; no companion was observed. The deployed
`tbank-bank-normalizer-v1` extracted the proven integer RUB transaction amount
and Android post-time, returning `PARTIAL` with `eventType=UNKNOWN` and
`direction=UNKNOWN`. The amount matched the user-confirmed operation, but the
real amount is intentionally not retained in repository artifacts.

The persisted event remained fail-closed for account identity: no account or
card reference was inferred and account resolution stayed `UNKNOWN` with
`OBSERVED_PROVIDER_REFERENCE_UNRESOLVED` provenance. Historical rows were not
changed, and no replay, backfill, ledger, business event, or internal transfer
was created. This closes the T-Bank top-up partial-parser E2E; at that
historical stage, the next provider target was Alfa.

At that historical stage, Ozon research was deferred because additional paid
notification experiments were not desirable; its parser remained unauthorized.
At that historical stage, the next operational step was incremental Alfa
provider evidence, beginning with read-only corpus forensic. Ozon remains on
the current deferred list and its runtime path remains generic/fail-closed.
A separate real T-Bank card-purchase sample can be investigated later when it
naturally occurs.

## T-Bank normalizer v2 production deployment

PR #71 was squash-merged into exact master
`80b5c6aa405700e890d85dbbd363ee13badfc3c1`. Master CI run
`37198710190` passed `test` with the PostgreSQL integration gate, `android`,
and `android-signed`.

The backend was promoted from a 317-file immutable artifact with archive
SHA-256
`f20dc43c59343d0d3e2e43194d11a43af49754da397912dd914b36fbd6bf693c`.
The pre-deploy rollback backup, staged artifact integrity, atomic promotion,
installed manifest/hash verification, and service health all passed. The
runtime unit now executes the exact `80b5...` release. Schema migration 017
remains current; no migration, grant, credential, Android, replay, or
backfill operation was performed.

The deployed non-mutating runtime smoke returned
`UNKNOWN / CREDIT / READY / EXACT` with `RUB`, no account reference, and no
account-reference kind for the exact sanitized top-up envelope. A
representative near-miss remained `UNKNOWN / PARTIAL` with no extracted amount.
Production bank counts and max ids were unchanged across deployment
(`307/307`, max observation `384`, max transaction `308`).

Historical T-Bank observation `335` / transaction `269` and production E2E
observation `221` / transaction `175` retain their original
`tbank-bank-normalizer-v1`, `PARTIAL`, `UNKNOWN` event type, and `UNKNOWN`
direction projections. They were not replayed or backfilled. No account/card
identity inference was added. A fresh post-deployment T-Bank v2 E2E remains
`PENDING_NATURAL_EVENT`; no new bank operation should be created solely for
validation.

## T-Bank outgoing controlled-window forensic closeout

After a clean read-only baseline, one user-controlled T-Bank-to-own-Sber
operation produced T-Bank observation `471` / transaction `366`. Its
privacy-safe structural shape has title, description, and text; description
and text are equal; the body contains transfer-like and availability/balance-
like markers plus account/card-like context; and an Android `eventTime`,
source-package, channel, adapter, and schema envelope are present. No
transaction monetary position was present in the reusable shape, no
reference kind was proven, and no explicit outgoing/debit marker was present.
The persisted result therefore remained `PARTIAL / UNKNOWN / UNKNOWN` with
unknown account resolution.

The same operation produced Sber observation `473` / transaction `367` as
the opposite-side incoming event, with empty/non-ready companion observation
`477` / transaction `368`. Sber persisted `READY / INCOMING_TRANSFER / CREDIT
/ EXACT` against the already proven financial account. This is a controlled
cross-bank correlation, not independent two-sided monetary evidence: Sber has
exact monetary evidence, while T-Bank has insufficient monetary evidence.
The T-Bank structural shape therefore does not become reusable outgoing
grammar or prove an `INTERNAL_TRANSFER`. T-Bank observation `469` /
transaction `365` is a
separate earlier top-up-like event: its event-time ordering and incompatible
shape do not prove lifecycle membership.

Applying the privacy-safe `471` structural predicate to the complete current
T-Bank corpus found `23` exact non-monetary structural matches, including
`471`; none was a proven top-up or purchase collision, and `16` additional
near matches remained structurally non-identical. The corpus therefore does
not authorize a T-Bank outgoing parser. A second same-family controlled
transfer would not add the missing transaction amount or explicit direction
marker, so no additional T-Bank operation is required solely for this gap.
`INTERNAL_TRANSFER` remains unauthorized because T-Bank monetary facts are
incomplete (amount, currency, and reusable direction are not proven) and the
T-Bank financial-account identity is unresolved.
`CONTROLLED_CROSS_BANK_CORRELATION=PASS`;
`SBER_INCOMING_MONETARY_EVIDENCE=EXACT`;
`TBANK_OUTGOING_MONETARY_EVIDENCE=INSUFFICIENT`;
`INDEPENDENT_TWO_SIDED_MONETARY_EVIDENCE=NO`.

No parser, schema, account-resolution, accounting, replay, backfill, or
production configuration change was made.

## Bank Assistant semantic layer activated

PR #48 is merged in master `423f978d0783811463d36fd8fcda84019248822d`;
master CI #171 (`36752374713`) passed. The approved semantic SQL was deployed
from that exact master with no migration, grant expansion, or bank-row rewrite.
The `chatgpt_reader` role can select the semantic views while raw bank tables
and writes remain blocked. BlazeSQL selection was refreshed to all 30
`chatgpt_accounting` views, and the assistant read-path smoke test passed.

A fresh real Sber incoming operation was visible through the assistant path as
`READY / INCOMING_TRANSFER / CREDIT / EXACT` for Person 1's proven account
evidence. The Bank Assistant is therefore usable for Person 1 proven incoming
transfers. `READY_TO_ASK_CHATGPT_ABOUT_TRANSFERS=YES`.

The active functional cycle remains Person 1 multi-bank operation coverage.
Sber now has two distinct production-proven normalization paths: the exact
incoming family remains `READY / INCOMING_TRANSFER / CREDIT / EXACT`, while
the outgoing-shaped v4 family preserves only the proven amount, `RUB`,
payment-account reference, and Android event time as `PARTIAL`. Its
`eventType` and `direction` intentionally remain `UNKNOWN`.

The earlier outgoing corpus review and controlled-sample campaign are closed
research stages. They established the v4 grammar and account-reference
stability; do not restart them or collect another amount-only Sber sample.
Any future Sber `DEBIT` classification requires an independent structural
marker or evidence source rather than the fact that a controlled user action
was known to be outgoing.

## Sber normalizer v4 production deployment and Person 1 outgoing E2E

PR #50 was squash-merged into exact master
`25ecffb0d794bd9856a1355c8cadda9d1fa32240`. Master CI run
`36852085746` passed all jobs, including `test`, `android`, and
`android-signed`.

The backend runtime was promoted from that exact master using an immutable
304-file artifact with archive SHA-256
`11ef406534774f4e16cfb61dff8fcb01d383cffaff39e9c0b6d89deb4607ca5f`.
Artifact integrity, pre-deploy backup, atomic promotion, installed manifest,
installed hashes, service health, and active release identity all passed.
No DB migration, analytics SQL, grant, credential, Android, historical replay,
or backfill operation was performed as part of deployment.

A fresh Person 1 Sber outgoing-shaped production E2E was then performed after
the pre-E2E baseline observation `204` / transaction `158`. Ordinary
ingestion created observations `206-209` and transactions `160-163`:

- primary observations `207` and `208` normalized with
  `sber-bank-normalizer-v4` as `PARTIAL` / `PARTIAL`;
- both primary projections extracted the user-confirmed transaction amount and
  `RUB`; the exact real amount is intentionally not retained in repository
  artifacts;
- both primary projections resolved to `financial_account_id=1` with
  account-resolution state `EXACT`;
- both primary projections preserved `eventType=UNKNOWN` and
  `direction=UNKNOWN`, proving that v4 does not invent outgoing/debit
  semantics;
- companion observations `206` and `209` remained separate
  `PARTIAL`/unknown evidence with no transaction amount or account
  resolution.

This closes the Sber v4 amount/currency/account-reference production E2E.
No further controlled amount sample is required. Sber `DEBIT` remains a
separate unresolved evidence question and requires an independent structural
marker or evidence source before classification.

## Sber normalizer v4 partial outgoing evidence

The outgoing evidence research is complete for the narrow partial envelope.
Controlled primary samples are observations `193/195`, `201`, and `204`; the
reference-only companions are `194/196`, `202`, and `203`. The third controlled
sample used a unique integer RUB amount. It matched the integer monetary
position, not the independent comma-decimal balance position; the exact real
amount is intentionally not retained in repository artifacts.

The v4 parser may preserve only these proven facts for the exact provider,
adapter, schema, title/body structure: integer transaction amount, `RUB`, the
stable payment-account `MASKED_ACCOUNT ••0271` position, and event time from
Android `postTime`. It must return `PARTIAL` with `eventType=UNKNOWN` and
`direction=UNKNOWN`. No `DEBIT`, outgoing event type, purchase, internal
transfer, business event, ledger posting, historical replay, or backfill is
allowed. The parser is now deployed and production-validated under exactly
those partial semantics.

## Sber normalizer v5 production deployment

PR #67 was merged into exact master
`12f9800bf56866591a2d81958137d0830c6725eb`. Master CI run
`37113055784` passed `test` with the PostgreSQL integration gate, `android`,
and `android-signed`.

The backend was promoted from a 315-file immutable artifact with archive
SHA-256
`a84b5a070124c676d3cfa7708c457d15bb52afabeb92b1a06ba9ac215dccbceb`.
Remote artifact verification, pre-deploy rollback backup, atomic systemd
promotion, installed manifest/hash verification, and `/healthz` service
health all passed. Schema migration `017` was already current; no migration,
grant, credential, Android, historical replay, or backfill operation was
performed.

The deployed runtime imports `sber-bank-normalizer-v5`. A non-mutating smoke
test against the sanitized v5 fixture returned
`OUTGOING_TRANSFER / DEBIT / READY / EXACT`. The fresh controlled evidence
remains primary observation `357` with reference-only companion `359`; both
were captured before this deployment and remain immutable historical v4 rows.
No fresh post-deploy Sber v5 production E2E has been claimed; it remains
`PENDING_NATURAL_EVENT`. No new bank operation was performed for this rollout.

Android was not updated because PR #67 changes backend normalization only.
The existing collector configuration, listener access, allowlist, and
credentials were not touched.

## Sber card-purchase evidence closeout

PR #79 was subsequently squash-merged into master as
`1d98a6fa3d307ead0cee2466c7725984f7d7d304`; its balanced bank journal
projection remains non-mutating and validation-only.

One natural Person 1 Sber purchase transport/backend E2E was captured after
the prior cutoff. Observations `409`, `411`, `413`, `414`, and `415` with
transactions `327`, `328`, `329`, `330`, and `331` are five immutable
notifications from one capture window, not five purchases. The successful
purchase primary is observation `413` / transaction `329`; observation `415`
is its reference-only companion. Observation `409` is a separate
insufficient-funds purchase-shaped notification with reference-only
observation `411`, while `414` is a separate transfer-shaped notification and
is not purchase evidence.

The current `sber-bank-normalizer-v5` correctly failed closed for this family:
all five persisted rows remain `PARTIAL / UNKNOWN`, with no persisted amount,
currency, direction, or account resolution. Transport provenance was
persisted for the canonical Sber provider and Android notification channel;
no payload or sensitive notification values are retained here.

The purchase family is reusable across three independent economic samples,
including two historical duplicate-looking primary pairs and the fresh
primary. Its privacy-safe grammar is an exact title envelope
`Покупка <MERCHANT>` plus a description/text pair with the same structure:
`<integer> RUB marker — Баланс: <decimal RUB marker> ... masked-reference
suffix position`. The first monetary position correlates with the controlled
transaction amount; the second position follows the stable balance marker and
is a separate balance value. Description and text are equivalent when both
are present. The insufficient-funds title is a fail-closed near-miss and must
not become a purchase debit.

The repeated purchase marker proves the purchase family and supports a
future narrow `PURCHASE / DEBIT` parser contract for this exact envelope;
there is no separate lexical debit word or sign requirement in the proven
body. The masked suffix is present, but its reference kind is not proven and
must remain `UNKNOWN`; no account/card identity inference is authorized.
The next parser slice may extract only the proven integer transaction amount,
RUB, Android event time, and the exact purchase marker/merchant slot if its
privacy and grammar contract remains bounded. It must reject status-prefixed
titles, reordered or missing body sections, unequal description/text values,
ambiguous monetary positions, unsupported currency/number forms, and
unproven reference kinds. No parser implementation was made in this forensic
step.

## Controlled multi-bank evidence reviewed on 2026-10-03

This section records sanitized evidence only. Persisted rows remain immutable;
the observations below were not replayed or backfilled.

- **Sber:** observation `344` / transaction `276` is persisted as
  `READY / INCOMING_TRANSFER / CREDIT`. The controlled outgoing primary is
  observation `357` / transaction `285`, with reference-only companion `359` /
  transaction `286`. These predate v5 deployment and remain historical v4
  rows. The exact outgoing envelope is now classified by v5 as
  `OUTGOING_TRANSFER / DEBIT / READY / EXACT`; fresh post-deploy E2E remains
  `PENDING_NATURAL_EVENT`.
- **T-Bank:** observation `335` / transaction `269` remains historical
  persisted v1 data with `PARTIAL / UNKNOWN / UNKNOWN` semantics. Its
  controlled evidence authorized the later current v2 semantic promotion;
  current exact top-up runtime semantics are
  `UNKNOWN / CREDIT / READY / EXACT`. Observation `350` / transaction `280`
  is fresh outgoing-looking evidence with inconsistent controlled-amount
  correlation; therefore `TBANK_OUTGOING_DEBIT_PROVEN=NO`.
- **Ozon:** observation `339` / transaction `273` is the controlled primary;
  observation `341` / transaction `274` is its separate empty companion, and
  both share the controlled capture time. The persisted primary remains
  `PARTIAL / UNKNOWN / UNKNOWN`. Controlled evidence proves `CREDIT` for
  observation `339`, and its explicit lexical markers support
  `INCOMING_TRANSFER` for that observation, but the reusable exact grammar is
  not proven and the primary does not match the historical Ozon v1 fixture
  family. No v2 sanitized fixture or runtime parser was authorized, and no
  fresh outgoing primary was correlated, so `OZON_OUTGOING_DEBIT_PROVEN=NO`.
- **Alfa:** observation `353` / transaction `281` has exact F5 anchors and
  controlled ground truth supporting outgoing/DEBIT semantics. At that
  historical stage, the persisted/runtime Alfa v3 result remained
  `PARTIAL / UNKNOWN / UNKNOWN`; this was evidence for the later v4 revision,
  not a v3 runtime change.
- **Yandex Pro:** observation `343` / transaction `275` is
  `READY / INCOMING_TRANSFER / CREDIT`. No fresh Yandex Pro outgoing
  person-transfer notification or Pro-side notification for the controlled
  Pro-to-Pay action was captured, so no Yandex Pro outgoing support is
  claimed.
- **Yandex Pay:** destination-side observation `354` / transaction `282` and
  outgoing observation `355` / transaction `283` have physical source
  `com.yandex.bank` and channel `notification_channel_1`. Their persisted
  rows remain `PARTIAL / UNKNOWN / UNKNOWN`; controlled outgoing ground truth
  did not promote runtime semantics, and
  `YANDEX_INTERNAL_TRANSFER_EVIDENCE=NOT_PROVEN`.
- **VTB:** no fresh controlled evidence was captured;
  `VTB_FRESH_TRANSPORT_PROVEN=NO`. VTB remains opportunistic and must wait
  for a natural notification.

Each future parser slice remains independently review-gated. These evidence
summaries do not authorize automatic promotion of Alfa, T-Bank, Ozon, or
Yandex Pay runtime semantics.

## Yandex Pay outgoing forensic evidence

The controlled Yandex Pay outgoing primary is observation `355` /
transaction `283`; observation `356` is its empty companion. Both use the
canonical provider `com.yandex.bank`, physical source package
`com.yandex.bank`, and `notification_channel_1`. The notification supports
observation-level `OUTGOING_TRANSFER / DEBIT` through its explicit transfer
markers and controlled direction evidence. It has one transaction-amount
candidate and a separate secondary amount after an availability marker, but
the reusable exact grammar is not proven: the corpus contains only one exact
matching primary sample. `sourcePackage` is required for any future
Pay-specific dispatch because the canonical provider is shared with Yandex
Pro. Observation `354` is structurally distinct and does not establish an
internal-transfer pair.

No Yandex Pay parser or sanitized fixture is authorized. `YANDEX_INTERNAL_TRANSFER_EVIDENCE=NOT_PROVEN`.
Wait only for a naturally occurring matching sample; do not manufacture a
bank operation for this evidence. This validation is opportunistic and does
not block Person 1 account identity or reconciliation work.

## Sber normalizer v3 current-format evidence (historical)

The two newest controlled primary Sber incoming observations are `147` and
`154`; their separate reference-only companions are `149` and `152`. The two
primary samples share one privacy-safe structural family:

- title: `Перевод по СБП от <sender>.` with an exact final period;
- body: `+ <integer> ₽ — Баланс: <grouped comma-decimal balance> ₽ Плат. счёт ••<four digits>`;
- the first integer RUB token is the transaction amount;
- the grouped comma-decimal field is a separate balance and is ignored;
- the payment-account suffix is canonicalized as `MASKED_ACCOUNT`;
- event time remains the Android notification `postTime` carried as envelope
  `eventTime`.

At that historical stage, the active incoming parser revision was
`sber-bank-normalizer-v4`, scoped to provider `ru.sberbankmobile`, adapter
`android-notification`, and schema version `1`. The current active runtime is
`sber-bank-normalizer-v5`, which preserves the incoming exact semantics and
promotes the already-proven outgoing family to
`OUTGOING_TRANSFER / DEBIT / READY / EXACT`. Previous v1/v2 Sber envelopes
remain documented and preserved as immutable historical evidence. No
historical `bank_transactions` are rewritten and no backfill is permitted.

## Sber normalizer v3 production deployment and final Person 1 E2E

The v3 runtime was promoted from exact master
`bfdeea3e5cc62ff65c256725b25b5e1e33027856` using an immutable 269-file
runtime artifact with archive SHA-256
`360a98738450b09d8873db60000bc0c5f116a7e6a36d51fcbe8d0986457d3d97`.
The installed manifest and service path match the exact release. Schema
`016_runtime_identity_lookup_grants.sql` remained current; no migration,
grant, credential, or Android configuration change was performed.

The final fresh Person 1 ingestion passed without historical replay or
backfill:

- primary observation `161` and transaction `128` were `READY`,
  `INCOMING_TRANSFER`, `CREDIT`, RUB, and `sber-bank-normalizer-v3`;
- the proven payment-account evidence was `MASKED_ACCOUNT ••0271`;
- ingestion-time resolution was `EXACT` to `financial_account_id=1` with
  provenance `OBSERVED_PROVIDER_REFERENCE`;
- companion observation `164` and transaction `129` remained independent
  `PARTIAL`/`UNKNOWN` evidence and were not combined with the primary event.

Historical observations and transactions remained unchanged. No manual or
historical resolution, INTERNAL_TRANSFER, business event, ledger posting,
identity inventory change, grant change, or credential change was performed.
At that historical stage, the next phase was the Bank Assistant read-only
semantic layer for the usable MVP. Person 2/3 onboarding and
outgoing-transfer parser work remained out of scope at that time.

## Bank Assistant semantic-layer scope

The planned assistant surface is read-only and transaction-grain. The bank
transaction view exposes normalized event semantics and explicit account and
payment-instrument resolution states, while separate views expose aggregated
source-person capture context without treating it as account ownership. An
unresolved transaction remains visible as `UNKNOWN`; a card reference never
infers an account; raw notification/payload identifiers and credentials are
not exposed.

At that historical stage, the provider matrix was intentionally narrow: Sber
incoming/CREDIT v4 was the current proven bank envelope, Yandex remained
deployed, and T-Bank, Alfa, Ozon, and VTB required future incremental
evidence. The current provider evidence is summarized in the controlled
multi-bank section below. No semantic-layer deployment, backfill, ledger
posting, business event, internal-transfer matching, phone change, or
production mutation was part of that review.

## Sber final E2E fail-closed and corpus forensics

The final controlled Person 1 Sber E2E was intentionally retained
fail-closed. Observation `134` and its transaction projection were persisted
as `PARTIAL`/`UNKNOWN`; observation `135` was a separate reference-only or
summary event and was not combined with `134`. No manual resolution, backfill,
accounting event, identity change, or other state mutation was performed
beyond ordinary ingestion of the two notifications.

The read-only corpus scan covered 17 immutable Sber observations. Observation
`134` has the following privacy-safe structural fingerprint:

- title: one unproven literal envelope with one or more non-static segments;
  no proven incoming marker, exact fixed prefix, or exact fixed suffix can be
  safely isolated from this singleton;
- body: incoming marker, integer RUB-symbol amount, a separate grouped
  comma-decimal balance field, and the exact payment-account marker;
- account reference: the already established `MASKED_ACCOUNT` suffix `0271`;
- punctuation: the title contains a period code point, but that punctuation
  does not establish a semantic title boundary.

Observation `134` is a singleton structural cluster (`[134]`) with one
timestamp shape, one amount shape, one balance shape, and one title dynamic
value. Existing proven Sber incoming observations (`72`, `75`, `79`, and
`128`) do not establish the same title envelope. Therefore the current
evidence did not justify an exact v3 grammar at that time: a broad title
`contains` heuristic or a guessed balance rule would have risked a false
positive. This is retained as historical forensic context; the two later
controlled samples are documented in the historical v3 section above.

This remains historical forensic context. The later controlled v3 samples and
the final fresh-ingestion E2E establish the active current-format contract;
observation `134` remains correctly fail-closed and is not backfilled.

## Sber normalization v2 production deployment

The Sber v2 runtime was deployed from exact master
`ccefe24282bcba4e519e0f27feb7e29e33fd95f0` using the immutable 267-file
runtime artifact with archive SHA-256
`257ac8a1fda22c9abce54f63466ef4a41a1249a466b72c0d6cfa8cc5f38b9dac`.
The installed release manifest matches the staged artifact and the active
systemd service runs from the exact release. Schema `016_runtime_identity_lookup_grants.sql`
remained current; no migration, grant, credential, or configuration change was
performed.

Read-only in-memory replay through the deployed code passed for observation
`128`: `READY`, `INCOMING_TRANSFER`, `CREDIT`, RUB, amount present, and
`sber-bank-normalizer-v2`. Observation `129` remained `PARTIAL`/`UNKNOWN`
without a reference and was not promoted. Historical observations `72`, `75`,
and `79`, transaction projections `101`/`102`, Person 1 identity/reference
inventory, and resolution rows were unchanged. No backfill, replay persistence,
ledger posting, business event, or internal-transfer matching was performed.

At that earlier stage, the next step was review and controlled deployment of
the v3 current-format parser. T-Bank and Ozon parser coverage were future
incremental work, while Alfa and VTB were deferred. No historical v1/v2 row
was backfilled.

## Sber normalizer v2 historical evidence slice

The controlled Person 1 E2E produced observation 128 with provider
`ru.sberbankmobile`, a valid Android post time, and a body matching the proven
incoming-transfer contract including the Person 1 account reference. The
controlled Sber evidence set is four incoming observations in total: three
historical/proven v1 samples plus observation 128 as the separate v2 checkmark
sample. Deployed Sber v1 rejected observation 128 only because its title used
the newly proven exact envelope `✅ Поступление от <sender>`. Observation 129
was separate reference-only/summary evidence with no title/body and remains
unsupported.

The feature branch for Sber normalizer v2 added only that exact checkmark title
envelope. Those v1/v2 formats remain immutable historical evidence and were no
longer active under the then-current v3 contract. No historical backfill was
performed.

## Automatic identity resolution production deployment

PR #41 is merged in master commit
`04e5dc3edcf9846a78e04216e9926244538e3105`. The immutable production runtime
artifact was built from that exact commit with archive SHA-256
`207330b8d1b2d4a7b2d500ea8d42e4072e43ba47b9c452e15b7895dee212b317`.

Production validation completed successfully:

- the release manifest matched the staged and installed runtime files;
- `finance-bank-ingestion.service` runs from the exact release and `/healthz`
  returns HTTP 200;
- migration `016_runtime_identity_lookup_grants.sql` was applied through
  `scripts/migrate-prod-only.mjs` using the administrative PostgreSQL peer path;
- the FNS timer remains `enabled/active`, while the sync service is inactive;
- observations and bank transactions remain `98/98` after deployment;
- account-resolution rows remain `22` (`RECONCILED=3`, `UNKNOWN=19`), with
  logical coverage `98 total / 3 resolved / 95 unresolved` and invariant PASS;
- payment-instrument resolution rows remain `0` and historical observations
  `72/75/79` remain reconciled by historical replay provenance;
- runtime identity lookup grants are present, forbidden bank provisioning and
  broad bank transaction grants remain denied, and unrelated grants were not
  changed.

No historical backfill, new bank operation, phone use, ledger posting,
internal-transfer matching, business event, credential mutation, or source
mapping change was performed. The two additional pre-deploy observations were
verified as ordinary runtime notification ingestions with `UNKNOWN` and
`INGESTION_DEFAULT` resolution.

At that historical stage, the next operational step was a controlled Person 1
E2E using existing provisioned evidence. Ownership was not to be inferred from
source context alone.

## Automatic new-ingestion identity resolution (deployed)

The deployed runtime resolves only new bank transactions and does not change
existing production rows. A unique provider-scoped account
reference can produce `EXACT`; no reference, zero candidates, multiple
candidates, card-only evidence, or zero/multiple accounting scopes remain
`UNKNOWN` with explicit provenance. Card references may resolve a payment
instrument separately and never infer an underlying financial account.

The observation, bank transaction, and resolution rows are written in one
transaction. Duplicate and source-event conflict semantics are unchanged. No
historical backfill, ledger posting, internal-transfer matching, UI, or
production deployment is part of this proposed state. Runtime lookup grants are
defined by migration 016 and remain least-privilege; administrative provisioning
and resolution paths are unchanged.

## Payment instrument identity foundation (feature branch)

The current user-confirmed inventory belongs to `person_id=1`, but production
provisioning remains separate. This branch adds standalone payment-instrument
identity, explicit card person relations, provider-scoped card references, and
an optional card-to-account link. The same masked suffix in an account and a
card reference is not treated as a link. Card reference resolution is separate
from financial-account resolution and remains fail-closed when ambiguous.

The user has confirmed that all cards and accounts discovered so far belong to
Person 1. After this branch is merged and migration 015 is deployed, the first
operational sequence is:

1. provision the confirmed Person 1 cards/accounts and explicit evidence;
2. run controlled real-operation E2E and verify evidence, transaction, identity,
   and reconciliation layers;
3. verify the resulting read-only ChatGPT semantic answers.

Only after the complete Person 1 E2E is accepted should Person 2 be onboarded:
connect its source/device, verify notification visibility, discover new
card/account identities, link them first to Person 2 context, obtain explicit
user ownership confirmation, and run a short E2E regression. Person 3 follows
through the same reviewed flow. No Person 2 or Person 3 provisioning is part
of this stage.

## Historical bank-account evidence resolution

The feature branch `feat/historical-bank-account-resolution` adds an
administrative `bank-account resolve-historical` command. It is read-only by
default and accepts only an observation id. It verifies the immutable payload
hash, replays the current normalizer, compares normalized fields with the
persisted transaction, enforces one accounting scope, and derives a unique
provider/reference candidate.

An explicit `--persist` can change only an existing `UNKNOWN` resolution to
`RECONCILED`, with provenance `HISTORICAL_OBSERVATION_REPLAY`. It never changes
the observation or bank transaction, creates ownership/reference evidence,
backfills, posts ledger entries, or performs internal-transfer matching.
Missing, ambiguous, hash-mismatched, non-READY, compatibility-conflicting, and
multi-scope cases fail closed. The historical resolver was deployed from master
`9426cdf374416ea1e7de7b0ef806a63d3f8445e6` using immutable artifact SHA-256
`e28f1486ef63ac8d2eb9a77d4f361520275724628a6a56164b0f40e59b575636`.
The later docs-only merge `b67a6c68bb2ae467dd2f825158a8ed5f0839a4ca` is not
the deployed resolver SHA.

Production validation completed with schema migration `014` unchanged and no
grant changes. Read-only dry-runs for observations `72`, `75`, and `79` all
passed with provider `ru.sberbankmobile`, reference `MASKED_ACCOUNT ••0271`,
one candidate, account `1`, and compatibility `PASS`. Controlled persistence
then changed only their account-resolution rows to `RECONCILED` with
provenance `HISTORICAL_OBSERVATION_REPLAY`. The immutable observation payload
hashes and selected bank-transaction fingerprints were unchanged. A repeated
persist for observation `72` returned `ALREADY_RECONCILED` and preserved
`resolved_at`.

Coverage after validation is 81 total, 3 resolved, 78 unresolved, with 3
`RECONCILED`, 0 `EXACT`, 0 `MANUAL`, and 78 `UNKNOWN`; the coverage invariant
passes. No bank transaction backfill, INTERNAL_TRANSFER, business event, or
ledger posting was performed.

## Sber normalization v1 production validation

PR #28 and the corrective evidence-contract fix are merged in master commit
`019b89102ca91d91cd9f6b2db1647e74cc7bad95`. The corrective runtime was
promoted from an immutable LF-normalized 39-file closure with artifact SHA-256
`9c8d81c5f55d9c068133265efc6cf70cdf07345af22062f1a15727ec7fe843d1`.

Deployment validation completed for:

- exact staged and installed manifest hashes;
- `/healthz` HTTP 200 with `{"status":"ok"}`;
- JavaScript syntax, module imports, and CLI smoke;
- schema unchanged with migration `012_bank_transaction_event_type.sql` already current;
- timer restored to `enabled/active` and sync service left inactive after deployment;
- no migration execution, backfill, phone use, credential mutation, grant change, or new bank operation.

The deployed and validated Sber envelope is intentionally narrow:

- provider `ru.sberbankmobile`;
- adapter `android-notification`;
- schemaVersion `1`;
- exact proven incoming-transfer title forms only;
- first integer-ruble transaction amount token;
- a separate balance monetary field is ignored;
- event time from Android notification `postTime`.

Read-only in-memory validation against exact controlled production observations
completed successfully without exposing payload text or changing the database.
Observations `72`, `75`, and `79` each returned `INCOMING_TRANSFER`, `CREDIT`,
RUB, amount present, `READY`, and `sber-bank-normalizer-v1`. The event time was
derived from the stored Android notification event time. Related summary
observations `74`, `76`, and `80` remained `PARTIAL`/`UNKNOWN` and were not
promoted to `READY`.

This closes the Sber parser research gate for the proven v1 format. No
historical observation was updated, re-ingested, or backfilled.

Yandex normalizer v1 remains deployed and its regression suite remains passing.
At that historical stage, T-Bank and Ozon parser coverage remained future
incremental work, Alfa and VTB remained deferred, and the next phase was
`USABLE_MVP`, focused on a daily-use view of receipts, bank transactions, and
explicit READY/PARTIAL/UNKNOWN evidence states rather than another provider
parser.

## Yandex normalization v1 production deployment

The merged Yandex normalization release was promoted from master commit
`bdf924f1d8a47ea9e5d204a3f1c25b7873e93801` using an immutable LF-normalized
artifact. The deployed artifact SHA-256 was
`03b1b5dd8578543a646c82c1b82dba97afc39ae72dffeab33911e1e5b8cb8469`.

Production validation completed successfully:

- runtime manifest hashes matched the staged artifact after promotion;
- migration `012_bank_transaction_event_type.sql` was applied through the
  existing migration implementation;
- `bank_transactions.event_type` is present and existing transaction 16 is
  `UNKNOWN`; no historical normalization backfill was performed;
- observation 18 metadata and payload fingerprint remained unchanged;
- observation and transaction counts remained 16 and 16;
- an in-memory dry-run of observation 18 returned
  `INCOMING_TRANSFER`, `CREDIT`, `RUB`, `READY`, using
  `yandex-bank-normalizer-v1`;
- `/healthz` returned HTTP 200;
- runtime privileges remained least-privilege, including table-wide
  `SELECT` denied on `bank_transactions` and column-level `SELECT(id)`
  retained for `RETURNING`;
- the FNS timer was restored as `enabled/active` after validation. No manual
  sync or new bank operation was performed during this deployment.

The deployment did not change phone state, Android configuration, device
credentials, Datadog configuration, or database grants. Observation 18 was
not backfilled; the dry-run only validated parser behavior in memory.

PR #24 is merged. At that historical stage, T-Bank remained policy-blocked by
its notification permission state; that deployment did not change the device
policy. At that stage, the next functional stage was bank coverage and
provider parsers for Alfa, Sber, VTB, Ozon, and T-Bank, with each parser kept
fail-closed and evidence-preserving.

## Bank account resolution foundation production deployment

PR #32 is merged in master commit `e8940ff67ceefa1127729e0325abe5df65e68fb8`.
The immutable production artifact was built from that exact commit with
archive SHA-256
`0c68e31430a8b488e98d8cd7d663498225c09f2e912b745294b05dbd00d24e4d`.

Production validation confirmed:

- migration `013_bank_account_resolution_foundation.sql` is applied;
- `/healthz` returned HTTP 200 and `finance-bank-ingestion.service` is active;
- `bank_transactions` remained 79 before and after deployment;
- `bank_event_observations` remained 79 before and after deployment;
- no historical source evidence or resolution rows were changed and no
  backfill was performed;
- the 79 unresolved transactions remain explicit `UNKNOWN`, with coverage
  invariant PASS;
- the runtime role has only `INSERT` on
  `bank_transaction_account_resolution`; `SELECT`, `UPDATE`, and `DELETE`
  remain denied;
- no phone use, new bank operation, ledger posting, internal-transfer
  matching, or UI work was performed.

The semantic boundary is unchanged: source/device `OWNER` context never
establishes financial-account ownership. `EXACT` requires proven
provider/reference evidence and fails closed for zero or multiple candidates.
New bank transactions default atomically to `UNKNOWN`.

The intended next chain is:

```text
bank transaction
-> financial account resolution
-> internal-transfer reconciliation
-> business event
-> ledger Dr/Cr
-> ChatGPT semantic access
```

Operational note: `scripts/migrate-prod-only.mjs` had a path defect discovered
during migration 013 deployment. PR #34 corrected the wrapper to resolve the
repository migrations directory independently of caller cwd; migration 014
was subsequently applied through that corrected wrapper using administrative
PostgreSQL peer access.

## Bank account resolution operationalization

PR #34 is merged in master commit
`d4b6f1337fcd450569868127d7b144eb7d14e7c3`. Its immutable LF-normalized
production artifact has archive SHA-256
`0b8a103d9ad988be4ce4abd1f10b49ee1edf28934afb89d3a5a15e640d0dd7e6` and is
deployed at `/opt/accountant/releases/d4b6f1337fcd450569868127d7b144eb7d14e7c3`.

Production validation completed successfully:

- migration `014_bank_transaction_account_reference_kind.sql` was applied
  through the corrected `scripts/migrate-prod-only.mjs` wrapper using the
  administrative peer path;
- the wrapper was validated from a non-repository caller context and the
  staged/installed manifest hashes matched the exact master artifact;
- `finance-bank-ingestion.service` is active and `/healthz` returns HTTP 200;
- the FNS timer was restored to `enabled/active`, with no manual sync run;
- `bank_transactions` and `bank_event_observations` remained at 81/81;
- all 81 historical `account_reference_kind` values remain NULL; no historical
  reference projection or backfill was performed;
- runtime grants were not broadened and remain limited to `INSERT` on
  `bank_transaction_account_resolution` for unresolved ingestion rows.

Migration 014 adds nullable `bank_transactions.account_reference_kind` with
controlled values `MASKED_ACCOUNT`, `MASKED_CARD`, and `OTHER`; historical rows
remain valid and no backfill is permitted. Sber's proven `Плат. счёт ••dddd`
structure is canonicalized as four digits plus `MASKED_ACCOUNT`; Yandex remains
without account-reference evidence.

The operator CLI must use an administrative/peer-access identity, never the
`receipt_collector` runtime role. `EXACT` remains restricted to provider,
reference kind, reference value, and unique accounting-scope evidence;
missing, zero, or multiple candidates fail closed. Manual resolution requires
an explicit reason and cannot assert `EXACT`.

Read-only deployed CLI smoke passed for `bank-account list` and
`bank-account coverage` before provisioning. The account inventory was empty
at precheck and coverage reported 81 unresolved `UNKNOWN` transactions.

In-memory validation of the stored controlled Sber observations 72/75/79
returned `INCOMING_TRANSFER`, `CREDIT`, RUB, `READY`,
`sber-bank-normalizer-v1`, and `MASKED_ACCOUNT` with the same safe masked
reference. Summary observations 74/76/80 remained fail-closed `PARTIAL`/
`UNKNOWN` without an invented reference. Yandex behavior remains unchanged.

The ownership barrier remains active for all unconfirmed accounts: source/device
`OWNER` context is capture and accounting context only, not financial-account
ownership proof. No payment instrument or manual resolution was created.

## Sber account provisioning

On 2026-09-29 the user explicitly confirmed that `person_id=1`,
`legacy-current-user`, is Adam in this accounting context and that Sber masked
account `••0271` belongs to Adam. This is manual user evidence, not an
inference from device or bank-source ownership.

One atomic administrative transaction provisioned:

- financial account `1`: Sber, provider `ru.sberbankmobile`, currency `RUB`,
  display `Sber ••0271`;
- one `OWNER` relation to person `1` with provenance `USER_CONFIRMED`;
- one account reference `ru.sberbankmobile / MASKED_ACCOUNT / 0271`.

No payment instrument was created because the evidence proves an account
reference, not a specific card. Historical bank transactions and immutable
observations were not updated, re-ingested, or backfilled. Coverage remains
81 total and 81 `UNKNOWN`; historical resolution rows remain unchanged.

At that historical stage, the next step was reviewed historical resolution for controlled Sber
observations 72/75/79 using immutable observation evidence and explicit
provenance. `INTERNAL_TRANSFER` reconciliation remains out of scope until
both sides of an own-account transfer have proven account identity.

## Person 1 account and card identity provisioning

Migration `015_payment_instrument_identity.sql` was applied in production
through the administrative migration wrapper. The exact master release
`982afaaf076c2ff47526485d85fe185569c7cdf2` was promoted from immutable
artifact SHA-256
`4468588f0afd47f7dfea2c6e16c0b0009c11b12141de0f0e530c7e0e9bbff46f`.
Production validation returned `/healthz` HTTP 200, an active
`finance-bank-ingestion.service`, and an enabled/active FNS timer.

The user-confirmed Person 1 inventory is now provisioned:

- financial accounts `1` Sber `••0271`, `2` Alfa `••3978`, and `3` Alfa
  `••8451`, each with one `OWNER` relation to person 1 and a
  `USER_CONFIRMED` provenance;
- standalone payment instruments `1`/`2`/`3` for Alfa cards `••1913`,
  `••5580`, and `••8451`, plus `4`/`5` for Yandex cards `••4297` and
  `••9615`, each with one `OWNER` relation to person 1 and no financial
  account link;
- account/card references were created with their proven provider and kind.

The Alfa account `••8451` and Alfa card `••8451` remain distinct identities;
no card-to-account links were created. Accidental duplicate Yandex
instruments `6`/`7` and references `9`/`10` were removed in one targeted,
precondition-checked administrative transaction; canonical instruments
`4`/`5` and references `7`/`8` were preserved.

Observations, bank transactions, account resolutions, historical Sber
resolutions `72`/`75`/`79`, grants, credentials, and source/person links were
not changed by provisioning or cleanup. No backfill, transaction resolution,
internal-transfer matching, business event, or ledger posting was performed.
The next development step is automatic fail-closed identity resolution for
new ingested transactions containing proven references. Controlled real-bank
E2E must wait until that code slice is merged and deployed.

## Read next when needed

Detailed architecture and operating contracts already live in:

- `README.md`
- `docs/OPERATIONS.md`
- `docs/android-bank-notification-collector.md`
- `docs/bank-device-auth.md`
- `docs/bank-ingestion-data-contract.md`
- `docs/bank-source-provisioning.md`

Relevant implementation history is in PRs #14 through #21. Do not duplicate those documents here unless the operational state depends on a result that is not obvious from code.

## Project invariants

The project combines independent financial evidence sources into a verifiable accounting model.

Key semantic rules:

- bank transaction != purchase
- receipt != cash flow
- source/person ownership is context, not proof of payer or beneficiary
- raw evidence and normalized projections remain separate
- reconciliation must preserve evidence, provenance, reason, and uncertainty
- unknown/partial is preferable to guessing

The existing receipt/FNS pipeline and the newer bank cash-flow pipeline are intentionally separate evidence paths that may later be reconciled.

## Bank ingestion backend: proven

The production bank-ingestion path is already implemented and has passed synthetic E2E.

Proven behavior:

- first valid event -> HTTP 201 `created`
- exact replay -> HTTP 200 `duplicate`
- same source event id with changed payload -> HTTP 409 `SOURCE_EVENT_CONFLICT`
- conflict creates no extra observation/transaction
- authenticated source binding works
- observation creation works
- normalized bank transaction creation works
- duplicate handling is idempotent

Do not restart backend design work merely because the current Android callback test fails.

## Production privilege history

Runtime DB role: `receipt_collector`.

It is intentionally least-privilege.

Previously fixed issues included narrowly scoped access for runtime authentication/ingestion, including `UPDATE(last_used_at)` on device credentials and `SELECT(id)` where required by `RETURNING`.

PR #17 removed an unnecessary observation row lock so ingestion works under the restricted runtime role without granting broad table access.

Important boundary:

- runtime ingestion must **not** receive provisioning privileges such as `INSERT` on `bank_device_credentials`
- device credential provisioning is an administrative operation
- when a replacement credential was needed, it was provisioned one-shot through PostgreSQL peer auth as `postgres`, without changing runtime grants

Do not broaden production grants to solve application problems.

## Android device/source state

Expected physical device:

- model: Samsung SM-S938B
- ADB serial: `R5GL30GK60F`

Collector package:

- `com.adamaste.buhguy.bankcollector`

Bank source:

- `android-adam-samsung-s938b`
- source type: `ANDROID_NOTIFICATION`
- source is associated with the existing accounting person context

Server endpoint:

- `https://v3234257.hosted-by-vdsina.ru/api/v1/bank/events`

Configured allowlist:

- `ru.alfabank.mobile.android`
- `com.idamob.tinkoff.android`
- `ru.sberbankmobile`
- `com.yandex.bank`
- `ru.vtb24.mobilebanking.android`
- `ru.ozon.fintech.finance`

There may be a second ADB endpoint shown as `offline`. Use the explicit physical target when running ADB commands:

`adb -s R5GL30GK60F ...`

## Device credential state

A replacement device credential was created during the signing migration and is active for source `android-adam-samsung-s938b`.

The old credential has intentionally not yet been revoked.

The replacement token was stored safely and entered into the Android UI without printing it. Do not log, print, recommit, or recreate it unless a new security event requires rotation.

The replacement credential has already been used successfully by a real bank delivery, so authentication is not the current blocker.

## Android signing: closed

The old installation originally used an ephemeral debug signing certificate, which prevented safe in-place updates from CI builds.

PRs #19 and #20 established permanent release signing for trusted `master` builds.

Stable certificate SHA-256:

`cb619643bbfb6b9235c85c560ba26967d2ca0f28db01fb6a7b9b3d6be484486a`

CI verifies the signed APK certificate before artifact upload.

The one-time controlled uninstall/reinstall migration has already been completed. Current and future application updates must normally use:

`adb install -r`

Do not propose another uninstall/reinstall merely because older debug-signing history exists.

## Android observability history

PR #18 introduced safe capture diagnostics around:

- `CAPTURED`
- `INSERTED`
- `DUPLICATE`
- Room insert error
- enqueue error

A diagnostic blind spot was then discovered: the original `BankCapture` entry happened only after preferences/allowlist/capture processing, so absence of `CAPTURED` did not prove absence of `onNotificationPosted()`.

PR #21 fixed that blind spot and is merged in current master.

Current observable chain includes:

- listener connected/disconnected
- callback entry
- filtered/not-allowed
- capture-null
- captured
- inserted/duplicate
- Room error
- enqueue error

Callback entry is recorded before preferences and allowlist evaluation.

Persistent UI diagnostics include last callback and listener lifecycle in addition to last capture, pending events, and last successful delivery.

A follow-up review restored separate enqueue error diagnostics and their regression test before PR #21 was merged.

## Stable PR #21 build installed

PR #21 merge SHA:

`77be9493d78076247f590935fd02865e7f175da3`

Master CI run:

`36324042145`

Signed artifact:

- name: `buhguy-bank-collector-signed`
- artifact id: `10933711781`
- APK SHA-256: `e3ba6dcd7a6152f1ccc9122cec782549b14f40d79ab15087968348edf67982b0`
- certificate matches the stable certificate above

This APK was already installed **in place** with `adb install -r`.

Post-update checks passed:

- config preserved
- source key preserved
- server URL preserved
- allowlist preserved
- credential preserved
- pending = 0
- notification access enabled
- listener connected
- no uninstall
- no app-data clear

## Synthetic callback test: passed

A harmless synthetic notification was posted from `com.android.shell`.

Observed:

- `CALLBACK_ENTRY_FOUND=YES`
- `FILTERED_NOT_ALLOWED_FOUND=YES`
- callback package matched
- Room unchanged
- pending remained 0
- no Android runtime crash

Conclusion: Android NotificationManager -> collector NotificationListenerService -> `onNotificationPosted()` -> allowlist filtering is proven to work in this installed build.

Do not repeat this test unless a later change invalidates that proof.

## Real bank proof: Alfa passed

A real Alfa Bank notification has already passed the complete Android delivery path.

Baseline immediately before the second Yandex/T-Bank real test included:

- pending = 0
- last capture = `INSERTED ru.alfabank.mobile.android ...`
- last successful delivery = 2026-09-27T13:48:18.119872Z
- listener lifecycle = connected
- backend observation count = 14, max id = 17
- backend transaction count = 14, max id = 15
- replacement credential `last_used_at` updated at the corresponding successful delivery

This proves the real-device collector, Room, WorkManager, HTTPS transport, authentication, and backend ingestion can work end-to-end. The current issue is narrower than “collector is broken”.

## Real2 test and completed post-test forensics

A controlled real transfer was performed:

- amount: 100 RUB
- source: T-Bank
- destination: Yandex Bank
- both bank apps are installed on the same Samsung device

Evidence log:

`C:\\Users\\Адам\\Documents\\Codex\\bank-collector-real2-20260927-171721.log`

Preserved evidence metadata:

- log size: 5475 bytes
- SHA-256: `37692bc4639520fe3f7f1952bec54fb98ee400a1642c65e4775c57de81f48392`

### Collector/backend result

For both `com.yandex.bank` and `com.idamob.tinkoff.android` during REAL2:

- `CALLBACK_ENTRY`: not found
- capture/insert: not observed
- Room: unchanged
- backend observations: unchanged
- backend transactions: unchanged
- replacement credential `last_used_at`: unchanged
- pending remained 0
- no Android runtime crash was found

Only `ru.yandex.taximeter` was seen in the relevant collector log and was correctly filtered as `not_allowed`.

This placed the REAL2 failure before the collector's bank-specific capture logic.

### T-Bank: concrete system policy blocker found

Package:

- `com.idamob.tinkoff.android`
- Android user: 0
- version observed during forensics: 8.3.0 / 13196

Read-only Android policy inspection found:

- `POST_NOTIFICATIONS=DENIED`
- notification AppOps: `POST_NOTIFICATION=IGNORE`

This is a concrete explanation for why T-Bank produced no NotificationManager record and no collector callback in REAL2.

At that historical stage, treat the T-Bank branch of this test as
**policy-blocked**, not as evidence of a collector failure.

Do not continue T-Bank callback debugging unless notification policy is intentionally changed in a separately reviewed/user-approved step and a later test is needed.

### Yandex Bank: Android notification policy looks healthy, post still not proven

Package:

- `com.yandex.bank`
- Android user: 0
- version: 0.241.2 / 11917
- stopped: false
- suspended: false

Read-only policy evidence:

- `POST_NOTIFICATIONS=GRANTED`
- AppOps: default/allow
- app importance: default
- app user-set importance: false
- no package/channel group block was found
- no profile/user boundary was found
- no notification delegation evidence was found
- collector listener remained enabled/live under user 0

Observed Yandex channels included:

- `appmetrica_push`: importance 2, not deleted
- `notification_channel_1`: importance 5, not deleted
- `notification_channel_2`: importance 5, not deleted
- security/sign-in channels: importance 4, not deleted

Push-related components are present, including Firebase Messaging and AppMetrica push components/receivers.

However:

- no Yandex NotificationManager record for the REAL2 event was found
- no current Yandex notification key was found
- no Yandex collector callback was found
- system notification post evidence for the REAL2 event remains absent

Therefore:

- collector callback/capture/Room/backend are not the current Yandex investigation boundary
- Android permission/AppOps/channel policy is not showing a blocker
- the unresolved interval is now specifically:
  remote push delivery -> Firebase/AppMetrica/Yandex push handling -> Yandex application decision/suppression -> Android NotificationManager publication

Do not claim that the Yandex push definitely arrived at the app. That runtime fact has not been proven.

## Historical Yandex Pro live-notification finding

This section records the pre-classifier Yandex investigation and is retained
for forensic context only; it is not the current operational next action.

A later live NotificationManager capture materially changed the Yandex diagnosis.

While the notification shade visibly contained six Yandex Pro financial cards (purchases/incoming transfers), a read-only active notification capture found exactly six active records for:

- package: `ru.yandex.taximeter`
- Android user: 0
- channel: `notification_channel_1`
- importance: 4

Active ids included `52091223`.

The preserved REAL2 collector log contains:

- callback package: `ru.yandex.taximeter`
- notification id: `52091223`
- callback wall-clock time: 17:28:11
- result: `FILTERED_NOT_ALLOWED`

The visible shade also contained an incoming-transfer card timestamped 17:28.

The saved live `dumpsys notification` record does not expose `postTime`, so the previously defined strict package+id+postTime join cannot be completed from preserved metadata. For that reason, the formal forensic label remains a strong/partial causal match rather than a mathematically exact two-field join.

Operational interpretation:

- the old assumption that REAL2 should appear as `com.yandex.bank` is no longer the leading hypothesis
- there is strong evidence that the relevant Yandex financial notifications are posted by `ru.yandex.taximeter` / Yandex Pro
- current collector filtering is package-only
- `ru.yandex.taximeter` is not in the configured allowlist
- the callback is therefore rejected before capture/Room/backend
- all six currently observed `ru.yandex.taximeter` active records used `notification_channel_1`
- however, historical exclusivity of that channel to financial notifications is not yet proven

At that historical stage, do not simply add all of `ru.yandex.taximeter` to the
allowlist. The investigation first needed to establish whether
`notification_channel_1` was sufficiently finance-specific. If it had been,
the preferred direction was a backward-compatible package+optional-channel
rule while preserving existing package-only behavior for normal bank apps.

The earlier static-analysis branch for `com.yandex.bank` is suspended unless later evidence makes it relevant again.


### Yandex Pro channel-isolation follow-up

Read-only APK analysis of the installed Yandex Pro package used the complete local APK set:

- `base.apk` SHA-256 `d75f5191e1ba887441fb65f084f3090414b344171dbbdb3d1d3186ff2da19278`
- `split_config.arm64_v8a.apk` SHA-256 `f4f8332c43704c355bee19941b1faea7fc651859ce96c7045ecfd57157ae8331`
- `split_config.xxhdpi.apk` SHA-256 `3ab753390bdc0bfa8c02713226bf03ee9e7ba9e74f05f788da8a2ac5d970724d`

Result:

- all six currently visible/active Yandex Pro financial cards used `notification_channel_1`
- no non-financial use of the channel was observed in the captured current set
- historical channel usage was unavailable
- exact static xrefs for `notification_channel_1` were not recovered
- the app uses Flutter/AOT code in `libapp.so`; generic notification-channel APIs were visible but did not prove module exclusivity
- therefore `FINANCIAL_CHANNEL_ISOLATION=NOT_PROVEN`

The following guidance applied during the pre-classifier Yandex investigation and is retained as historical rationale. The provider-specific local classifier has since been implemented and deployed; do not restart this investigation as a current next action.

Do not implement a channel-only allow rule yet. At that stage, the next useful evidence was a privacy-safe discriminator available on the `StatusBarNotification`/Notification metadata of the six known financial records (for example tag shape/prefix, group, category, creator/intent identity, or another stable non-content field). If no reliable metadata discriminator existed, a deliberately scoped provider-specific content classifier with regression fixtures could be required, but brittle regex heuristics were not justified without evidence.


### Yandex Pro metadata-discriminator follow-up

Privacy-safe metadata analysis of the six known financial active records found the following common positive-set features:

- package/opPkg: `ru.yandex.taximeter`
- channel: `notification_channel_1`
- importance: 4
- flags: auto-cancel
- visibility: private
- small icon: resource `0x7f110000`
- common group pattern: `0|ru.yandex.taximeter|g:Aggregate_NormalNotificationSection`
- active records had no retained tag value, although the earlier REAL2 callback reported `hasTag=true`

No negative set of known non-financial Yandex Pro notifications was available. Static correlation inside Flutter/AOT code did not prove that channel/icon/group metadata belongs only to financial notifications.

Result:

- `METADATA_DISCRIMINATOR_DECISION=CANDIDATE_ONLY`
- metadata-only filtering is not sufficiently proven for production
- further generic reverse engineering is not justified by the available evidence
- the resulting design direction was a narrow Yandex Pro transport match plus a provider-specific local financial classifier before persistence/backend delivery
- `FINANCIAL` may proceed to mapping/outbox
- `NON_FINANCIAL` and `UNKNOWN` must be dropped locally with safe diagnostics and no raw-content logging
- classifier behavior must be defined from sanitized regression fixtures before implementation


## Samsung Freecess / MARs

Historical diagnostics showed Samsung Freecess/MARs freezing and unfreezing the collector and some Yandex-related background freeze messages.

However, Freecess is **not** a proven root cause.

Do not state that Samsung Freecess caused the missed bank callback unless new evidence directly supports that conclusion.

## Historical immediate next action

This section is retained only for historical context and is superseded by the
top-level current `Next action` above. It must not override the current
controlled-expansion closeout state.

The Person 1 account-identity readiness audit is complete for development and
the active phase is `RECONCILIATION_DEVELOPMENT`. The Alfa lifecycle
canonicalization, bank business-event candidate, two-sided internal-transfer,
bank-ledger, and `bank-receipt-matching-v1` slices are complete and remain
non-mutating.

The historical immediate next action was
`matched-purchase writer orchestration / controlled production-readiness validation`.
The non-mutating matched-purchase enrichment projection, reviewed persistence
contract, migration 018 schema foundation, and ACTIVE-ledger runtime semantics
are merged, including the atomic matched-purchase persistence writer v1. The
next code slice must decide when and how authoritative eligible matches invoke
that writer, expose a non-mutating preview/dry-run of intended writes,
eligibility/block reasons, and idempotency identifiers, and define operational
retry/observability behavior. Replay remains deterministic and idempotent;
disagreement or ambiguity must fail closed. It must not deploy, replay,
backfill, or mutate production.

Controlled real operations are allowed only when the user independently
chooses to perform them. The controlled purchase campaign is closed; do not
manufacture additional operations. Future natural provider events may be
audited with a clean Android/backend baseline and full notification-lifecycle
correlation when relevant.

Bank-to-receipt candidate matching, matched-purchase enrichment, and the
atomic matched-purchase persistence writer are merged evidence/projection and
write-path layers. Account identity may be used only when explicitly resolved;
bank-account OWNER evidence is not payer/beneficiary proof; and
`INTERNAL_TRANSFER` still requires independently proven two-sided own-account
evidence. Writer orchestration and controlled production-readiness validation
remain separate; production deployment, replay, backfill, and production
reconciliation decisions remain out of scope. Fresh provider E2E waits remain
opportunistic and do not block development.

Raw notification text, real amounts, names, recipients, account/card
identifiers, and source-event identifiers must remain out of Git. The stale
Android diagnostics issue is closed by PR #66; it is not a current blocker.

## Historical Yandex diagnostic interpretation guidance

This section is retained for forensic context only and is not the current
operational next action.

For Yandex static APK forensics:

- if explicit received-push -> no-notification branches exist, record them as candidate suppression paths, not as the REAL2 root cause
- if the relevant push path can be shown to always publish a notification, identify what runtime evidence would be required to distinguish push non-delivery from an unexpected alternate path
- if notification delegation/alternate posting identity exists, document the exact mechanism without changing the collector allowlist yet
- if static analysis is inconclusive, state exactly which code boundary is opaque/obfuscated and design the smallest safe runtime observation needed next

For future collector evidence, the already established stage interpretation remains:

- `CALLBACK_ENTRY -> FILTERED_NOT_ALLOWED`: actual package identity/allowlist issue
- `CALLBACK_ENTRY -> CAPTURE_NULL`: capture conversion issue
- `CAPTURED` without Room insert: Room/duplicate/error issue
- `INSERTED` without backend: WorkManager/network/auth issue; this path has already succeeded for Alfa

## Historical parser-design principles

Provider parsers must continue to extract only evidence actually present, such as:

- debit/credit direction
- amount
- currency
- event time
- counterparty/merchant when supported
- controlled account/card reference when supported
- transfer/payment/refund/fee classification when supported

Unknown or partial evidence must remain `UNKNOWN`/`PARTIAL`; do not guess.

Reconciliation with receipts/purchases belongs to a later separate evidence layer.

## Maintenance rule for this file

After a significant completed stage, update this document in a reviewed PR so the next chat begins at the new operational point.

Never commit:

- bearer/device tokens
- DB passwords
- signing private material/passwords
- private keys
- raw sensitive notification payloads
- secret hashes unless a reviewed security design explicitly requires them


## Production schema-readiness rehearsal for migration 019 (historical)

The exact current master 4591caff5ce007664aece7f1f8249c258f3a6935 was verified after PR #133. Production was inspected read-only: PostgreSQL 18.6, schema head 018, migration 019 absent, analytics 011 views absent, no waiting locks, and the least-privilege service role remained blocked from certification source tables with 42501. No production DDL/DML or grant change occurred.

A fresh production custom-format backup was created and validated with pg_restore --list, then restored to a disposable clone. The exact repository migration runner applied 019 successfully and a second run was a no-op. Analytics 011 was installed separately and a second installation was idempotent. Clone checks passed for the six new tables, eight views, taxonomy/category seeds, constraints/indexes, unchanged pre-existing business/bank/receipt/certification/ledger/matched-purchase row counts, and transactional rollback after an interrupted clone-only DDL transaction. The disposable clone and temporary role were removed.

This is rehearsal evidence only. The reviewed runbook is docs/production-schema-readiness-migration-019-v1.md. No production migration, analytics install, grant, deployment, restart, certification refresh, writer call, replay, backfill, or production mutation is authorized by this closeout.

## Production schema-only rollout for migration 019 and analytics 011

The authorized schema-only rollout was executed from exact master
`83cddf3877edda136196da5471b09f308ade1efc` after master CI
`37764358275` passed all applicable jobs. A separate checkout was used;
the active runtime release was not replaced.

The read-only preflight confirmed the expected production database, schema
head 018, no pending migration other than the approved 019, no migration 019,
no analytics 011 views, and no blocking transaction/lock activity. A fresh
custom-format PostgreSQL backup was created outside the release checkout and
validated: `/var/backups/receipt-collector/postgres/finance_receipt_collector-schema019-rollout-20261008T105050Z.dump.gz`,
SHA-256 `537bb172f45db34a783e97062ba0f3b953b750e9c61863c03369a7282a74b145`,
non-empty mode 0600, gzip integrity and `pg_restore --list` passed. Existing
backups were retained.

Only the guarded production commands were used: `node
scripts/migrate-prod-only.mjs` followed, after its postcheck, by
`node scripts/install-analytics-prod-only.mjs`. Migration 019 is now the
schema head. Its six tables, 28 foreign-key constraints, 27 indexes, one
taxonomy version, and 21 seeded categories were verified. Analytics 011
installed eight views in a separate bounded transaction; no explicit view
ACLs were added and no GRANT/REVOKE was run.

Pre-existing business, bank, receipt, certification, ledger, and
matched-purchase counts were unchanged across the rollout:
observations 428, bank transactions 428, matches 13, business events 2069,
certification facts 5850, ledger entries 2082, supersessions 13, postings
4018, source links 2025, receipts/fiscal facts 2771, reconciliation results
8, and reconciliation runs 1. The ingestion service remained active and its
local health endpoint returned `{"status":"ok"}`; no restart or deployment
was performed.

After rollout, the exact-master resolver ran in a `REPEATABLE READ READ
ONLY` transaction for Person 1 scope `default/id1`. It computed live
source state `dfaca835c8a9c9678fd778a8e04783940a7f0053d42edc5b1ce305cbbd02f2aa`
and returned `NO_CURRENT_CERTIFICATION`; no exact unbounded READY run was
available. No certification refresh was attempted. The schema rollout is
complete, but current-snapshot certification validation remains a separate
read-only stage.

No grants, runtime deployment, service restart, writer call, certification
refresh, replay, backfill, classification, or unrelated production mutation
was performed. The next action is `production read-only canonical spending
current-snapshot validation`.


## Production read-only canonical spending current-snapshot validation (historical, before materialization)

The then-current master `39a45e68ae70050b7262c7d1db5c3711a8cc9993` passed master CI `37768474323` (test/PostgreSQL integration, full suite, Android, and signed Android). This historical stage used only `REPEATABLE READ READ ONLY` transactions and safe aggregate diagnostics; it did not invoke a writer or certification persistence.

For Person 1 scope `default` (scope id `1`), the live authoritative source-state key was `4a55497313a8e82342a3877c91122ff5d22d05423e973a2b25b5acab80445ef2`. The non-persisting projection produced 5,840 facts and 8 results, all in RUB, over 2,070 active ledger entries. Its metric aggregates were: BLOCKED_EXPOSURE 73 facts / 183,738.45; FISCAL_NEW_MONEY 1,907 / 2,187,333.77; CONFIRMED_ACQUISITION_VALUE 1,920 / 2,211,029.87; ACQUISITION_CLASSIFICATION 1,920 / 2,211,029.87; CONFIRMED_RETURN_VALUE 10 / 5,782.29; OUTSTANDING_REFUND_RECEIVABLE 10 / 5,782.29. These are aggregate diagnostics only, not persisted certification.

The historical unbounded READY run was stale for this source state, so the live status is `NO_CURRENT_CERTIFICATION`. No run, fact, result, ledger, receipt, bank, classification, grant, or view row was written or refreshed.

On a disposable PostgreSQL clone, the exact one-time unbounded certification path produced a matching READY current snapshot. The clone's canonical household, category, and person summaries reconciled exactly by currency using decimal minor-unit arithmetic: RUB gross `2210631.68`, returns `5782.29`, and net `2204849.39` in each aggregate view. The clone also passed the current-state reader compatibility check after the shared result semantic-key correction. PR `#137` is now merged as `3dd5fa0a3095510f266fa7cc8c62e5188eb9ecb9`; exact-head master CI must still be verified before any production materialization. The clone's source-state identity was not recorded alongside these totals, so its RUB gross `2210631.68` is NOT proven comparable with the production read-only projection's `2211029.87` (difference `398.19`). Before materialization, compare authoritative source-state identities and independently reconcile the same-state aggregates; if the identities match but totals differ, STOP for investigation.

The first separately approved production certification materialization is now
complete. Future materializations must still require successful exact-master
CI, a fresh validated backup, verified same-source-state monetary
reconciliation, one bounded transaction with the approved write-capable role,
an exact expected source-state key, and read-only postchecks. Stop on source
drift, a missing/unready/conflicting exact run, lock/timeout, or fact/result
mismatch. Never delete history, use `replace=true`, retry blindly, replay,
backfill, deploy, or enable an automatic refresh trigger.

After new bank or receipt ingestion, certification is not automatically current: the next controlled cycle must recompute source identity, run the non-persisting projection, classify the state, and only then use the separately approved materialization procedure. No automatic refresh, writer trigger, replay, or backfill is enabled.

## Sync rollback snapshot tooling (2026-10-12)

PR #169 was merged into master as merge commit
`3ceb26267b271e7011d1f2d87ff649ff2d7c54fe` (PR head
`9dd47dfe6c9496901809501e64d81c809973b9f3`). Its exact-head local gates
passed: 474/474 unit tests, 116/116 PostgreSQL 16 integration tests, and
17/17 targeted Linux snapshot/verifier tests, with no skips. No GitHub Actions
or production operation was used.

The code-only snapshot tool fingerprints and verifies a statically discovered
closure and records content hashes and modes. It does not identify a Git
commit or prove historical provenance. The actual production sync entrypoint,
runtime dependency closure, service-user access, backup restore readiness, and
WAL/emergency reserve remain unconfirmed. `DEPLOY_READY=NO`.

### Static closure limits

The analyzer follows recognized static ESM imports/exports, literal dynamic
`import()`, and literal CommonJS `require()` edges, plus reached package entry
metadata. It supports only `.js`, `.mjs`, and `.cjs` code files. It does not
execute the application or discover modules/assets selected through runtime
filesystem reads, computed paths, plugin registries, native loading, spawned
commands, or other external executables. `eval`, `createRequire`, computed
imports/requires, template interpolation, unsupported package export
conditions/arrays/patterns, and unclassified paths stop the snapshot. The
supported export conditions are limited to ordered `node`, `import`/`require`,
and `default`. These limits must be compared with an authorized read-only
inventory of the real service before claiming closure; do not add files to
bypass a STOP without separately reviewing their path and purpose.
The sensitive-name filter may also stop a legitimate code module whose path
contains a sensitive segment (for example `session-store.js`); keep that
fail-closed result until the specific path is reviewed, and do not broaden the
allowlist automatically.

### Next authorized stages

1. Request one narrowly bounded READ ONLY production inventory of the
   effective sync `ExecStart`, `User`, and `WorkingDirectory`; code-only
   dependency closure and dynamic runtime dependencies; and metadata-only
   paths, ownership, modes, symlinks, and service-user access. Do not read
   secret values, session/profile contents, logs, or financial data. No prior
   production authorization remains active.
2. If that inventory proves a complete safe code-only closure, obtain separate
   explicit authorization for sync quiescence and creation of the snapshot at
   only the exact release-directory paths in
   `docs/sync-runtime-rollback-snapshot-v1.md`.
3. Obtain separately scoped authorization for any production rollback
   rehearsal that changes service configuration. Verify the snapshot as the
   actual service user and preserve the current WorkingDirectory/state; never
   restore an old state or token copy.

These stages do not authorize deployment. Backup restore readiness and the
WAL/emergency disk reserve remain independent deployment blockers. No
automatic deployment, sync, snapshot, or rollback is authorized. PR #163 and
its fourth-preview technical-error blocker remain separate and unresolved;
do not rerun the preview or alter that PR as part of this work.


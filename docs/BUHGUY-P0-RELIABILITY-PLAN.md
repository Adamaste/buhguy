# BUHGUY P0 Reliability Plan

This is the execution plan for making `buhguy` reliably process evidence from
capture through certified accounting. The P0 end state is a continuously
operating system that, without a manual trigger, receives FNS receipts and
bank events when the source delivers them, recovers safely from bounded
failures, deduplicates retries, automatically matches only provable bank+FNS
purchases through the existing authoritative writer, prevents double counting
in the ACTIVE ledger, and keeps certification current after source changes.

This is a target, not current authorization. It does not authorize production
writes, deployment, migration, grants, replay, backfill, or automatic
certification. Each stage requires its acceptance gates before the next stage
starts and a separate explicit approval before production activation.

## Operating principles

- Financial correctness is more important than recognition coverage.
- Preserve evidence and provenance; never invent amount, direction, currency,
  ownership, business meaning, or a match.
- Fail closed on ambiguity, disagreement, stale certification, incomplete
  scope, and conflicting ledger provenance.
- Use exact decimal strings, PostgreSQL `NUMERIC(18,2)`, or BigInt minor units.
- One economic purchase is one purchase-grain fact and one active monetary
  ledger entry; item fan-out, receipts, notifications, and superseded history
  must not create extra money.
- Apply SIMPLE-FIRST / REUSE-FIRST: extend existing capture, ingestion,
  matching, ledger, certification, and read-model paths before adding a new
  service or protocol.

## Stage 0: establish the reliability baseline

**Existing:** Android collector diagnostics, Room/outbox delivery, immutable
bank observations/transactions, FNS evidence, deduplication keys,
current-snapshot/source-state guards, ACTIVE-ledger semantics, and the
read-only canonical spending API.

**Missing:** one safe, repeatable inventory of loss, delay, retry, rejection,
and stale-state signals across the whole pipeline.

**Smallest change:** a read-only diagnostic projection that joins existing
metrics and reports capture, outbox, delivery, ingestion, normalization,
matching, ledger, and certification health without exposing raw evidence.

**Tests/gates:** disposable fixtures for callback-to-observation correlation,
outbox retry, permanent rejection, duplicate delivery, source-state change,
and missing current READY certification. Counts and safe identifiers only.

**Idempotency/recovery/observability:** diagnostics are read-only and
repeatable; every result carries a bounded observation window and source-state
identity; no diagnostic retries a writer.

**Security boundary:** no credential, notification body, receipt payload,
account/card reference, or direct public-database publication.

**Exit proof:** a named set of measurable counters and failure buckets exists,
with a documented distinction between normal concurrent ingestion and data loss.

## Stage 1: lossless Android capture and delivery

**Existing:** the signed collector, notification listener, provider allowlist,
source provenance, Room/outbox, delivery retry behavior, and device
diagnostics. Do not redo closed provider grammar or APK work without a new
failure.

**Missing:** proven bounded behavior when the listener is delayed, the process
is killed, the network is unavailable, the backend rejects a request, or the
same notification is delivered repeatedly.

**Smallest change:** strengthen the existing outbox state machine and
diagnostic counters only where Stage 0 identifies a real gap. Keep immutable
source identity and retry ownership in the existing components.

**Tests/gates:** Android unit tests for callback idempotency and restart
recovery; disposable backend tests for retry/ack/rejection; one controlled
device check only if a fixture cannot prove the behavior.

**Idempotency/recovery:** stable source-event identity, durable pending state,
bounded retry/backoff, explicit permanent rejection, and no deletion as a
recovery strategy.

**Exit proof:** every accepted callback is either durably pending/delivered or
has a visible permanent failure with safe correlation markers; duplicate
delivery creates no duplicate evidence.

## Stage 2: backend ingestion and evidence deduplication

**Existing:** immutable observation/transaction tables, provider normalizers,
source provenance, account-resolution state, and safe normalization contracts.

**Missing:** an end-to-end proof that retries, concurrent delivery, malformed
input, and partial downstream work converge without changing historical
evidence.

**Smallest change:** add or repair transaction-scoped idempotency checks and
observability at the existing ingestion boundary; do not rewrite normalizers
or raw evidence.

**Tests/gates:** PostgreSQL tests for concurrent duplicate observations,
duplicate source-event ids, partial failure and retry, provider ambiguity,
unknown direction, and exact decimal amounts. Assert immutable old rows and
zero unintended ledger/business-event writes.

**Exit proof:** repeated and concurrent delivery yields one canonical evidence
identity and explicit status, with no silent drop and no speculative business
meaning.

## Stage 3: matching, cash flow, and ledger safety

**Existing:** bank cash-flow projection, balanced journal projection,
bank-receipt matcher, matched-purchase writer, ACTIVE supersessions, and
canonical spending purchase/return grains.

**Missing:** operational proof that recovery and repeated processing preserve
one-economic-purchase semantics across FNS-only, bank-only, matched,
duplicate, refund, ambiguous, and superseded cases.

**Smallest change:** add only focused guards or tests exposed by the baseline.
Reuse the public authoritative matcher/writer and never add a parallel
accounting path.

**Tests/gates:** disposable PostgreSQL matrix covering FNS+bank matched,
FNS-only, bank-only unclassified, duplicate notification, idempotent replay,
ambiguous match, A->B->C ACTIVE supersession, returns/refunds, item fan-out,
multi-currency, and decimal boundaries.

**Exit proof:** one matched purchase has one funding fact and one ACTIVE
monetary ledger entry; receipts enrich but do not add money; superseded rows
remain immutable; unresolved bank-only movement is visible but excluded from
certified acquisitions unless independently proven.

## Stage 4: certification freshness and recovery

**Existing:** authoritative source-state fingerprint, exact-decimal
certification, bounded materialization guard, current-snapshot reader, READY/
STALE/MISSING/CONFLICT/CORRUPT statuses, and read-only query API.

**Missing:** safe operational freshness detection after new ingestion and a
reviewed policy for when a new materialization may be approved.

**Smallest change:** read-only freshness monitoring and an explicit operator
runbook; do not schedule or automatically write certification yet.

**Tests/gates:** disposable PostgreSQL tests for unchanged READY, ingestion
stale, missing, corrupt/conflicting exact run, concurrent source change,
bounded timeouts, no writes on all failure paths, and unchanged history.

**Exit proof:** no stale or foreign snapshot is reported as current; every
materialization has a fresh source-state preflight, explicit approval,
transactional rollback, and read-only postcheck.

## Stage 5: operational observability and controlled rollout

**Existing:** application logger conventions, Android diagnostics, CI, migration
and backup procedures, and safe production runbooks.

**Missing:** one dashboard/alert contract for lag, permanent rejection,
unresolved money, stale certification, duplicate pressure, and protected
ledger conflicts.

**Smallest change:** safe aggregate metrics and runbooks using existing logging
and monitoring, not a new telemetry service.

**Tests/gates:** redaction tests, bounded log fields, alert-threshold tests,
failure drills on a disposable clone, backup/restore rehearsal, and review of
least-privilege access.

**Exit proof:** operators can distinguish ingestion outage, parser gap, stale
snapshot, unresolved evidence, and accounting conflict without reading raw
financial payloads.

## Stage 6: automatic matching in shadow mode

**Existing:** the authoritative bank-to-receipt matcher, matched-purchase
writer, enrichment/provenance contracts, ACTIVE-ledger supersession rules,
current-snapshot guard, and controlled one-by-one production evidence. Do not
create a second matcher or writer.

**Missing:** a bounded worker/orchestration path that continuously discovers
new eligible evidence, evaluates it idempotently, and can recover without
turning ambiguity into a write.

**Smallest change:** add a manually enabled, then continuously runnable,
read-only/shadow processing loop around the existing authoritative matcher.
It must use a durable cursor or bounded source window, stable match and
enrichment identities, server-side scope authorization, and a finite batch
size/time budget. In shadow mode it produces safe decisions and metrics only;
it does not invoke the writer.

**Required decision states:** `PERSIST_REQUIRED`,
`NOOP_ALREADY_PERSISTED`, `BLOCKED`, `AMBIGUOUS`, `UNMATCHED`, and
`INELIGIBLE`. Only an authoritative `PERSIST_REQUIRED` decision may proceed
to the later writer stage; all other states remain visible and fail closed.

**Recovery/rollback:** retries reuse the same identity, never reprocess an
unbounded history, resume from a durable checkpoint, and stop on source-state
drift, conflicting provenance, timeout, serialization failure, or any partial
write. The existing writer transaction is the only write boundary; failed
items are retryable without deleting immutable evidence.

**Tests/gates:** disposable PostgreSQL tests for concurrent workers, duplicate
notifications, duplicate receipts, FNS+bank matching, FNS-only, bank-only,
ambiguous candidates, protected/superseded ledger history, timeout/rollback,
source-state drift, bounded resume, and exact idempotent replay. Run a
long-running shadow soak with safe aggregate counts and no raw evidence.

**Observability:** measure capture-to-match lag, eligible/blocked/ambiguous
counts, retry age, permanent failures, writer-eligible decisions, and source
drift. Redact payloads, balances, account/card references, secrets, and
source-event identifiers.

**Exit/activation gate:** no automatic production writer is enabled until the
shadow results are reviewed, the clone gates pass, recovery is rehearsed, the
operational owner approves bounded limits, and the user gives separate
explicit production authorization. Android delivery gaps remain explicit:
the collector cannot guarantee or reconstruct a notification that Android's
OS never delivered to the listener.

## Stage 7: automatic certification freshness and controlled activation

**Existing:** the authoritative source-state fingerprint, exact-decimal
certification projection, guarded materializer, current-snapshot reader,
freshness statuses, and immutable historical runs.

**Missing:** a continuously runnable freshness controller that notices source
changes and safely materializes one current full READY snapshot without stale
or duplicate runs.

**Smallest change:** reuse the existing read-only freshness probe and guarded
materializer in a bounded controller. On each cycle it must take one
repeatable-read preflight, compute the authoritative source state once, and
materialize only when the state is approved and not already covered by an
exact unbounded READY run. The controller must not use latest-run timestamps,
`replace=true`, or a second certification algorithm.

**Source-state/idempotency contract:** the writer rechecks the expected key
inside its serializable transaction, inserts immutable run/fact/result rows
atomically, reuses an exact current run, and fails closed on missing,
conflicting, corrupt, non-READY, or stale state. A source change between
preflight and commit aborts without partial rows. One in-flight run per scope
is enforced by existing locking/idempotency semantics.

**Bounded processing and recovery:** finite transaction, statement, lock, and
overall timeouts; no unbounded retries; retry only after a fresh read-only
preflight; rollback on failure; safe backoff and alerting on repeated failure;
historical runs remain immutable. A committed run receives an independent
read-only postcheck and is never deleted by recovery.

**Tests/gates:** disposable PostgreSQL tests for unchanged READY reuse,
initial MISSING materialization, concurrent controllers, source drift,
in-flight SQL timeout, injected rollback after run/facts/results, corrupt or
foreign exact runs, per-currency reconciliation, unchanged history, and
reader compatibility. Clone soak tests must show no unbounded queue or run
fan-out.

**Monitoring:** current/stale age, source-state mismatch, run status, fact and
result counts, duration, retries, lock/timeout failures, and reconciliation
disagreements are safe aggregate signals. Never log raw financial evidence.

**Activation gate:** this controller remains disabled until Stage 6 and Stage
7 clone/soak evidence, backup/restore and rollback procedures, least-
privilege roles, alert ownership, and a production read-only rehearsal are
reviewed. Enabling automatic certification requires a separate explicit user
approval and a documented rollback/disable procedure. No current plan grants
that approval.

## P0 end-state acceptance

P0 is complete only when the system continuously runs the existing capture,
ingestion, matching, writer, ACTIVE-ledger, and certification mechanisms with
bounded retries and observable recovery; every eligible automatic match is
idempotent and provenance-checked; every certification is current for its
authoritative source state or explicitly reports non-READY; and no Android,
provider, scope, or bank-only completeness limitation is hidden. Certified
spending remains distinct from all personal spending, and unresolved evidence
remains visible rather than silently excluded.

## Deferred P1 work

Product categorization, richer analytics convenience, MCP transport and
assistant workflows are P1. They cannot bypass P0 freshness, deduplication,
ledger, authorization, and completeness gates. PR #152 remains open and
unmerged; its code is not an authorization to deploy or publish data.

## Change control

Every meaningful stage must update the handoff in a separate reviewed PR.
Before any production mutation, record exact master, backup, source state,
scope, approval, timeout, rollback, and postcheck evidence. If a gate is
missing or contradictory, stop rather than guessing.

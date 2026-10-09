# BUHGUY P0 Reliability Plan

This is the execution plan for making `buhguy` reliably process evidence from
capture through certified accounting. It does not authorize production writes,
deployment, migration, grants, replay, backfill, or automatic certification.
Each stage requires its acceptance gates before the next stage starts.

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

## Deferred P1 work

Product categorization, richer analytics convenience, MCP transport and
automatic assistant workflows are P1. They cannot bypass P0 freshness,
deduplication, ledger, authorization, and completeness gates. PR #152 remains
open and unmerged; its code is not an authorization to deploy or publish data.

## Change control

Every meaningful stage must update the handoff in a separate reviewed PR.
Before any production mutation, record exact master, backup, source state,
scope, approval, timeout, rollback, and postcheck evidence. If a gate is
missing or contradictory, stop rather than guessing.

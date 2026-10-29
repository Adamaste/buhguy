# Sensitive bank authorization notification screening v1

## Scope

This change screens the four text values that the Android mapper currently
places in the event payload: title, text, big text/description, and subtext/
reference. It does not change provider normalization, purchase classification,
bank-only accounting, receipt matching, or the event schema.

The detector is deliberately content-minimizing: it returns only a boolean.
It recognizes explicit Russian and English one-time/verification/authorization
message wording and code wording, instructions not to share a code, a short numeric value
written directly as a code or password, and a mapped text field consisting
only of a short numeric string. An operation/transaction/reference
code is excluded from the short-number rule so ordinary bank references do
not get rejected merely for containing a number.

If any mapped field matches, the whole notification is discarded. The code
does not strip a code and retain the surrounding operation text as purchase
evidence. The detector never returns the matched substring or a reason that
contains source text.

## Capture and server boundaries

1. Android screens the allowlisted notification before lifecycle ID creation,
   optional diagnostics, mapper serialization, and Room insertion. A blocked
   event produces only a generic local status/log marker. The outbox is not
   created, and no HTTPS request is queued.
2. `NotificationCapture` repeats the screen as a defensive boundary for any
   caller that bypasses the listener.
3. The server scans validated scalar values, including payload strings, event
   identity, and allowed metadata, before source lookup/insertion of an
   observation payload. A match returns HTTP 422 with the constant code
   `SENSITIVE_AUTH_NOTIFICATION`; neither the response nor application logs
   contain notification text.
4. Android treats this 422 as permanently rejected and records only the
   constant reason code. It does not retry the same sensitive pending event
   indefinitely. Transient network/5xx responses retain the existing retry
   behavior.
5. A pre-existing PENDING row whose JSON cannot be safely parsed is not sent
   or deleted. It moves to `HELD_FOR_REVIEW` with a generic reason, and the
   diagnostics screen shows only the aggregate held count; no event content,
   identifier, or bank text is exposed there.

The normal payload contract, other-bank normalization, lifecycle identity,
bank-only writer, and FNS matcher are unchanged.

## Limits and risk

This is a high-confidence text-pattern filter, not a guarantee that every
bank can never encode a code in an unknown format. A novel or obfuscated code
format may need a narrowly reviewed detector update. The server backstop
cannot prevent the network request itself, so the Android pre-Room filter is
the primary privacy boundary. Conversely, filtering can drop an uncommon
ordinary notice that explicitly presents a short value as a code; the rule is
kept narrow and operation-reference wording is allowed. Ambiguous text is
never normalized into a purchase by this change.

## Previously stored data and cleanup gate

No historical row or device outbox record is modified by this change. The
current Room DAO retains SENT, permanently rejected, and held rows; the app
exposes aggregate PENDING and HELD_FOR_REVIEW counts only. It has no row-scrub
operation. The server stores accepted
payload JSON in `bank_event_observations`, and the same payload participates
in its stored hash/deduplication evidence. A server 422 prevents a new payload
insert but does not erase an older Android outbox row or a previously stored
observation.

Any cleanup requires a separate approved procedure:

1. Inventory candidate rows using an in-process scan that emits only counts
   and opaque row IDs; never export or print field values.
2. For Android, distinguish PENDING, SENT, and permanently rejected records
   locally without exporting the Room database. Re-test each candidate and
   ordinary control records before changing anything. Preserve ordinary rows.
3. For PostgreSQL, rehearse an exact-row remediation on an isolated restored
   copy. Preserve normalized transaction/accounting links and idempotency
   behavior while recording a redaction audit marker. The immutable payload
   and payload hash contract means a direct blind UPDATE/DELETE is not an
   approved cleanup method.
4. Include encrypted backups, replicas, WAL/archive retention, and device
   backups in the retention plan. A new backup made before cleanup also
   contains the old payload; do not create one casually as a cleanup step.
5. Obtain separate approval for any on-device scrub, database redaction,
   backup expiry, WAL retention change, or physical storage reclamation.

No cleanup, production mutation, backup operation, Android installation,
backfill, migration, merge, or GitHub Actions run is part of this PR.

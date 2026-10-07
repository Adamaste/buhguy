# Controlled Matched-Purchase Canary v1

This runbook authorizes preparation for exactly one future canary execution.
It does not execute the writer, deploy code, replay history, backfill data, or
change production.

## Preconditions

- Run the exact master implementation `4dfea0c5159541d668c5ab1a008dd22f09943de7`.
- Confirm master CI `37604435364` is green, including PostgreSQL integration,
  full suite, Android, and signed Android.
- Require schema migration 018 and the current production identity snapshot.
- Use Person 1 scope `default` with
  `internalTransferMaxTimeDeltaMs=5000` and
  `receiptMaxTimeDeltaMs=300000`.
- Use an explicitly read-only production database path for the precheck.
- Do not invoke `persistMatchedPurchase` during preview or selection.

## Selected Canary

The fresh exact-master preview was run twice in separate
`REPEATABLE READ READ ONLY` transactions. It returned 32 eligible
`PURCHASE / DEBIT` bank rows, 12 isolated matches, 12
`PERSIST_REQUIRED` decisions, all 12 with
`REFINE_EXISTING_FISCAL_FUNDING`, zero blocked/ambiguous/review-required
decisions, and 12 FNS-derived RUB resolutions. Both runs were identical and
all persistence and account-identity snapshots were unchanged.

The deterministic selection rule is smallest absolute event-time delta, then
lowest bank transaction id. The selected pair is:

- bank transaction: `164`
- receipt: `15857`
- match key: `a9116c9acba5516bf954cc377797efa01cbf91ead36b93340b27d1c43638180e`
- purchase event: `297272`
- existing standalone ledger entry: `3158966`
- financial account: `4`
- amount/currency: `2200.00 RUB`
- absolute event-time delta: `125 ms`
- enrichment key: `a4a7e1e4c79b9bdbe1fa9791a6d293ec1bf8c5f861ab6c75b6711f6636f3a070`
- orchestration key: `20d297b17b49e9af2894958f7782e8dece84db62b4c343ee01040aba015cb909`
- receipt currency basis: `FNS_SOURCE_CONTRACT`

The precheck proved no existing bank-receipt match, bank evidence row, or
supersession for this pair; one active standalone fiscal ledger entry exists,
its postings are balanced, account 4 is concrete and OWNER-qualified in the
same scope, and the one-hour matching recheck found no competing edge.

## Required Backup and Pre-write Snapshot

Before any future writer call, create and verify the existing reviewed
production backup. Record a safe snapshot of the selected scope covering:

- `bank_receipt_matches`
- `business_event_bank_evidence`
- `ledger_accounts`
- `ledger_entries`
- `ledger_postings`
- `ledger_source_links`
- `ledger_entry_supersessions`
- `certification_facts`
- `reconciliation_runs`
- `reconciliation_results`
- relevant business-event evidence and account-resolution rows

The snapshot must contain exact row counts and deterministic hashes, without
printing raw payloads, credentials, account/card references, or source-event
content. Abort if the selected match, enrichment key, orchestration key,
standalone entry, account identity, or any required precondition differs.

## One-call Execution and Acceptance

Only after an explicit execution approval, invoke the public authoritative
writer once for the selected `matchKey`, using the exact reviewed scope and
freshly revalidated inputs. Do not invoke it for any of the remaining eleven
matches.

Accept only if the single transaction creates or reuses exactly one immutable
bank-receipt match, one purchase bank-evidence row, one deterministic
bank-funded ACTIVE ledger entry, and one append-only supersession from ledger
entry `3158966`. The old standalone entry, postings, and source links must
remain byte-for-byte unchanged. Certification must read ACTIVE state and must
not retain duplicate fiscal funding.

Replay the same public writer call only after the first result is fully
validated. It must return the same match/event/ledger/enrichment identities and
create no additional semantic rows, postings, source links, or supersession.
Any disagreement, ambiguity, conflict, changed source state, or non-idempotent
result is a STOP condition.

## STOP Conditions and Restoration

STOP before the writer if the read-only preview is not `READY`, the selected
pair is not `PERSIST_REQUIRED` with `REFINE_EXISTING_FISCAL_FUNDING`, the
match key is stale, the account is not concrete OWNER-qualified, the FNS
currency resolution is not `RUB / FNS_SOURCE_CONTRACT`, or any competing
edge appears.

STOP after any failed or partial writer call. Do not retry blindly. Preserve
the transaction error and compare the exact post-call snapshot with the
pre-write snapshot. Restoration may use only the separately reviewed backup
and rollback procedure; do not delete or manually repair rows, and do not
replay/backfill unrelated history.

The canary is one operation, one writer transaction, one selected match. No
additional canary or remaining eleven matches are authorized by this document.

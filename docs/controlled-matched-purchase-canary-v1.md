# Controlled Matched-Purchase Canary v1

This runbook records the controlled execution of exactly one matched-purchase
canary. It does not authorize additional matches, a runtime deployment,
historical replay, or backfill.

## Preconditions

- Run the exact master implementation `84e9f3e107633def1efdd6888c51614fd1230df4`.
- Confirm master CI `37618422142` is green, including PostgreSQL integration,
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

The historical pre-canary precheck proved no existing bank-receipt match, bank
evidence row, or supersession for this pair; one active standalone fiscal
ledger entry existed, its postings were balanced, account 4 was concrete and
OWNER-qualified in the same scope, and the one-hour matching recheck found no
competing edge.

## Required Backup and Pre-write Snapshot

Before the completed writer call, a fresh reviewed production backup was
created and validated. The selected scope snapshot covered:

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

The backup was nonzero, owned by `postgres:postgres`, mode `0600`, passed
`pg_restore --list`, and had SHA-256
`3d9c743f1ab573809b8dd68967fe3cfea863fa569e99eccb47337634009f3a5d`.
Snapshots contained exact row counts and deterministic hashes without
printing raw payloads, credentials, account/card references, or source-event
content.

## Completed One-call Execution and Acceptance

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

The post-fix public writer replay returned the same match/event/bank-evidence/
ledger/enrichment identities. It created no additional semantic rows,
postings, source links, or supersession. Certification run `3848`, its facts,
and its results were byte-identical before and after the replay.
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

The canary was one operation, one writer transaction, and one selected match.
No additional canary or remaining eleven matches are authorized by this
document.

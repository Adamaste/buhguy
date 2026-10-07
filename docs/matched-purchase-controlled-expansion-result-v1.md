# Controlled Matched-Purchase Expansion Result v1

## Execution boundary

The controlled expansion ran from exact master
`25883d586654194d899ea6cbfea06c4beafd76b6`, with the active production
bank-ingestion runtime left at `8e18a9d65c933045820b0771afbcdd1c28546956`.
The production sync timer was frozen only for the operation and restored to
its original enabled/active state. The ingestion service was not stopped.

Before execution, a fresh PostgreSQL custom-format backup was created and
validated:

- file: `/var/backups/receipt-collector/postgres/finance_receipt_collector-20261007T150545Z.dump.gz`
- mode/owner: `600`, `postgres:postgres`
- gzip and `pg_restore --list`: PASS
- SHA-256: `070db017194259646e806125a84490cfc5bb273ee8538a631943556b759068f0`

The baseline ACTIVE-ledger source state was stable across two repeatable-read
read-only reads. Certification run `3859` was materialized as a coherent
`READY` snapshot, and a direct same-state refresh returned
`reused=true`/`refreshed=false`.

## Authorized execution

The existing canary `164` was excluded from expansion. The following 12
reviewed bank transaction IDs were processed in the approved order:

`111, 326, 112, 394, 305, 95, 177, 291, 245, 299, 182, 81`

Each item used the public `persistMatchedPurchase` API exactly once, followed
by exactly one identical public replay. No custom loader, test hook,
`failAfter`, SQL write, bulk insert, replay/backfill, accounting catch-up, or
deployment was used.

All 12 items completed with `PERSIST_REQUIRED` and
`REFINE_EXISTING_FISCAL_FUNDING` before the first write. Each item converged
to one match, one bank-evidence row, one append-only supersession, one ACTIVE
bank-funded ledger entry, and a coherent `READY` certification state. The
existing standalone fiscal entries and their postings/source links remained
immutable history.

| bank transaction | match | event | active ledger | old standalone | supersession |
| --- | ---: | ---: | ---: | ---: | ---: |
| 111 | 2 | 277868 | 4199237 | 2956175 | 2 |
| 326 | 3 | 347819 | 4199238 | 3683696 | 3 |
| 112 | 4 | 277867 | 4199239 | 2956174 | 4 |
| 394 | 5 | 396140 | 4199240 | 4186824 | 5 |
| 305 | 6 | 341535 | 4199241 | 3617983 | 6 |
| 95 | 7 | 272286 | 4199242 | 2897763 | 7 |
| 177 | 8 | 293868 | 4199243 | 3123793 | 8 |
| 291 | 9 | 325247 | 4199244 | 3448493 | 9 |
| 245 | 10 | 309748 | 4199245 |  | 10 |
| 299 | 11 | 330351 | 4199246 |  | 11 |
| 182 | 12 | 294058 | 4199247 |  | 12 |
| 81 | 13 | 305967 | 4199248 | 3248897 | 13 |

## Final invariants

- `AUTHORIZED_ITEM_COUNT=12`
- `ATTEMPTED_ITEM_COUNT=12`
- `SUCCESSFUL_ITEM_COUNT=12`
- `FAILED_ITEM_COUNT=0`
- `STOPPED_EARLY=NO`
- `FINAL_REVIEWED_PERSISTED_MATCH_COUNT=13` including the original canary
- `UNREVIEWED_MATCHES_PERSISTED=0`
- `PREVIOUSLY_UNMATCHED_PURCHASES_PERSISTED=0`
- `FINAL_DOUBLE_COUNT_DETECTED=NO`
- `FINAL_LEDGER_INVARIANTS=PASS`
- `FINAL_CERTIFICATION_COHERENT=PASS`

The final certification source state is
`dfaca835c8a9c9678fd778a8e04783940a7f0053d42edc5b1ce305cbbd02f2aa`,
with `READY` run `3871`. It contains 5837 current facts, all associated with
that source state, and 8 distinct reconciliation results. The canary has no
active `FISCAL_NEW_MONEY` fact. Every persisted expansion event has exactly
one ACTIVE `SYSTEM_DERIVED` ledger entry with two balanced postings and one
supersession.

The execution completed with `EXPANSION_RESULT=GREEN`. The only production
mutation was the 12 explicitly authorized public-writer executions and their
idempotent replays; no deployment, historical replay, backfill, or accounting
catch-up occurred.

`NEXT_ACTION=CONTROLLED_EXPANSION_CLOSEOUT_REVIEW`

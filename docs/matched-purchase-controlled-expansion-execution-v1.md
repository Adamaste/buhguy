# Matched-Purchase Controlled Expansion Execution v1

Status: design-only and read-only review. This document does not authorize
writer execution.

## Reviewed state

The review used exact master
`a6233f13c31787d289ce9d275f2df4cbe3fb49ee`; its push CI run
`37633007684` passed the PostgreSQL integration gate, full suite, Android, and
signed Android jobs. The active production release remains
`8e18a9d65c933045820b0771afbcdd1c28546956`.

The previous canary is the only persisted matched purchase:

- bank transaction `164`, receipt `15857`, event `297272`;
- match `1`, bank evidence `1`;
- standalone ledger `3158966` was superseded by active ledger `4168251`;
- exactly two balanced postings remain active;
- canonical receipt currency remains NULL;
- no active `FISCAL_NEW_MONEY` funding remains for the purchase.

The canary is excluded from expansion. The current read-only population is 13
matched pairs: one `NOOP_ALREADY_PERSISTED` canary and 12
`PERSIST_REQUIRED`/`REFINE_EXISTING_FISCAL_FUNDING` candidates. Two separate
`REPEATABLE READ READ ONLY` transactions produced identical previews with
`scopeKey=default`, `internalTransferMaxTimeDeltaMs=5000`, and
`receiptMaxTimeDeltaMs=300000`.

## Current ordered candidate set

The order is operational only: absolute event-time delta ascending, then
`bankTransactionId` ascending. It is not a confidence score.

| Order | Bank transaction | Receipt | Event | Old ledger | Financial account | Amount | Currency | Delta ms | Decision | Ledger disposition | One-hour isolated |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- | ---: | :--- | :--- | :--- |
| 1 | 111 | 15848 | 277868 | 2956175 | 4 | 1193.06 | RUB | 1136 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 2 | 326 | 15991 | 347819 | 3683696 | 4 | 61.40 | RUB | 1800 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 3 | 112 | 15847 | 277867 | 2956174 | 4 | 2029.99 | RUB | 9559 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 4 | 394 | 16001 | 396140 | 4186824 | 4 | 400.41 | RUB | 17390 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 5 | 305 | 15988 | 341535 | 3617983 | 4 | 103.92 | RUB | 32231 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 6 | 95 | 15846 | 272286 | 2897763 | 4 | 1830.00 | RUB | 33941 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 7 | 177 | 15855 | 293868 | 3123793 | 4 | 876.00 | RUB | 49767 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 8 | 291 | 15863 | 325247 | 3448493 | 4 | 523.00 | RUB | 52921 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 9 | 245 | 15861 | 309748 | 3288018 | 4 | 5500.00 | RUB | 54838 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 10 | 299 | 15864 | 330351 | 3501360 | 4 | 614.00 | RUB | 55805 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 11 | 182 | 15856 | 294058 | 3125747 | 4 | 5264.32 | RUB | 85265 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |
| 12 | 81 | 15859 | 305967 | 3248897 | 4 | 3100.00 | RUB | 226847 | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | YES |

All candidates resolved currency through `FNS_SOURCE_CONTRACT`, have concrete
same-scope account `4`, and had no existing match, bank evidence, or
supersession. Their `matchKey`, `enrichmentKey`, and `orchestrationKey` are
captured by a fresh pre-write preview and must not be copied from this design
document as authorization.

## Diagnostic window

The one-hour diagnostic used `receiptMaxTimeDeltaMs=3600000` without changing
the production policy. It returned the same 13 matched pair identities,
`ambiguousBankPurchases=0`, `ambiguousReceipts=0`, and no new competing edge.
The current diagnostic population has 19 unmatched eligible bank purchase rows;
all 19 have no compatible eligible receipt within one hour. The observed
unmatched-receipt count is 1837 and eligible receipt count is 1850. No evidence
supports widening the five-minute production policy.

## Execution shape, if separately approved

- mode: `ONE_BY_ONE`;
- batch size: `1`;
- stop on first failure: `YES`;
- do not freeze bank ingestion unless new evidence proves it necessary;
- freeze `receipt-collector-sync.timer` for the controlled window only;
- do not kill an already-running sync oneshot; wait for natural completion;
- record the original timer state and restore it exactly in mandatory cleanup.

Before the first item, verify the source state is stable and materialize a
coherent READY certification snapshot for the current ACTIVE ledger state. The
fresh review observed timer state `enabled/active` with the oneshot service
inactive at `2026-10-07T17:10:25+03:00`.

## Per-item pre-write gate

Before every future writer call, re-run the authoritative five-minute preview
and the one-hour diagnostic. Require the same isolated pair and exact
`matchKey`, `enrichmentKey`, and `orchestrationKey`; `READY`,
`PERSIST_REQUIRED`, and `REFINE_EXISTING_FISCAL_FUNDING`; one balanced active
standalone ledger entry; no existing match, bank evidence, or supersession;
concrete same-scope OWNER-qualified account; stable FNS RUB resolution; and a
coherent current ACTIVE-ledger certification state. Any difference is STOP.

## Per-item acceptance and replay

An approved first write must create or reuse exactly one match, one bank
evidence row, the existing purchase event, one bank-funded ACTIVE ledger entry,
two balanced postings, and one append-only supersession from the old standalone
entry. Old entry/postings/source links remain immutable; exactly one ACTIVE
SYSTEM_DERIVED entry remains; no active fiscal-new-money funding or double
count may appear.

Only after all first-write checks pass may one identical replay be considered.
Replay must return identical semantic ids and enrichment identity, keep the
post-write source state unchanged, reuse the same certification run, and leave
the run, facts, results, matched-purchase state, and ledger state byte-identical
with zero additional rows. Only then may the next item be reviewed.

Each first write legitimately changes the ACTIVE source state:

`item N old source state -> item N new source state`

The replay must be a certification NOOP on that new state. Item `N+1` may then
create another newer coherent certification state. Unrelated source drift,
certification disagreement, ambiguity, conflict, nondeterminism, or double
funding is an immediate STOP condition.

## Backup and recovery

Before any separately approved window, take and validate one fresh full backup.
Capture deterministic per-item BEFORE snapshots and hashes. Do not design an
automatic whole-database restore after an item failure: normal ingestion may
continue, and restoring an old backup could destroy unrelated later evidence.
A writer transaction is expected to roll back its own partial mutation on
failure. Preserve the exact failure evidence, perform no manual DELETE/UPDATE
repair, and review any restoration or repair separately.

## Completion criteria

If all currently eligible candidates are separately approved and complete, the
persisted matched-purchase count must equal the existing canary plus only the
successfully authorized items. Every refined purchase must have one active
bank-funded ledger entry, immutable superseded standalone history, coherent
certification, and no double funding. No unreviewed candidate may be written.

This document does not authorize execution, writer invocation, deployment,
replay, backfill, accounting catch-up, or production mutation.

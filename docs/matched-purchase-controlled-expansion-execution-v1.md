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

The corresponding content-addressed identities, in the same order, are:

| Order | Match key | Enrichment key | Orchestration key |
| ---: | :--- | :--- | :--- |
| 1 | `46ba405f907d17960dfd433754cc2fc76e9e7592cfb469932d7eab4d82b8c76a` | `df592bbccf4a62a46df67a9a55ef517262c83a68a661fe3daca54aa40b929c2b` | `3f5348fb66fcc16de9869ac309d8008804d5ede7998625b9b281220dac47b7ab` |
| 2 | `672debe7d538850a496cd0921eabf2d3b1914e824dc377df6e020c2d3ad4bbcb` | `8b48c2e8a11034a70693e58fce22e656a90e8a855607a0f5ef437132fef728d9` | `a0179fc3ae42b3cbb421195341fa5dd543cb2f49e8a3bc1ad4a32dde3aa8074c` |
| 3 | `ffffeb5702890e26cc9e2964bae313b5f97da46def845335f0dcf07e4c3c4b13` | `a734f794254378d69e87eb3b5f4e64533a3caa3a1d3590a6f3cb93335277be36` | `dd717f414763dc9010ff652e324500094c843b4d0c76a3381bbc82a3c6ef2111` |
| 4 | `6db8cdb8d94e8497a3f86299294ed6563ce2e410f9c21b97438153fb22ede2a4` | `c51c013da3016f4d00e64f43c61b3daba977c4e07f868f81a4fb327bd715c02b` | `5e1fec1ad2e4a10b2b54b565c03e2eb5c59d04af359cdb22a8c8a9081cfc170d` |
| 5 | `420628dabf272f4a4777479a3b57188b862f1f90f80fdf789313b870418c97c8` | `21b01b26c6748bdc983c605d584690383be642736df5652d4ce31453a397f868` | `fa325f51984a05d9e5f1c82cf838c98b6898220765e611b097644cc8e3ed33dd` |
| 6 | `a64f7cbe24ad7ffafaf486f88ef65471cdf29ea7c6c2b03a769ab71aa3933d7b` | `7d298e86d1f7609d140c06400c35e379054d9d7167b14ec6a60e41504995a0b1` | `30d6b5b0b2aafb8ac4e97591c19a9a80679ea2683067b37f00275d32bd13de5e` |
| 7 | `6efeef7ad0d5f37a9faa0ee92a65bb133869d922250397c4cdbced560b1359a8` | `e66464b9401ad1a4098700910f35c06734405fd92b1baf99e3021713d553baae` | `26b25afc2e65fa16334c274f56e89ca908ea3a2bd925786ae82e0ae9fae43430` |
| 8 | `cc3d52c9a76014b2072c62ab671b20c0c884d002133faf2ae69157b8ccf7207a` | `f1a838231546a089895b7dd1b5028ee8898d408c7360b1bff410527a57a31c44` | `6a7c647119403d6f720dee413b8b8f582babd462b262358298f7134a74f7579f` |
| 9 | `0ea1ae3c2991aca568b4e0209dc15a069f96afefda8b5b4ea481e808e8439536` | `5c440925081da2e2d734d3ba3a34a4eb01e6a043894060a597e58e91825b23b7` | `89a783f7817816664e0246d64a6f253a18c8af491b6ab075d9d05c704022aedc` |
| 10 | `088992fe839b2fd21da6e041f6d81045903baac7eaae189bd8cd615722760ea8` | `e52bec66aff96b76cf5e161fe456de3e5d633462701994d0e4bfe8275770b12a` | `ae0c9acf61764884fb49fedda4dc24aefb4497bfe4e29432016cb0919e09b261` |
| 11 | `8ffc314dd19ffad695061735940c37f3c8f66e4a081b4468f328a57fd3d0c22a` | `a6b07d1f30a6cdf60fc237c35ec7a295c5e4cd1da7ba6c2e87261aafa77730cf` | `71d8f306c42b7789e3e2becee40a2021b2794d245cd05c80c439711a49ad4d53` |
| 12 | `61b1d3d4e82921f385dc439973cd170a85d65e83d29b67756e7aaa0928a19e6a` | `131fcc30eb55396f82d15aceb136fda0b7d3b387a265463d8e0e1caa8bf0f241` | `5f0631f248add3a1411e2f1f6e0f8487f0542f9964605184e84916bd5a899296` |

All candidates resolved currency through `FNS_SOURCE_CONTRACT`, have concrete
same-scope account `4`, and had no existing match, bank evidence, or
supersession. Their `matchKey`, `enrichmentKey`, and `orchestrationKey` are
captured by the reviewed preview; a future execution must revalidate them
fresh and must not treat this design document as authorization.

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

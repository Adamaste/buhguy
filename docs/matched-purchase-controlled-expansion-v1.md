# Matched-Purchase Controlled Expansion v1

## Status

This is a read-only design for execution review. It does not authorize a
writer call, automatic rollout, deployment, replay, backfill, accounting
catch-up, or identity mutation.

## Baseline

- Exact master: `b0f1e8222bd84a1a8923c1285871ee67d5a8dd67`
- Master CI: `37630473236`, SUCCESS
- Active production runtime: `8e18a9d65c933045820b0771afbcdd1c28546956`
- Receipt policy: `receiptMaxTimeDeltaMs=300000`
- Diagnostic window only: `3600000 ms`
- Internal-transfer parameter: `internalTransferMaxTimeDeltaMs=5000`
- Persisted canary: bank transaction `164`, receipt `15857`, event `297272`,
  active ledger entry `4168251`
- Canary status: GREEN, with no double funding

The active runtime is intentionally not the current master. A broader runtime
rollout remains a separate reviewed task because it contains unrelated runtime
and bank-normalization changes.

## Preview Result

Two fresh exact-master `REPEATABLE READ READ ONLY` previews produced identical
results:

- current MATCHED pairs: 13
- already-persisted canary pairs: 1
- current expansion candidates: 12
- PERSIST_REQUIRED: 12
- REFINE_EXISTING_FISCAL_FUNDING: 12
- BLOCKED: 0
- ambiguous matched pairs: 0
- new one-hour competing edges: 0

The canary was excluded because it resolved to
`NOOP_ALREADY_PERSISTED`, match id `1`, event id `297272`, and active ledger
entry `4168251`. The current population is 12, not the historical 11-count
snapshot from immediately after the canary; one additional exact pair is now
present in production. No writer was invoked during this review.

## Candidate Structural Summary

All rows below are safe structural fields from the two identical previews.
They contain no notification payloads, seller fiscal identity, source-event
content, account/card references, credentials, or secrets.

| bank tx | receipt | amount | currency | abs delta ms | event | standalone ledger | financial account | receipt currency basis | decision | ledger disposition | risk |
| ---: | ---: | ---: | :--- | ---: | ---: | ---: | ---: | :--- | :--- | :--- | :--- |
| 299 | 15864 | 614.00 | RUB | 55805 | 330351 | 3501360 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 245 | 15861 | 5500.00 | RUB | 54838 | 309748 | 3288018 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 305 | 15988 | 103.92 | RUB | 32231 | 341535 | 3617983 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 111 | 15848 | 1193.06 | RUB | 1136 | 277868 | 2956175 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 81 | 15859 | 3100.00 | RUB | 226847 | 305967 | 3248897 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 326 | 15991 | 61.40 | RUB | 1800 | 347819 | 3683696 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 394 | 16001 | 400.41 | RUB | 17390 | 396140 | 4186824 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 177 | 15855 | 876.00 | RUB | 49767 | 293868 | 3123793 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 182 | 15856 | 5264.32 | RUB | 85265 | 294058 | 3125747 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 95 | 15846 | 1830.00 | RUB | 33941 | 272286 | 2897763 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 291 | 15863 | 523.00 | RUB | 52921 | 325247 | 3448493 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |
| 112 | 15847 | 2029.99 | RUB | 9559 | 277867 | 2956174 | 4 | FNS_SOURCE_CONTRACT | PERSIST_REQUIRED | REFINE_EXISTING_FISCAL_FUNDING | LOW |

Each candidate had one compatible edge at the five-minute policy window,
concrete same-scope financial-account identity, and no existing persisted
match, bank evidence, or supersession. The exact match, enrichment, and
orchestration keys are intentionally not copied into this design table; they
must be captured afresh during any future execution review.

## Recommended Rollout Shape

Recommendation: `ONE-BY-ONE`, effective batch size `1`.

For each candidate, in order selected by a separately reviewed deterministic
rule:

1. Capture a fresh source-state and selected-row precheck.
2. Confirm the pair is still MATCHED, isolated, READY, and
   `PERSIST_REQUIRED / REFINE_EXISTING_FISCAL_FUNDING`.
3. Confirm exact amount/currency, FNS currency basis, concrete OWNER-qualified
   account, balanced standalone ledger, and no existing persistence rows.
4. Capture the selected state and certification snapshot.
5. Invoke the public writer exactly once for that item.
6. Validate one match, one bank evidence row, one bank-funded ACTIVE ledger
   entry, one append-only supersession, balanced postings, and coherent ACTIVE
   certification.
7. Replay the same item only as its explicitly reviewed idempotency check.
8. Confirm semantic ids, source state, and protected history before considering
   the next item.

Stop immediately on the first failure. Never replace this with one bulk SQL
insert or a batch transaction that bypasses the public writer.

## STOP Conditions

Stop before any writer call for source-state drift, changed match/enrichment/
orchestration identity, ambiguity, competing edges, missing FNS proof,
non-RUB/malformed currency, unresolved or cross-scope account identity,
unbalanced standalone ledger, existing conflicting persistence, stale
certification, or any disagreement with the canary contract.

Stop after a failed or partial writer call. Do not retry blindly. Preserve the
transaction error and compare the complete post-call snapshot with the
pre-call snapshot. Do not repair by delete, replay, backfill, or manual SQL.

## Backup and Certification Handling

Use a fresh reviewed PostgreSQL backup before each authorized item. Use a
stable source-state window and exact-master `REPEATABLE READ READ ONLY`
prechecks. Certification must have one coherent READY run for the current
ACTIVE-ledger source state. A same-state replay must reuse the run without
changing run, fact, or result rows. A legitimate source-state change requires
recomputation and a new review; it is not permission to continue automatically.

## Unmatched-Window Diagnostic

The two read-only five-minute previews had 19 currently unmatched eligible
PURCHASE/DEBIT bank rows. At the one-hour diagnostic window:

- no compatible receipt within one hour: 19
- first compatible receipt at or below 5 minutes: 0
- greater than 5 and at or below 10 minutes: 0
- greater than 10 and at or below 15 minutes: 0
- greater than 15 and at or below 30 minutes: 0
- greater than 30 and at or below 60 minutes: 0
- ambiguous/multiple compatible receipts within one hour: 0

This diagnostic does not auto-match rows and does not change the reviewed
300000 ms policy. `WINDOW_POLICY_CHANGE_RECOMMENDED=NO`.

## Explicit Boundaries

This document is design-only. It does not authorize automatic rollout,
production writer execution, runtime deployment, replay/backfill, accounting
catch-up, identity mutation, schema changes, or persistence outside a future
separately reviewed one-item gate.

# Regression Matrix v3.1

The existing 25/25 test suite verifies collector behavior only; it is not accounting acceptance. The cases below are specified future accounting tests unless marked otherwise.

| # | Case | Expected | Status |
|---:|---|---|---|
| 1 | direct cash purchase | Dr expense / Cr cash | FUTURE |
| 2 | direct e-cash purchase | Dr expense / Cr bank | FUTURE |
| 3 | full prepayment | Dr advance / Cr cash | FUTURE |
| 4 | settlement using advance | Dr expense / Cr advance, no new cash | FUTURE |
| 5 | partial prepayment | bounded advance balance | FUTURE |
| 6 | many receipts to one purchase | explicit allocations | FUTURE |
| 7 | one purchase to many receipts | explicit allocations | FUTURE |
| 8 | identical repeat purchase | not merged | FUTURE |
| 9 | same amount/different goods | not merged | FUTURE |
| 10 | split delivery | fulfillment allocations | FUTURE |
| 11 | full return | bounded reversal | FUTURE |
| 12 | partial item return | item/quantity allocation | FUTURE |
| 13 | return of prepayment | advance/refund treatment | FUTURE |
| 14 | return against split fulfillment | correct target allocation | FUTURE |
| 15 | competing original purchase | unresolved | FUTURE |
| 16 | cancellation before fulfillment | reverse advance only if evidenced | FUTURE |
| 17 | gift certificate buy | Dr stored-value / Cr cash | FUTURE |
| 18 | gift certificate redeem | Dr expense / Cr stored-value | FUTURE |
| 19 | cashback received | explicit reward policy | FUTURE |
| 20 | credit purchase | Dr expense / Cr payable | FUTURE |
| 21 | credit repayment | Dr payable / Cr cash | FUTURE |
| 22 | mixed item payment types | item-level split | FUTURE |
| 23 | operationType 1 household direction | generally cash out | FUTURE |
| 24 | operationType 2 household direction | generally cash in | FUTURE |
| 25 | operationType 3 | seller expense, not household expense | FUTURE |
| 26 | operationType 4 | seller-expense reversal | FUTURE |
| 27 | missing component | missing state | FUTURE |
| 28 | zero component | explicit zero | FUTURE |
| 29 | FFD 1.05 | supported-field matrix | FUTURE |
| 30 | FFD 1.1 | supported-field matrix | FUTURE |
| 31 | FFD 1.2 | supported-field matrix | FUTURE |
| 32 | correction fiscal tag | FFD-aware correction | FUTURE |
| 33 | late/out-of-order settlement | deterministic rebuild | FUTURE |
| 34 | same merchant ref collision | unresolved | FUTURE |
| 35 | merchant ref reuse | scoped identity | FUTURE |
| 36 | Yandex market ref collision | no prefix AUTO | FUTURE |
| 37 | public INN resolution | provenance/version/confidence | FUTURE |
| 38 | generic service code | unresolved without evidence | FUTURE |
| 39 | parser version change | retain old interpretation | FUTURE |
| 40 | duplicate source delivery | idempotent | FUTURE |
| 41 | concurrent ingestion | one canonical event | FUTURE |
| 42 | DB failure mid-ingest | atomic retry | FUTURE |
| 43 | full rebuild equals incremental | exact equality | FUTURE |
| 44 | bank authorization then settlement | no duplicate card cash | FUTURE |
| 45 | own-account transfer | asset-to-asset only | FUTURE |
| 46 | cash withdrawal | bank to cash | FUTURE |
| 47 | cash deposit | cash to bank | FUTURE |
| 48 | bank fee | fee expense | FUTURE |
| 49 | interest income | income posting | FUTURE |
| 50 | correction after close | versioned restatement | FUTURE |
| 51 | timezone boundary | explicit policy | FUTURE |
| 52 | FX amount | currency/rounding policy | FUTURE |
| 53 | high-value ambiguity | blocks certification | FUTURE |
| 54 | zero-value receipt | explicit policy | FUTURE |
| 55 | invalid quantity | reject/unresolved | FUTURE |
| 56 | item rounding residual | bounded residual | FUTURE |
| 57 | item sum != total | reconciliation exception | FUTURE |
| 58 | raw missing | no certification | FUTURE |
| 59 | raw hash changed | new evidence version | FUTURE |
| 60 | account isolation | no cross-user merge | FUTURE |
| 61 | ownership change | explicit ownership event | FUTURE |
| 62 | backup/restore replay | same graph/ledger | FUTURE |
| 63 | auth outage | failed run, not empty success | EXISTING COLLECTOR TEST |

Only collector cases 18-25 in the current project test suite are executable today; the accounting expectations remain future acceptance criteria.

## Phase 1A Fiscal Evidence Deduplication

| ID | Case | Expected | Status |
|---|---|---|---|
| DEDUP-001 | Exact replay | one receipt/items/raw; second `created=0` | UNIT + PG INTEGRATION PASS |
| DEDUP-002 | Ten repeated replays | no duplicates | UNIT + PG INTEGRATION PASS |
| DEDUP-003 | New repository instance replay | no duplicates | UNIT + PG INTEGRATION PASS |
| DEDUP-004 | Concurrent replay | unique barrier leaves one bundle | PG INTEGRATION PASS (50 races) |
| DEDUP-005 | Same-looking business contents, different fiscal identity | two receipts | UNIT + PG INTEGRATION PASS |
| DEDUP-006 | Xiaomi prepayment vs settlement | two fiscal documents | UNIT + PG INTEGRATION PASS |
| DEDUP-007 | Same `fns_id` replay | one receipt | UNIT COVERED |
| DEDUP-008 | Same canonical fiscal tuple replay | one receipt | UNIT + PG INTEGRATION PASS |
| DEDUP-009 | Conflicting identity channels | fail closed, no merge | UNIT + PG INTEGRATION PASS |
| DEDUP-010 | Same identity, changed amount | content conflict, original preserved | UNIT + PG INTEGRATION PASS |
| DEDUP-011 | Same identity, changed items | content conflict, original preserved | UNIT + PG INTEGRATION PASS |
| DEDUP-012 | Transport metadata only | harmless replay; exact ignored keys documented | UNIT + PG INTEGRATION PASS |
| DEDUP-013 | Failure after receipt insert | full transaction rollback | PG INTEGRATION PASS (3 injection points) |
| DEDUP-014 | Legitimate same seller/amount/date, different identity | no false dedup | UNIT + PG INTEGRATION PASS |
| DEDUP-015 | Incomplete identity | explicit safe behavior; no similarity fallback | UNIT PASS; PG SEMANTICS PASS |

## Phase 1B Fiscal Normalization

| ID | Case | Status |
|---|---|---|
| NORM-INV-001 | Source evidence never modified | PG INTEGRATION PASS |
| NORM-INV-002 | One receipt/version result | PG INTEGRATION PASS |
| NORM-INV-003 | One item/version result | PG INTEGRATION PASS |
| NORM-INV-004 | Same source/version deterministic | UNIT PASS |

## Phase 2A Business Event Graph Foundation

| ID | Case | Status |
|---|---|---|
| GRAPH-INV-001 | Required/extensible event catalog | UNIT + PG INTEGRATION PASS |
| GRAPH-INV-002 | Typed directed relation catalog | UNIT + PG INTEGRATION PASS |
| GRAPH-INV-003 | Scope isolation and composite fact-version links | PG INTEGRATION PASS |
| GRAPH-INV-004 | Explicit origin/status/model/rule provenance | UNIT + PG INTEGRATION PASS |
| GRAPH-INV-005 | Deterministic semantic identity and replay | PG INTEGRATION PASS |
| GRAPH-INV-006 | Concurrent same-key creation | PG INTEGRATION PASS (20 races) |
| GRAPH-INV-007 | Many-to-many receipt/item evidence | PG INTEGRATION PASS |
| GRAPH-INV-008 | Candidate overlap and partial allocation | PG INTEGRATION PASS |
| GRAPH-INV-009 | Confirmed allocation bounds | PG INTEGRATION PASS |
| GRAPH-INV-010 | Atomic rollback | PG INTEGRATION PASS |
| GRAPH-INV-011 | Derived rebuild preserves manual assertions | PG INTEGRATION PASS |
| GRAPH-INV-012 | Cross-model semantic identity | PG INTEGRATION PASS |
| GRAPH-INV-013 | Xiaomi two-document explicit graph fixture | PG INTEGRATION PASS |
| GRAPH-INV-014 | Identical-looking purchases remain independent | PG INTEGRATION PASS |
| GRAPH-INV-015 | Ambiguity alternatives coexist | PG INTEGRATION PASS |
| GRAPH-INV-016 | Return/refund and partial return representation | PG INTEGRATION PASS |
| GRAPH-INV-017 | Advance/payment/fulfillment event vocabulary | PG INTEGRATION PASS |
| GRAPH-INV-018 | No historical backfill or auto-match | PG INTEGRATION PASS |
| GRAPH-INV-019 | Read-only validator and inspect paths | UNIT + PG INTEGRATION PASS |
| GRAPH-INV-020 | Production remains migration 004/no graph tables | READ-ONLY PREFLIGHT |

## Phase 2B Prepayment / Settlement Matcher

| ID | Case | Status |
|---|---|---|
| MATCH-001 | Strict prepayment to full settlement | UNIT PASS |
| MATCH-002 | Xiaomi two-document lifecycle | UNIT + PRODUCTION DRY-RUN |
| MATCH-003 | Identical-looking independent purchases | UNIT PASS |
| MATCH-004 | Ambiguous equal candidates | UNIT PASS |
| MATCH-005 | No candidate | UNIT PASS |
| MATCH-006 | Mixed payment stage | UNIT PASS |
| MATCH-007 | ADVANCE candidate stage | UNIT PASS |
| MATCH-008 | Predicate failure is fail-closed and explained | UNIT PASS |
| MATCH-009 | Rerun idempotency/determinism | UNIT PASS |
| MATCH-010 | Concurrent dry-run equivalence | UNIT PASS |
| MATCH-011 | Out-of-order input equivalence | UNIT PASS |
| MATCH-012 | No graph/ledger writes | UNIT + PRODUCTION DRY-RUN |
| MATCH-013 | Production normalized corpus dry-run | 1691 source rows; 46867 candidates; 58 strict; 37 confirmed; 9 ambiguous; 230 unmatched |
| MATCH-014 | Xiaomi production 62 -> 54 | PRODUCTION READ-ONLY PASS; 19/19 predicates |
| NORM-INV-005 | Unknown FFD never guessed | UNIT PASS |
| NORM-INV-006 | Missing differs from zero | UNIT PASS |
| NORM-INV-007 | PaymentType remains item-scoped | UNIT PASS |
| NORM-INV-008 | Mixed receipt remains MIXED | UNIT + PG INTEGRATION PASS |
| NORM-INV-009 | Component mismatch visible | UNIT PASS |
| NORM-INV-010 | Normalizer failure preserves evidence | PG INTEGRATION PASS |
| NORM-INV-011 | Fiscal operation/direction separate | UNIT PASS |
| NORM-INV-012 | Derived layer rebuildable | PG INTEGRATION PASS |
| NORM-INV-013 | Backfill idempotent | PG INTEGRATION PASS |
| NORM-INV-014 | No purchase relation created | UNIT PASS |

## Phase 1B Operational Gate

| Gate | Result |
|---|---|
| Unsupported FFD does not starve later source/derived ingest | PASS |
| Payment component mismatch does not starve later source/derived ingest | PASS |
| Unexpected normalizer exception preserves source and aggregates failure | PASS |
| Restart continues with the next receipt | PASS |
| Blocked normalization remains independently retryable/rebuildable | PASS |
| Source evidence remains deduplicated | PASS |
| Production changed | NO |

`PHASE 1B OPERATIONAL GATE PASS`

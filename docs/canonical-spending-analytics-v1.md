# Canonical Spending Analytics V1

Status: design and read-only audit only. This document does not authorize a
migration, classification write path, deployment, replay, backfill, or
production mutation.

## Purpose

Define one canonical, versioned spending contract over already-proven purchase
and receipt evidence. The contract must keep economic purchase totals separate
from receipt provenance, person attribution, bank funding, item classification,
and return/refund state.

The existing rule remains authoritative: bank movement is the monetary funding
fact, while a matched receipt enriches one purchase and never creates a second
cash flow.

## Current audit findings

The exact-master read-only audit found:

- `analytics_purchases` currently has 1,919 rows, 1,919 distinct non-null
  `purchase_id` values, and no duplicate purchase grain in the audited
  snapshot.
- `chatgpt_accounting.user_receipts` is a person-by-receipt provenance
  inventory, not a monetary purchase grain. The audited snapshot had 2,773
  rows, 2,771 distinct receipts, and 3 persons.
- Receipts `15650` and `15834` each had two person-provenance rows. A direct
  join reproduced fan-out for purchase `178163` and receipt `15650`: one
  economic purchase row joined to two person rows, producing two joined rows.
  Monetary totals must never be computed after such a provenance join.
- No application category taxonomy, category decision table, or versioned
  category contract was present in the audited schema.
- Existing item views expose item position/name/quantity/price/item sum/NDS and
  currency, but no category decision.
- Current certification exposes acquisition, return, fiscal-new-money, refund
  receivable, and blocked-exposure metrics. These are useful source facts, not
  a complete canonical spending taxonomy.

## Current grains and boundaries

| Relation | Current meaning | Safe use |
| --- | --- | --- |
| `analytics_purchases` | one certified acquisition fact/business purchase | economic purchase totals |
| `analytics_purchase_items` | receipt item lines for the proof-chain receipt | item-level detail, never purchase totals |
| `chatgpt_accounting.user_receipts` | person x receipt source provenance | inventory and attribution evidence only |
| certification facts | versioned metric facts for a certification source state | certified/provisional metrics and trace |
| bank cash-flow/journal | monetary movement and funding side | funding and balanced journal, not spending category |

`user_receipts` must remain outside the monetary base relation. Person
attribution is an explicit downstream allocation, not an implicit join.

## Proposed canonical grains

### Economic purchase

`canonical_spending_purchases` has at most one row per certified economic
purchase/business event, scope, and canonical purchase model version. It
contains the exact purchase amount/currency, occurred-at, receipt evidence
identity where proven, and a stable purchase key. A purchase contributes to a
period total at most once.

The base is sourced from certified `CONFIRMED_ACQUISITION_VALUE` evidence. It
does not use `FISCAL_NEW_MONEY`, bank balance changes, `receipts.total_sum`, or
unclassified cash-flow rows as spending.

### Item

`canonical_spending_items` has one row per normalized receipt item attached to
one canonical purchase. Item identity is the normalized receipt/item identity,
not a merchant-only identity. Item totals must reconcile to the purchase total
when the receipt contract proves that relationship; otherwise the purchase
remains visible with an explicit reconciliation status.

### Person attribution

`canonical_spending_person_attribution` is a separate purchase allocation
grain. A row requires explicit ownership/attribution evidence already proven
for the accounting scope. FNS source ownership, a notification source, a bank
account owner flag, or a merchant does not by itself prove payer or beneficiary.

Unresolved attribution is represented as `UNATTRIBUTED` or `REVIEW_REQUIRED`,
never silently assigned to a person. A shared purchase may have explicit
allocations, but the exact allocated amounts must sum to the purchase amount.

### Category

`canonical_spending_categories` is an item/economic-purchase classification
allocation grain. It is not a property inferred from a raw merchant join.
Each decision carries taxonomy version, category code, decision status,
decision source, rule/model version, provenance key, and supersession identity.

The first stable taxonomy is proposed as
`household-spending-taxonomy-v1`. Initial codes are:

`GROCERIES`, `DINING`, `HEALTH_MEDICINE`, `BEAUTY_PERSONAL_CARE`,
`BEAUTY_SERVICES`, `CLOTHING`, `PETS`, `HOME_HOUSEHOLD`, `UTILITIES`,
`INSURANCE`, `PARKING`, `FUEL`, `PUBLIC_TRANSPORT`, `ELECTRONICS_DIGITAL`,
`DELIVERY_SERVICES`, `GIFTS`, `FINANCIAL_SERVICES`, `OTHER`,
`UNCLASSIFIED`, and `REVIEW_REQUIRED`.

Beauty and medicine remain separate: `HEALTH_MEDICINE` is not merged into
either beauty category. Multi-category allocation is allowed only with explicit
amounts/weights that reconcile exactly; otherwise the item is
`REVIEW_REQUIRED`. `UNCLASSIFIED` is a visible remainder, not a hidden guess.

Automated rules, model decisions, and manual overrides are separate,
append-only decisions. A manual decision may explicitly supersede an automated
decision. An unknown, disputed, or conflicting decision remains visible and
cannot be silently replaced by an ad hoc ChatGPT classification.

## Money, returns, and reconciliation

All persisted and view-level money is exact PostgreSQL `NUMERIC(18,2)` or an
equivalent decimal string contract. No JS floating-point arithmetic is part of
the canonical persistence or reconciliation definition.

For one currency and one period:

- `gross_spend` is the sum of canonical certified purchase amounts.
- `confirmed_returns` is the sum of independently certified return amounts,
  represented as a positive return magnitude linked to a return/refund event.
- `net_spend = gross_spend - confirmed_returns`.
- an outstanding refund receivable is reported separately and is not deducted
  until a confirmed return/refund fact exists.

Every return must have an explicit purchase/refund relationship. A return must
not be counted both as a negative purchase item and as a return metric unless
the contract explicitly marks one representation as informational. Bank
movements remain funding facts and are not re-added to spending totals.

Required invariants:

1. Each canonical purchase contributes at most once to gross spend.
2. Item allocations for a purchase sum exactly to its purchase amount when
   item reconciliation is `RECONCILED`; otherwise the remainder is explicit.
3. Category allocations sum exactly to the classified item/purchase amount;
   `UNCLASSIFIED` or `REVIEW_REQUIRED` is included in the visible remainder.
4. Person allocations sum exactly to the purchase amount only when explicit
   attribution is complete; otherwise the unallocated remainder is visible.
5. Gross, return, and net values are calculated separately per currency and
   never mixed in one total.
6. The same purchase, return, category allocation, or person allocation is not
   counted twice because of provenance, evidence, or source joins.

## Proposed semantic views

The future safe semantic layer should expose:

- `canonical_spending_purchases`: one economic purchase row;
- `canonical_spending_items`: one normalized item row;
- `canonical_spending_person_attribution`: explicit person allocations and
  unresolved remainder;
- `canonical_spending_categories`: versioned category decisions/allocations;
- `canonical_spending_summary`: period/currency totals for gross returns and
  net spend, with unclassified and review-required amounts visible.

Household totals must query the purchase/summary grain. Person totals must
query explicit attribution allocations. Category totals must query category
allocations. No semantic view may join `user_receipts` directly into the
monetary base without first reducing it to a documented one-row provenance
relation.

BlazeSQL should receive only these curated views plus existing safe views. Raw
notification payloads, receipt raw data, credentials, source-event identifiers,
account/card references, and internal writer tables remain excluded.

## Persistence proposal

This is a design, not a migration. A future schema foundation should include:

- a versioned taxonomy and category-code relation;
- append-only item classification decisions with status, provenance, semantic
  identity, and supersession;
- explicit purchase-to-person attribution allocations with exact amounts;
- explicit item/purchase-to-category allocations with exact amounts;
- deterministic keys and uniqueness constraints for one active decision per
  governed subject/version;
- conflict detection for overlapping active allocations and taxonomy/version
  disagreement.

Corrections must append a new decision or allocation and preserve immutable
history. Replaying the same evidence must reuse the same semantic identity.
No table in this proposal authorizes production writes until its migration,
writer, certification impact, and operational rollback are reviewed separately.

## Implementation sequence

1. Define canonical read-only contracts and fan-out-safe views.
2. Add the minimal taxonomy/classification and allocation schema with
   PostgreSQL constraints and exact-decimal tests.
3. Implement deterministic item classification with explicit overrides and
   visible unclassified/review-required outcomes.
4. Add the return/refund net layer and reconciliation tests.
5. Integrate the curated semantic/BlazeSQL views.
6. Perform a production read-only validation of grains, category coverage,
   return/net invariants, and unchanged persistence state.
7. Consider controlled persistence only after a separate review.

## Test plan

The future tests must cover: duplicate-evidence fan-out; person attribution
ambiguity; multi-item exact decimal reconciliation; category allocation sums;
unclassified remainder visibility; taxonomy version changes; automated versus
manual supersession; disputed decisions; return/refund linkage; gross/return/
net arithmetic; mixed-currency fail-closed behavior; deterministic replay;
input-order independence; and read-only semantic views.

PostgreSQL tests must prove that the curated views remain SELECT-only, that
historical decisions are immutable, that conflicting active allocations fail
closed, and that unchanged source evidence produces identical semantic keys.

## Non-goals and safety boundaries

This stage does not implement a classifier, migration, category persistence,
receipt matching, writer invocation, ledger mutation, deployment, replay,
backfill, or production data change. It does not infer income, expense,
counterparty, payer, beneficiary, household ownership, or internal transfer
from direction, source package, merchant, or a single evidence row.

# Receipt and bank reconciliation audit: 1–26 October and through 29 October 2026

Status: read-only production audit and local query guidance. No production
data, matcher settings, or accounting rows were changed. The interval is
half-open in Europe/Moscow: `[2026-10-01 00:00, 2026-10-27 00:00)`, equal to
`[2026-09-30 21:00Z, 2026-10-26 21:00Z)`.

## Findings

- The corrected FNS outflow inventory is **108 unique receipts /
  212,406.01 amount units**. It comprises 88 settled receipts with current
  reconciled cash/e-cash (169,972.04 units), 4 advances (33,151.00), 15
  prepayments (8,666.00), and 1 mixed receipt (616.97). Thirteen additional
  settlement-only headers (33,061.00) have zero current new money and no
  active acquisition; four other zero-new-money settlement receipts
  (6,458.00) are linked to active fulfillment entries. The earlier
  109 / 217,906.01 query joined a 5,500 receipt to two source observations and
  summed its header twice. `receipts.id` is the monetary key; observations
  are provenance rows. The live SQL result has NULL currency for every
  receipt row, so none of these receipt-side amounts is labeled RUB.
- The current active READY **acquisition ledger** for 1–26 October is **96
  events / 185,069.04 in ledger currency RUB**: 92 `PURCHASE` events
  (178,611.04 RUB: 60 standalone receipt-backed, 28 matched-funding, and 4
  bank-only) plus 4 `FULFILLMENT` events (6,458.00 ledger RUB). These four
  fulfillment entries consume merchant advances without a second cash
  outflow. Their source business-event currency is NULL; the ledger applies
  its configured RUB currency, so retain that currency-provenance caveat.
  All 96 have one non-superseded READY ledger entry; no duplicate active
  acquisition was proven. Their ledger `certification_status` is
  `FUNDING_UNRECONCILED`, so READY does not mean every funding link is fully
  certified. The validated current certification snapshot also has 96 unique
  acquisition events / 185,069.04 RUB.
- Separately, 7 confirmed purchase events totalling **14,075.14 amount units**
  have no currency on the business event. Their ledger rows are `BLOCKED`, use
  `LEDGER_UNSUPPORTED_V1`, and have no debit postings (the ledger currency is
  RUB). They are not part of the 185,069.04 RUB active READY acquisition
  total; amount and currency remain unresolved until corrected through an
  authorized process. Do not infer their currency from the ledger row.

- Current certification snapshot: no certified return rows in either
  interval. The 9,540 amount-unit return candidate remains unproven and is not
  subtracted.
- There are **77 READY/PURCHASE/DEBIT bank transactions / 156,297.25 RUB**.
  A live read-only anti-join found 45 without an active ledger source link
  (75,427.08 RUB). This is source coverage, not 45 proven extra expenses.
- The 28 saved receipt–bank links total **72,231.17 RUB**. Nine have exact
  cashless proof (**15,543.05 RUB**); 19 are stored as
  `UNIQUE_COMPATIBLE_PAIR_REQUIRES_APPROVAL` (**56,688.12 RUB**). Each currently
  contributes one active matched-funding ledger event; the previous
  standalone entry is superseded.
- The 55 amount/time research candidates total **134,268.37 bank-side amount units**. They are not
  55 confirmed purchases. The 27 candidates without a saved pair total
  **62,037.20 candidate amount units** and fail different gates described below.
- In the 1–26 October slice, `chatgpt_accounting.analytics_purchases` has
  **480 certification-fact rows for 96 distinct purchase events** (five facts
  per event); the 96 events have consistent amount/currency across those
  facts. A raw `SUM(amount)` over the view would be **925,345.20 RUB**, including
  **740,276.16 RUB** of repeated fact amounts. The 185,069.04 RUB one-row-per-event
  sum across that whole fact history is still not a current certified total:
  it can include old or superseded facts. Use the validated current snapshot
  below, never a raw sum or an amount-based `DISTINCT`.
- A separate run for **1–29 October inclusive in Moscow** (half-open UTC
  `[2026-09-30 21:00Z, 2026-10-29 21:00Z)`) returned 108 unique current
  certification acquisitions / 199,550.55 RUB: 104 `PURCHASE` events /
  193,092.55 RUB plus the same 4 `FULFILLMENT` events / 6,458.00 ledger RUB.
  `analytics_purchases` had 530 fact rows for those 108 event IDs; raw
  `SUM(amount)` was 985,946.23 RUB, overstating by 786,395.68 RUB. The active
  READY ledger query independently returned the same 104 + 4 event totals.
  Receipt amounts for that interval were 123 / 258,533.18 amount units with
  currency UNKNOWN on every receipt.
- A strict read-only matcher preview for 1–26 October found 36 compatible
  pairs: 28 already saved (72,231.17 RUB) and 8 unsaved cutoff candidates
  (7,683.65 RUB). For 1–29 October it found 38: 30 saved (73,574.22 RUB) and
  the same 8 unsaved cutoff candidates. This strict set is not the earlier
  55-pair amount/time research inventory: the latter also contains candidates
  that fail account, source, settlement, or timing proof.
- In the 1–29 October bank interval, 82 READY purchase debits totaled
  191,301.96 RUB: 34 linked to an active ledger acquisition (82,213.22 RUB)
  and 48 without such a link (109,088.74 RUB). The added Oct 27–29 saved links
  are two approval-required pairs (1,343.05 RUB); they remain included in the
  active ledger total. The separate loose-candidate census was not rerun for
  Oct 27–29, so do not extend the Oct 1–26 conditional unbooked-source scenario
  to the longer interval.
- The earlier reconciliation run 4500 is not present in the current run,
  result, or fact tables. Its historical 28-versus-55 difference cannot be
  reconstructed as that exact past run; the explanation below is from the
  current persisted state and the current strict matcher gates.

## Exact cause for the eight manually resolved candidates

The eight amounts are **2.99, 37.00, 237.00, 563.17, 644.00, 955.95,
2,293.54, and 2,950.00 RUB** (7,683.65 RUB total). Their technical checks pass:

- account resolution is `MANUAL` and its source/provider/account binding has
  verified provenance;
- transaction and receipt scopes match; the candidate is unique on both
  sides; no endpoint is already reserved by a match;
- purchase/debit, currency/amount, receipt settlement/fiscal/item/payment
  proof, and the owner-evidence gate pass;
- no existing bank or receipt match conflicts with the candidate.

The one failed condition is the configured automatic cohort. At the audited
release, `MATCHED_PURCHASE_RECONCILIATION_START_AT` was
`2026-10-17T08:08:21.000Z` (11:08:21 Moscow time). The automatic path applies
`bankIngestedAfter` in `src/bank-receipt-matching.js` and independently checks
both `bank_transactions.occurred_at` and
`bank_event_observations.created_at`; all eight precede that boundary. The
persistor enforces the same boundary through
`AUTO_BANK_EVENT_OUTSIDE_COHORT` in
`src/matched-purchase-persistence.js`.

This is intentional cohort exclusion, not a defect in account binding or a
reason to change the ±5 minute matcher window. Keep all eight as research
candidates; do not backfill or auto-link them.

## Other 27 unsaved candidates

| Technical reason | Count | Candidate amount | Treatment |
|---|---:|---:|---|
| Outside automatic cohort; all other listed proof gates pass | 8 | 7,683.65 RUB bank-side candidate amount | Keep research-only |
| Account/source/owner proof unresolved | 11 | 27,608.55 candidate amount units | Do not promote without proof |
| Advance-only receipt state | 2 | 19,080.00 candidate amount units | Not a settled purchase candidate |
| Prepayment-only receipt state | 3 | 2,839.00 candidate amount units | Keep separate from settlement |
| Outside ±5 minutes, about 1h59m | 2 | 4,789.00 candidate amount units | Do not widen the matcher window |
| Outside ±5 minutes, about 16h07m | 1 | 37.00 candidate amount units | Do not promote by amount alone |
| **Total** | **27** | **62,037.20 candidate amount units** | **Unconfirmed** |

The 11 unresolved candidates include absent/insufficient account or source
binding proof. This audit did not identify or infer the owner of any expense.

## Special cases and classification

- **Saved links:** 1–26 October has 28 links (9 exact-proof confirmations and
  19 approval-required). 1–29 October has 30 links, including two additional
  approval-required links. All approval-required events remain included in
  the active ledger totals; only their link status is unconfirmed.
- **Eight manually resolved candidates:** candidate-only; excluded solely
  because both bank timestamps are before the automatic cohort start.
- **Other candidates:** 11 lack acceptable account/source/owner evidence; 5
  are advances/prepayments; 3 fall outside the fixed ±5-minute window.
- **Receipts without a bank candidate:** 53 / 78,137.64 amount units
  (currency UNKNOWN) in the audited research inventory. This does not mean 53 missing ledger expenses: many are
  represented by standalone receipt-backed events, and some FNS documents
  represent prepaid settlements.
- **Bank purchases without a receipt candidate:** 22 / 22,028.88 RUB. Four
  (8,639.00 RUB) already have bank-only ledger entries. The remaining 18
  (13,389.88 RUB) have no active ledger link and no research receipt candidate
  in this period. Keep them as unbooked source-only candidates; do not merge
  them with another event or claim a household owner from this query.
- **Advance/prepayment states:** 4 advance-only receipts / 33,151.00 amount
  units and 15 prepayment-only receipts / 8,666.00 units (currency UNKNOWN).
  These are payment/advance evidence, not extra expenses to add on top of later
  settlement.
- **Settlement receipts with no active acquisition:** 13 / 33,061.00 amount
  units (currency UNKNOWN). Their normalized current cash/e-cash is zero
  because the amount is prepaid. Four more settlement receipts / 6,458.00
  units are linked to active `FULFILLMENT` ledger entries. Do not add their
  receipt headers to the expense total; the ledger records the acquisition
  once while fulfillment consumes the advance.
- **Mixed receipt:** 1 / 616.97 amount units (currency UNKNOWN); keep unresolved until the payment/acquisition
  evidence is reconciled.
- **Return:** 9,540.00 amount units remains `UNPROVEN`; no confirming bank credit/refund
  was found. It is not subtracted from spending.

The aggregate SQL read-only check found 92 settlement receipts with active
acquisition evidence: 88 `PURCHASE` entries with 169,972.04 amount units of
reconciled current cash/e-cash, plus four `FULFILLMENT` entries that consume
6,458.00 ledger RUB of merchant advances without new cash. Four advances /
33,151.00 units and 15 prepayments / 8,666.00 units (all receipt currencies
UNKNOWN) stay separate from acquisition totals. Thirteen prepaid settlement
receipts have no active acquisition link; do not add their 33,061 header
units without resolving the prior payment chain. The 7 missing-currency
`LEDGER_UNSUPPORTED_V1` events are outside this baseline: they have no posting
and are blocked, despite an RUB currency on their ledger rows.

## Cases reviewed

- **1,539 RUB / receipt 16088:** the bank-only event is one active expense. The
  receipt is `PREPAYMENT_ONLY`; a later same-scope seller/amount receipt has a
  different normalized item fingerprint. There is no proof these are the same
  economic purchase and no proof of a second active expense. Do not merge them
  or add the prepayment and settlement as separate expenses.
- **Two Sber 110 RUB events 2.005 seconds apart:** their payload hashes match,
  but source/dedup keys differ. No confirmed link proves one notification
  lifecycle or one banking transaction. Do not deduplicate on amount, hash, or
  short time distance alone.
- The eight-item cutoff list includes a 37 amount-unit candidate. A separate
  37 amount-unit potential pair is about 16h07m apart and falls outside the fixed
  ±5-minute rule. They must not be collapsed just because the amounts are
  equal; amount equality is insufficient evidence for either pair.
- **Timezone:** the database comparison is in UTC; the reporting interval is
  Moscow UTC+3 converted explicitly above. Bank `occurred_at` and server
  observation `created_at` are separate; normal ingest delay was under two
  seconds. Timezone conversion does not explain hour-scale differences.

## Reproducible, read-only monetary calculation

The unsafe join pattern is:

```sql
SELECT sum(r.total_sum)
FROM receipts r
JOIN receipt_source_observations o ON o.receipt_id = r.id;
```

It changes the row grain from one canonical receipt to one observation. Use
`receipts` without that join for receipt money, or express provenance as
`EXISTS (SELECT 1 FROM receipt_source_observations o WHERE o.receipt_id=r.id)`.
If the query needs observation details, aggregate/deduplicate the observation
side to one row per `receipt_id` before joining, and still group money by
`receipts.id` rather than by equal amounts.

The aggregate source coverage and unique-receipt outflow cohort for both
periods can be reproduced with
`scripts/receipt-bank-reconciliation-october-2026-readonly.sql`. It opens one
repeatable-read, read-only transaction, selects aggregate fields only, and
rolls back the transaction. The first query counts READY `PURCHASE` events and
the acquisition `FULFILLMENT` event type separately, excluding superseded
entries. The FNS result reports fiscal headers separately from reconciled new
money, associates fulfillment evidence with settlement receipts, and separates
payment stages. The fourth query uses one row per `receipts.id`, requires
reconciled outgoing cash/e-cash greater than zero, and reproduces **108
receipts / 212,406.01 amount units** for 1–26 October. Currency is NULL on
those receipt rows, so do not treat that result as currency-normalized without
independent evidence. Settlement-only headers with zero new money do not
enter that outflow cohort.

Run the current-snapshot reader first. It calculates the current source-state
key and verifies the persisted fact/result set in a
`REPEATABLE READ READ ONLY` transaction. Use its returned exact
`scope_id`, `certification_run_id`, and `source_state_key`; never choose
`MAX(run_id)` or combine several READY runs. Then the purchase-grain total for
1–26 October is:

```sql
WITH purchase_grain AS (
  SELECT purchase_id, amount, currency, purchased_at
  FROM canonical_spending_purchases_v1
  WHERE scope_id = $1
    AND certification_run_id = $2
    AND source_state_key = $3
    AND purchased_at >= TIMESTAMPTZ '2026-09-30 21:00:00+00'
    AND purchased_at <  TIMESTAMPTZ '2026-10-26 21:00:00+00'
)
SELECT currency,
       count(*) AS purchase_rows,
       count(DISTINCT purchase_id) AS unique_purchase_events,
       sum(amount)::numeric(18,2) AS current_certified_gross
FROM purchase_grain
GROUP BY currency;
```

Require `purchase_rows = unique_purchase_events`; otherwise stop and inspect
the snapshot. Never deduplicate a conflict with `DISTINCT amount` or by
choosing an arbitrary fact. The read-only current-snapshot reader returned
`READY` for this check, and the canonical results independently matched the
active-ledger acquisition groups. The reader and canonical views are not
exposed to BlazeSQL by this change. Ledger entries currently show
`FUNDING_UNRECONCILED`.

Keep the source-only bank bucket separate and count one normalized transaction
at a time. The live audit found **13,389.88 RUB** of purchase/debit transactions
with neither an active ledger link nor a receipt candidate in the audited
period. This is a possible addition only if the transaction evidence and
account scope are accepted; it is not part of the proven total.

| Calculation | Amount | Meaning |
|---|---:|---|
| Current active READY acquisition ledger, 1–26 Oct | **185,069.04 RUB ledger** | 96 events: 92 `PURCHASE` + 4 `FULFILLMENT`; includes all 19 approval-required links / 56,688.12 RUB; no active duplicate proven |
| Current active READY acquisition ledger, 1–29 Oct | **199,550.55 RUB ledger** | 108 events: 104 `PURCHASE` + 4 `FULFILLMENT`; includes all 21 approval-required links / 58,031.17 RUB; no active duplicate proven |
| Add no-candidate, unbooked bank source bucket, 1–26 Oct | **13,389.88 RUB** | Conditional only if all 18 bank transactions are independently confirmed eligible expenses |
| Baseline plus that 1–26 scenario | **198,458.92 RUB ledger** | Conditional; approval-required events stay in baseline and are not removed |
| Blocked purchases with missing event currency | **14,075.14 amount units** | 7 `LEDGER_UNSUPPORTED_V1` events, 0 debit postings; currency unresolved, excluded |
| Unlinked prepaid settlements, 1–26 Oct | **33,061.00 amount units** | 13 receipt headers with no active acquisition; currency UNKNOWN; do not add until prior payment chain is proven |
| Advance/prepayment outflows, 1–26 Oct | **41,817.00 amount units** | Receipt currency UNKNOWN; separate cash/advance evidence, not added as expenses |
| Mixed FNS document | **616.97 amount units** | Currency UNKNOWN; unresolved |
| Unproven return | **9,540.00 amount units** | No confirmed refund evidence; no netting |

Do not create a single source-union total by adding receipt headers to bank
debits. Receipt currency is UNKNOWN in this cohort, prepaid headers overlap
later fulfillment, and the 55 candidates are not confirmed links. The
defensible current baseline is the READY ledger acquisition total above. The
19 / 21 approval-required links remain included in that total, with their
link status visibly labeled.

## Regression coverage added locally

- Multiple source observations: naïve receipt join fans out, `EXISTS` remains
  one receipt.
- Multiple certification facts/runs: `analytics_purchases` repeats a
  business purchase; one exact run/source-state yields one canonical row.
- Equal amounts: two independent purchase events of 11.00 remain two events
  and total 22.00; amount is never a deduplication key.
- Supersession: two historical ledger rows with one supersession chain yield
  one active entry.

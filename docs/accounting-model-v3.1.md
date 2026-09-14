# Household Accounting Model v3.1

Phase 2A implementation details are documented in [business-event-graph.md](business-event-graph.md). The graph is still design/foundation only: no production events or ledger postings are created by migration 005.

Design only. No production ledger or schema is created in this audit.

## Chart of accounts

| Code | Account | Normal balance | Meaning |
|---:|---|---|---|
| 101 | Cash and bank/electronic asset | Debit | household money held at bank/wallet/cash |
| 110 | Advance to merchant | Debit | prepaid value owed as goods/services |
| 120 | Stored value/certificate asset | Debit | gift card/certificate value controlled by household |
| 130 | Refund receivable/pending | Debit | money expected back after an approved return |
| 201 | Credit/payable liability | Credit | amount owed by household |
| 501 | Purchase/consumption expense | Debit | recognized consumption or acquisition |
| 401 | Household income | Credit | money earned/received as income |
| 601 | Fees expense | Debit | bank/merchant fees |
| 402 | Interest income | Credit | interest received/accrued by policy |
| 403 | Cashback/reward income | Credit | benefit received; policy may instead credit expense |
| 199 | Suspense/unresolved clearing | Either | explicit temporary balance; never hidden |

## Posting specification

Every posting has balanced debits and credits, source evidence, event ID, rule version and explanation.

| Event | Debit | Credit |
|---|---|---|
| Direct purchase 100 | Dr 501 100 | Cr 101 100 |
| Full prepayment 100 | Dr 110 100 | Cr 101 100 |
| Settlement using advance 100 | Dr 501 100 | Cr 110 100 |
| Partial prepayment 60 | Dr 110 60 | Cr 101 60 |
| Partial settlement, total 100, advance 60 | Dr 501 100 | Cr 110 60; Cr 101 40 |
| Full return 100 | Dr 101 100 | Cr 501 100 |
| Partial return 25 | Dr 101 25 | Cr 501 25 |
| Cancelled prepayment 100 | Dr 101 100 | Cr 110 100 |
| Buy gift certificate 100 | Dr 120 100 | Cr 101 100 |
| Redeem certificate 100 | Dr 501 100 | Cr 120 100 |
| Cashback received 5 | Dr 101 5 | Cr 403 5 |
| Credit purchase 100 | Dr 501 100 | Cr 201 100 |
| Credit repayment 100 | Dr 201 100 | Cr 101 100 |
| Own-account transfer 100 | Dr 101:bank-B 100 | Cr 101:bank-A 100 |
| Cash withdrawal 100 | Dr 101:cash 100 | Cr 101:bank 100 |
| Cash deposit 100 | Dr 101:bank 100 | Cr 101:cash 100 |
| Bank fee 3 | Dr 601 3 | Cr 101 3 |
| Interest received 4 | Dr 101 4 | Cr 402 4 |
| Correction | reverse incorrect balanced posting, then post corrected balanced event | both transactions versioned and linked |

Gift certificates are household assets, not liabilities: purchase debits stored value and credits cash; redemption debits expense and credits stored value.

## Event graph requirements

Maintain separate immutable evidence, fiscal document, fiscal item, purchase, payment, fulfillment, return, cancellation, correction, advance, credit and posting entities. Links are N-to-N allocations with amount, quantity, confidence, rule version and explanation. A receipt is evidence of a fiscal event, not automatically a purchase or cash flow.

## Direction rules

Store FNS operation direction and household cash direction separately. Operation types 1/2 generally map to household out/in, while 3/4 describe seller expense/reversal and must be interpreted by business context. `paymentType` is item-scoped and never supplies the event type alone.

## Certification

Do not certify an amount unless components reconcile, allocations are bounded, unresolved cases are materiality-reviewed, postings balance, and incremental processing equals a clean rebuild.

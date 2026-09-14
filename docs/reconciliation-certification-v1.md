# Reconciliation / Certification V1

Implemented and validated locally and on a disposable PostgreSQL clone. Production was not changed and no BlazeSQL privileges were granted.

## Dimensions

Certification is separated into `BUSINESS_CERTIFICATION`, `FUNDING_CERTIFICATION`, and `CLASSIFICATION_CERTIFICATION`. A business lifecycle can be certified while funding remains `PROVISIONAL / FUNDING_UNRECONCILED` and acquisition classification remains provisional.

## Structures

Migration `007_reconciliation_certification.sql` adds generic `reconciliation_runs`, `reconciliation_results`, and `certification_facts` tables. Facts retain scope, metric, status, reason, rule/version, source state key, event/ledger/evidence links, and deterministic semantic keys.

## V1 metrics

- `CONFIRMED_ACQUISITION_VALUE`: certified from READY fulfillment/standalone acquisition postings; prepayment is never counted as a second acquisition.
- `CONFIRMED_RETURN_VALUE`: certified from READY return reversal.
- `NET_CONFIRMED_ACQUISITION`: acquisition minus confirmed returns.
- `FISCAL_NEW_MONEY`: provisional because fiscal clearing is not a bank account reconciliation.
- `MERCHANT_ADVANCE_BALANCE`: certified as a business-lifecycle balance.
- `OUTSTANDING_REFUND_RECEIVABLE`: certified when a return receivable is proven; incoming refund cash is not inferred.
- `BLOCKED_EXPOSURE`: blocked ledger entries remain visible with reason codes and amounts.

No bank spend, card spend, household cash balance, or final expense category is certified by this phase.

## Disposable projection

On the current clone:

| Metric | Amount | Status |
|---|---:|---|
| Confirmed acquisition value | 100,724.29 RUB | CERTIFIED |
| Confirmed return value | 2,683.29 RUB | CERTIFIED |
| Net confirmed acquisition | 98,041.00 RUB | CERTIFIED |
| Fiscal new money | 100,724.29 RUB | PROVISIONAL |
| Merchant advance balance | 0.00 RUB | CERTIFIED |
| Outstanding refund receivable | 2,683.29 RUB | CERTIFIED |
| Blocked exposure | 98,310.00 RUB | BLOCKED |

The Xiaomi lifecycle contributes `32,380.00` exactly once to acquisition and fiscal new money; it does not produce `64,760.00`. The return golden path produces a certified return and receivable, but no certified incoming cash.

## Rebuild and proof

Certification is derived from the current graph and ledger, never directly from raw receipts. Rebuild is idempotent, semantic-keyed, scope-aware, transactionally rollback-safe, and concurrency-safe. The CLI is `certification report` or `certification rebuild --persist`; period semantics are business/ledger `event_at` with a half-open `[from,to)` interval.

## Validation

- Local suite: 86 passed, 0 failed, 2 optional PostgreSQL skips.
- Disposable PostgreSQL integration: 1/1 PASS.
- Integration covered idempotency, concurrency, rollback, source/ledger invariants, scope-preserving facts, and proof-chain links.
- Clone source/graph/ledger counts remained `1703/5792/1703`, `129/91/84/8`, and `129/178/96`.

Production deployment is intentionally not authorized by this phase.
# Historical audit snapshot

The counts in this document describe a historical disposable validation snapshot only.

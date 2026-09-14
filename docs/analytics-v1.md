# Analytics V1

Analytics V1 is a read-only, certification-derived reporting contract. It does not infer household spend from fiscal totals and never uses `receipts.total_sum` as an analytics source.

## Contract

`analytics summary` returns deterministic JSON with `model=analytics-v1`, `scopeKey`, an explicit timezone, and a half-open period `[from,to)`. Every metric contains `metricCode`, `amount`, `currency`, `status`, `count`, `reason`, and `period`. Amounts are derived from certified/provisional ledger and certification facts.

Statuses are `CERTIFIED`, `PROVISIONAL`, or `BLOCKED`. `FISCAL_NEW_MONEY` remains `PROVISIONAL` while funding is unreconciled. `BLOCKED_EXPOSURE` is reported separately by reason. Mixed currencies are never combined.

The Xiaomi lifecycle is represented once: prepayment contributes fiscal new money and fulfillment contributes confirmed acquisition, so the 32,380.00 acquisition is not doubled. A return without a refund contributes certified return value and refund receivable, but not certified cash received.

## Safe proof chain

The optional curated views in `db/analytics/008_analytics_v1.sql` expose certification fact -> ledger entry -> business event -> ledger source link -> normalized fiscal fact. They intentionally omit raw payload, session/auth data, and buyer PII. `FISCAL_PAYMENT_CLEARING` is not presented as bank spend. The file is outside the automatic migration directory until separately approved.

## CLI

```text
receipt-collector analytics summary [--from ISO] [--to ISO]
receipt-collector analytics blocked [--from ISO] [--to ISO]
receipt-collector analytics trace [--metric METRIC_CODE] [--limit N]
```

All commands are read-only. Migration 008 and any future curated-view grants require a separate deployment approval.

# Purchase Details Analytics V1

Status: local implementation and disposable-clone validation only. Production was not changed and no grants were issued.

## Curated Views

- `analytics_purchases`: one row per certified acquisition fact. A business
  event can appear in multiple certification facts or runs.
- `analytics_purchase_items`: one row per item per certified acquisition fact
  of the authoritative receipt selected by the proof chain.

The views source only `analytics_proof_chain` rows where `metric_code = 'CONFIRMED_ACQUISITION_VALUE'` and `status = 'CERTIFIED'`. The proof-chain receipt is used as the item-bearing evidence. Prepayment and fulfillment receipts are not unioned, so Xiaomi remains one purchase for `32380.00`, not `64760.00`.

Do not sum `analytics_purchases.amount` across the entire view or use it for
an unqualified time-period total: the view does not expose the certification
run/source-state identity needed to select one coherent snapshot. Use the
snapshot-qualified `canonical_spending_purchases_v1` or the validated
current-snapshot reader for totals. Join items to their fact using both
`purchase_id` and `certification_fact_id`; `item_sum` is safe only at
item-fact grain. Missing or mismatched item reconciliation remains visible to
the validator.

The views expose seller and seller INN, but no raw JSON, FNS source identity, fiscal sign, auth/session data, or buyer PII.

## SQL and Validation

- SQL: `db/analytics/009_purchase_details_v1.sql`
- Clone validation: `scripts/validate-purchase-details-v1.sql`

The SQL is outside the automatic migration loader. Applying it is a separately approved analytics deployment; it does not mutate source, graph, ledger, or certification rows.

## Future BlazeSQL Grant Plan

After separate approval, issue only:

```sql
GRANT USAGE ON SCHEMA public TO chatgpt_reader;
GRANT SELECT ON public.analytics_purchases,
                   public.analytics_purchase_items
TO chatgpt_reader;
```

Do not grant `chatgpt_reader` access to `receipts`, `receipt_items`, `receipt_raw`, fiscal-fact tables, graph tables, ledger tables, or certification internals. No grants are included in this phase.

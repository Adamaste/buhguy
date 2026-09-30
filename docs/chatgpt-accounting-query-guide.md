# ChatGPT Accounting Query Guide

## Routing

### Ordinary analytics

Start with `analytics_purchases` and `analytics_purchase_items` for spending,
products, sellers, price history, and period summaries. Do not reconstruct
purchase totals from raw receipts when these curated views answer the question.

### Why a result has a particular value

Traverse `receipts -> receipt_fiscal_facts -> business_events -> ledger_entries
and ledger_postings -> certification_facts -> analytics_*`. Report the layer
that made the decision and the evidence supporting it.

### Money movement

Use `ledger_entries`, `ledger_postings`, `certification_facts`, and related
business events for certified accounting movement. For bank evidence itself,
use `chatgpt_accounting.bank_transactions`; never claim bank cash flow from
`SUM(receipts.total_sum)`.

### Bank transactions

Start with `bank_transactions`, which is one row per normalized transaction.
Filter explicitly on `normalization_status`, `normalization_version`,
`event_type`, `direction`, `currency`, and `evidence_quality`. Join the
transaction-grain resolution views on `bank_transaction_id`:

- `bank_transaction_account_resolution` for `EXACT`, `MANUAL`, `RECONCILED`,
  or `UNKNOWN` account state, safe resolved-account label, and explicit owner/
  authorized-user person relations;
- `bank_transaction_payment_instrument_resolution` for separate card or
  payment-instrument evidence with explicit owner/authorized-user relations;
- `bank_transaction_person_context` for aggregated capture context only.

Use an explicit account resolution (and its proven account-person relation)
for questions about “my” bank account. Never treat source-person context as
ownership, never infer an account from a card, and never convert UNKNOWN or
PARTIAL evidence into a person assignment. Do not join raw source-person
rows directly to transactions because that can multiply amounts.

#### Safe bank query templates

These read-only templates use parameters rather than production identifiers.
They keep proven totals separate from unresolved evidence. Owner arrays are
evidence-backed; `source_context_person_ids` is capture context only and must
not be used as an ownership predicate.

**My proven incoming transfers for a period**

```sql
SELECT bt.id, bt.occurred_at, bt.amount, bt.currency, bt.event_type,
       bt.direction, bt.account_resolution_state,
       bt.financial_account_id, bt.payment_instrument_id
FROM chatgpt_accounting.bank_transactions AS bt
WHERE bt.occurred_at >= $from
  AND bt.occurred_at < $to
  AND bt.normalization_status = 'READY'
  AND bt.event_type = 'INCOMING_TRANSFER'
  AND bt.direction = 'CREDIT'
  AND bt.amount IS NOT NULL
  AND bt.currency IS NOT NULL
  AND (
    $person_id = ANY(COALESCE(bt.financial_account_owner_person_ids, '{}'::bigint[]))
    OR $person_id = ANY(COALESCE(bt.payment_instrument_owner_person_ids, '{}'::bigint[]))
  )
ORDER BY bt.occurred_at, bt.id;
```

**Sum of my proven incoming transfers for a period**

Use the same proven predicates and owner evidence; sum at transaction grain so
relation joins cannot fan out the amount.

```sql
SELECT COALESCE(SUM(bt.amount), 0) AS incoming_total,
       COUNT(*) AS transaction_count
FROM chatgpt_accounting.bank_transactions AS bt
WHERE bt.occurred_at >= $from
  AND bt.occurred_at < $to
  AND bt.normalization_status = 'READY'
  AND bt.event_type = 'INCOMING_TRANSFER'
  AND bt.direction = 'CREDIT'
  AND bt.amount IS NOT NULL
  AND bt.currency IS NOT NULL
  AND (
    $person_id = ANY(COALESCE(bt.financial_account_owner_person_ids, '{}'::bigint[]))
    OR $person_id = ANY(COALESCE(bt.payment_instrument_owner_person_ids, '{}'::bigint[]))
  );
```

**My proven bank debits for a period**

This card-evidence query intentionally allows account resolution to remain
`UNKNOWN`; a payment-instrument owner is not an account owner.

```sql
SELECT bt.id, bt.occurred_at, bt.amount, bt.currency, bt.event_type,
       bt.direction, bt.account_resolution_state,
       bt.payment_instrument_resolution_state, bt.payment_instrument_id
FROM chatgpt_accounting.bank_transactions AS bt
WHERE bt.occurred_at >= $from
  AND bt.occurred_at < $to
  AND bt.normalization_status = 'READY'
  AND bt.direction = 'DEBIT'
  AND bt.amount IS NOT NULL
  AND bt.currency IS NOT NULL
  AND (
    $person_id = ANY(COALESCE(bt.financial_account_owner_person_ids, '{}'::bigint[]))
    OR $person_id = ANY(COALESCE(bt.payment_instrument_owner_person_ids, '{}'::bigint[]))
  )
ORDER BY bt.occurred_at, bt.id;
```

**Unresolved or partial bank operations**

Query these separately; do not include them in proven totals.

```sql
SELECT bt.id, bt.occurred_at, bt.amount, bt.currency,
       bt.normalization_status, bt.event_type, bt.direction,
       bt.account_resolution_state, bt.payment_instrument_resolution_state
FROM chatgpt_accounting.bank_transactions AS bt
WHERE bt.normalization_status IN ('UNKNOWN', 'PARTIAL')
   OR bt.account_resolution_state IN ('UNKNOWN', 'AMBIGUOUS')
   OR (bt.normalization_status <> 'READY'
       AND bt.payment_instrument_resolution_state IN ('UNKNOWN', 'AMBIGUOUS'))
ORDER BY bt.occurred_at, bt.id;
```

**Resolution status for one operation**

```sql
SELECT bt.id,
       ar.resolution_state AS account_resolution_state,
       ar.financial_account_id,
       ar.financial_account_owner_person_ids,
       ar.financial_account_authorized_user_person_ids,
       ar.provenance AS account_resolution_provenance,
       pir.resolution_state AS payment_instrument_resolution_state,
       pir.payment_instrument_id,
       pir.payment_instrument_owner_person_ids,
       pir.payment_instrument_authorized_user_person_ids,
       pir.provenance AS payment_instrument_resolution_provenance
FROM chatgpt_accounting.bank_transactions AS bt
JOIN chatgpt_accounting.bank_transaction_account_resolution AS ar
  ON ar.bank_transaction_id = bt.id
JOIN chatgpt_accounting.bank_transaction_payment_instrument_resolution AS pir
  ON pir.bank_transaction_id = bt.id
WHERE bt.id = $bank_transaction_id;
```

**Bank-operation candidate near a receipt**

This is an amount/time/account-context candidate query only. It is not a
purchase match and not reconciliation.

```sql
SELECT bt.id, bt.occurred_at, bt.amount, bt.currency, bt.direction,
       bt.event_type, bt.normalization_status, bt.account_resolution_state,
       bt.financial_account_id, bt.source_context_person_ids
FROM chatgpt_accounting.bank_transactions AS bt
WHERE bt.amount = $amount
  AND bt.occurred_at >= $receipt_time - $time_window
  AND bt.occurred_at <  $receipt_time + $time_window
ORDER BY ABS(EXTRACT(EPOCH FROM (bt.occurred_at - $receipt_time))), bt.id;
```

The current proven operation envelope is Sber incoming/CREDIT v3. Yandex
incoming/CREDIT is proven only to the extent supported by its deployed v1
parser/evidence; Yandex outgoing/DEBIT transfer is NOT_PROVEN. T-Bank, Alfa,
Ozon, and VTB remain incremental evidence coverage rather than assumptions of
READY semantics.

### Items

Use `analytics_purchase_items` for ordinary item analysis. Use
`receipt_items` plus the proof chain for forensic analysis. An item line is not
an independent purchase.

### Prepayment, settlement, advance, return, and refund

Inspect `business_events`, `business_event_edges`, `business_event_evidence`,
`ledger_entries`, `ledger_postings`, and `certification_facts`. Do not add
prepayment and settlement as two independent purchases.

### Source ownership and provenance

Use `persons`, `fns_sources`, `fns_source_person`,
`receipt_source_observations`, and `fns_source_receipt_refs`. State explicitly
that source provenance means “observed through this FNS source”; it does not
prove payer, owner, or bank-account holder.

### Completeness and duplicates

Use `fns_source_receipt_refs`, `receipt_source_observations`, `receipts`, and
`fns_source_sync_state`. Test canonical identity using `receipts.fns_id`, not
person/source identity. Multiple observations are not duplicate receipts.

### Accounting gaps

Check normalization, graph, ledger, certification, then analytics. Treat
explicit non-acquisition, blocked, unresolved, and unavailable states as
classified outcomes unless the model says they are defects.

## Prohibited conclusions

Do not infer a precise amount when evidence is incomplete. Do not equate a
receipt with a purchase, a source person with a payer, a missing component with
zero, or `BLOCKED_EXPOSURE` with certified acquisition.

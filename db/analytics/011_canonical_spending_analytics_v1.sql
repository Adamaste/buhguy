-- Snapshot-qualified, fan-out-safe canonical spending read model.
-- This artifact is additive and is not part of the runtime migration loader.
-- Do not expose it to assistants until a reviewed current-snapshot contract
-- exists. Never SUM chatgpt_accounting.user_receipts as spending.

CREATE OR REPLACE VIEW canonical_spending_purchases_v1 AS
SELECT f.scope_id,
       f.run_id AS certification_run_id,
       r.model_version AS certification_model_version,
       f.source_state_key,
       f.id AS certification_fact_id,
       f.business_event_id AS purchase_id,
       f.amount,
       f.currency,
       f.event_at AS purchased_at,
       f.rule_code,
       f.rule_version,
       f.semantic_key
FROM certification_facts f
JOIN reconciliation_runs r ON r.id=f.run_id
WHERE f.metric_code='CONFIRMED_ACQUISITION_VALUE'
  AND f.status='CERTIFIED';

CREATE OR REPLACE VIEW canonical_spending_returns_v1 AS
SELECT f.scope_id,
       f.run_id AS certification_run_id,
       r.model_version AS certification_model_version,
       f.source_state_key,
       f.id AS certification_fact_id,
       f.business_event_id AS return_id,
       f.amount AS return_amount,
       f.currency,
       f.event_at AS returned_at,
       f.rule_code,
       f.rule_version,
       f.semantic_key,
       COALESCE(rr.relationship_status, 'UNATTRIBUTED') AS relationship_status,
       rr.purchase_event_id AS related_purchase_id,
       rr.receipt_item_id AS related_receipt_item_id
FROM certification_facts f
JOIN reconciliation_runs r ON r.id=f.run_id
LEFT JOIN LATERAL (
  SELECT relationship_status, purchase_event_id, receipt_item_id
  FROM spending_return_relationships
  WHERE scope_id=f.scope_id AND return_event_id=f.business_event_id
    AND relationship_status <> 'SUPERSEDED'
  ORDER BY id DESC
  LIMIT 1
) rr ON TRUE
WHERE f.metric_code='CONFIRMED_RETURN_VALUE'
  AND f.status='CERTIFIED';

CREATE OR REPLACE VIEW canonical_spending_items_v1 AS
SELECT p.scope_id, p.certification_run_id, p.certification_model_version,
       p.source_state_key, p.certification_fact_id, p.purchase_id,
       p.currency, p.purchased_at, i.id AS receipt_item_id,
       i.position AS item_position, i.name AS item_name, i.quantity,
       i.price, i.item_sum, i.nds,
       CASE
         WHEN i.id IS NULL THEN 'NO_ITEMS'
         WHEN COALESCE(item_totals.item_sum, 0) = p.amount THEN 'RECONCILED'
         ELSE 'MISMATCH'
       END AS item_reconciliation_status
FROM canonical_spending_purchases_v1 p
LEFT JOIN LATERAL (
  SELECT e.receipt_id
  FROM business_event_evidence e
  WHERE e.event_id=p.purchase_id AND e.receipt_id IS NOT NULL
  ORDER BY e.id
  LIMIT 1
) evidence ON TRUE
LEFT JOIN receipt_items i ON i.receipt_id=evidence.receipt_id
LEFT JOIN LATERAL (
  SELECT SUM(item_sum)::NUMERIC(18,2) AS item_sum
  FROM receipt_items
  WHERE receipt_id=evidence.receipt_id
) item_totals ON TRUE;

CREATE OR REPLACE VIEW canonical_spending_category_allocations_v1 AS
WITH explicit_rows AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id AS subject_event_id, p.currency,
         c.category_code, a.amount AS category_gross,
         0::NUMERIC(18,2) AS category_returns, a.allocation_status
  FROM canonical_spending_purchases_v1 p
  JOIN spending_category_allocations a
    ON a.scope_id=p.scope_id AND a.certification_run_id=p.certification_run_id
   AND a.source_state_key=p.source_state_key AND a.allocation_kind='PURCHASE'
   AND a.subject_event_id=p.purchase_id AND a.supersedes_allocation_id IS NULL
  JOIN spending_categories c ON c.id=a.category_id
  UNION ALL
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id, r.currency, c.category_code,
         0::NUMERIC(18,2), r.return_amount, a.allocation_status
  FROM canonical_spending_returns_v1 r
  JOIN spending_category_allocations a
    ON a.scope_id=r.scope_id AND a.certification_run_id=r.certification_run_id
   AND a.source_state_key=r.source_state_key AND a.allocation_kind='RETURN'
   AND a.subject_event_id=r.return_id AND a.supersedes_allocation_id IS NULL
  JOIN spending_categories c ON c.id=a.category_id
), fallback_rows AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id AS subject_event_id, p.currency, 'UNCLASSIFIED' AS category_code,
         p.amount AS category_gross, 0::NUMERIC(18,2) AS category_returns,
         'UNCLASSIFIED' AS allocation_status
  FROM canonical_spending_purchases_v1 p
  WHERE NOT EXISTS (
    SELECT 1 FROM spending_category_allocations a
    WHERE a.scope_id=p.scope_id AND a.certification_run_id=p.certification_run_id
      AND a.source_state_key=p.source_state_key AND a.allocation_kind='PURCHASE'
      AND a.subject_event_id=p.purchase_id AND a.supersedes_allocation_id IS NULL
  )
  UNION ALL
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id, r.currency, 'UNRESOLVED_RETURN',
         0::NUMERIC(18,2), r.return_amount, 'REVIEW_REQUIRED'
  FROM canonical_spending_returns_v1 r
  WHERE NOT EXISTS (
    SELECT 1 FROM spending_category_allocations a
    WHERE a.scope_id=r.scope_id AND a.certification_run_id=r.certification_run_id
      AND a.source_state_key=r.source_state_key AND a.allocation_kind='RETURN'
      AND a.subject_event_id=r.return_id AND a.supersedes_allocation_id IS NULL
  )
)
SELECT * FROM explicit_rows
UNION ALL
SELECT * FROM fallback_rows;

CREATE OR REPLACE VIEW canonical_spending_person_allocations_v1 AS
WITH explicit_rows AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id AS subject_event_id, a.person_id, p.currency,
         a.amount AS person_gross, 0::NUMERIC(18,2) AS person_returns,
         a.allocation_status
  FROM canonical_spending_purchases_v1 p
  JOIN spending_person_allocations a
    ON a.scope_id=p.scope_id AND a.certification_run_id=p.certification_run_id
   AND a.source_state_key=p.source_state_key AND a.allocation_kind='PURCHASE'
   AND a.subject_event_id=p.purchase_id AND a.supersedes_allocation_id IS NULL
  UNION ALL
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id, a.person_id, r.currency,
         0::NUMERIC(18,2), a.amount, a.allocation_status
  FROM canonical_spending_returns_v1 r
  JOIN spending_person_allocations a
    ON a.scope_id=r.scope_id AND a.certification_run_id=r.certification_run_id
   AND a.source_state_key=r.source_state_key AND a.allocation_kind='RETURN'
   AND a.subject_event_id=r.return_id AND a.supersedes_allocation_id IS NULL
), fallback_rows AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id, NULL::BIGINT, p.currency,
         p.amount, 0::NUMERIC(18,2), 'UNATTRIBUTED'
  FROM canonical_spending_purchases_v1 p
  WHERE NOT EXISTS (
    SELECT 1 FROM spending_person_allocations a
    WHERE a.scope_id=p.scope_id AND a.certification_run_id=p.certification_run_id
      AND a.source_state_key=p.source_state_key AND a.allocation_kind='PURCHASE'
      AND a.subject_event_id=p.purchase_id AND a.supersedes_allocation_id IS NULL
  )
  UNION ALL
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id, NULL::BIGINT, r.currency,
         0::NUMERIC(18,2), r.return_amount, 'REVIEW_REQUIRED'
  FROM canonical_spending_returns_v1 r
  WHERE NOT EXISTS (
    SELECT 1 FROM spending_person_allocations a
    WHERE a.scope_id=r.scope_id AND a.certification_run_id=r.certification_run_id
      AND a.source_state_key=r.source_state_key AND a.allocation_kind='RETURN'
      AND a.subject_event_id=r.return_id AND a.supersedes_allocation_id IS NULL
  )
)
SELECT * FROM explicit_rows
UNION ALL
SELECT * FROM fallback_rows;

CREATE OR REPLACE VIEW canonical_spending_household_summary_v1 AS
SELECT p.scope_id, p.certification_run_id, p.certification_model_version,
       p.source_state_key, p.currency,
       SUM(p.amount)::NUMERIC(18,2) AS gross_spend,
       COALESCE((SELECT SUM(r.return_amount) FROM canonical_spending_returns_v1 r
         WHERE r.scope_id=p.scope_id AND r.certification_run_id=p.certification_run_id
           AND r.source_state_key=p.source_state_key AND r.currency=p.currency), 0)::NUMERIC(18,2) AS confirmed_returns,
       (SUM(p.amount) - COALESCE((SELECT SUM(r.return_amount) FROM canonical_spending_returns_v1 r
         WHERE r.scope_id=p.scope_id AND r.certification_run_id=p.certification_run_id
           AND r.source_state_key=p.source_state_key AND r.currency=p.currency), 0))::NUMERIC(18,2) AS net_spend
FROM canonical_spending_purchases_v1 p
GROUP BY p.scope_id, p.certification_run_id, p.certification_model_version, p.source_state_key, p.currency;

CREATE OR REPLACE VIEW canonical_spending_category_summary_v1 AS
SELECT scope_id, certification_run_id, source_state_key, currency, category_code,
       SUM(category_gross)::NUMERIC(18,2) AS gross_spend,
       SUM(category_returns)::NUMERIC(18,2) AS confirmed_returns,
       (SUM(category_gross)-SUM(category_returns))::NUMERIC(18,2) AS net_spend
FROM canonical_spending_category_allocations_v1
GROUP BY scope_id, certification_run_id, source_state_key, currency, category_code;

CREATE OR REPLACE VIEW canonical_spending_person_summary_v1 AS
SELECT scope_id, certification_run_id, source_state_key, currency, person_id,
       SUM(person_gross)::NUMERIC(18,2) AS gross_spend,
       SUM(person_returns)::NUMERIC(18,2) AS confirmed_returns,
       (SUM(person_gross)-SUM(person_returns))::NUMERIC(18,2) AS net_spend,
       CASE WHEN person_id IS NULL THEN 'UNATTRIBUTED' ELSE 'ATTRIBUTED' END AS attribution_status
FROM canonical_spending_person_allocations_v1
GROUP BY scope_id, certification_run_id, source_state_key, currency, person_id;

COMMENT ON VIEW canonical_spending_household_summary_v1 IS 'Snapshot-qualified household totals. Do not combine source_state_key values.';
COMMENT ON VIEW canonical_spending_category_summary_v1 IS 'Fan-out-safe category totals with explicit unclassified and unresolved-return buckets.';
COMMENT ON VIEW canonical_spending_person_summary_v1 IS 'Explicit person allocations only; source/person provenance does not allocate money.';

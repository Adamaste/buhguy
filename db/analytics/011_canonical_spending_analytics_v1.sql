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
       f.graph_evidence_id,
       f.amount,
       f.currency,
       f.event_at AS purchased_at,
       f.rule_code,
       f.rule_version,
       f.semantic_key
FROM certification_facts f
JOIN reconciliation_runs r
  ON r.scope_id=f.scope_id AND r.id=f.run_id
WHERE r.status='READY'
  AND f.scope_id=r.scope_id
  AND f.source_state_key=r.source_state_key
  AND f.metric_code='CONFIRMED_ACQUISITION_VALUE'
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
JOIN reconciliation_runs r
  ON r.scope_id=f.scope_id AND r.id=f.run_id
LEFT JOIN LATERAL (
  SELECT relationship_status, purchase_event_id, receipt_item_id
  FROM spending_return_relationships rel
  WHERE rel.scope_id=f.scope_id AND rel.return_event_id=f.business_event_id
    AND rel.relationship_status <> 'SUPERSEDED'
    AND NOT EXISTS (
      SELECT 1
      FROM spending_return_relationships successor
      WHERE successor.scope_id=rel.scope_id
        AND successor.supersedes_relationship_id=rel.id
    )
  ORDER BY rel.id DESC
  LIMIT 1
) rr ON TRUE
WHERE r.status='READY'
  AND f.scope_id=r.scope_id
  AND f.source_state_key=r.source_state_key
  AND f.metric_code='CONFIRMED_RETURN_VALUE'
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
LEFT JOIN business_event_evidence proof
  ON proof.id=p.graph_evidence_id
 AND proof.event_id=p.purchase_id
 AND proof.receipt_id IS NOT NULL
LEFT JOIN receipt_items i ON i.receipt_id=proof.receipt_id
LEFT JOIN LATERAL (
  SELECT SUM(item_sum)::NUMERIC(18,2) AS item_sum
  FROM receipt_items
  WHERE receipt_id=proof.receipt_id
) item_totals ON TRUE;

CREATE OR REPLACE VIEW canonical_spending_category_allocations_v1 AS
WITH purchase_stats AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id AS subject_event_id, p.currency, p.amount,
         COALESCE(SUM(a.amount) FILTER (
           WHERE a.allocation_status='ALLOCATED'
             AND NOT EXISTS (SELECT 1 FROM spending_category_allocations s
                             WHERE s.scope_id=a.scope_id
                               AND s.supersedes_allocation_id=a.id)
         ), 0)::NUMERIC(18,2) AS allocated,
         COALESCE(BOOL_OR(a.allocation_status <> 'ALLOCATED'
           OR a.currency <> p.currency
           OR a.scope_id <> p.scope_id
           OR a.certification_run_id <> p.certification_run_id
           OR a.source_state_key <> p.source_state_key), FALSE) AS conflict,
         COUNT(a.id) > 0 AS has_rows
  FROM canonical_spending_purchases_v1 p
  LEFT JOIN spending_category_allocations a
    ON a.subject_event_id=p.purchase_id AND a.allocation_kind='PURCHASE'
  GROUP BY p.scope_id, p.certification_run_id, p.source_state_key, p.purchase_id, p.currency, p.amount
), return_stats AS (
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id AS subject_event_id, r.currency, r.return_amount,
         COALESCE(SUM(a.amount) FILTER (
           WHERE a.allocation_status='ALLOCATED'
             AND NOT EXISTS (SELECT 1 FROM spending_category_allocations s
                             WHERE s.scope_id=a.scope_id
                               AND s.supersedes_allocation_id=a.id)
         ), 0)::NUMERIC(18,2) AS allocated,
         COALESCE(BOOL_OR(a.allocation_status <> 'ALLOCATED'
           OR a.currency <> r.currency
           OR a.scope_id <> r.scope_id
           OR a.certification_run_id <> r.certification_run_id
           OR a.source_state_key <> r.source_state_key), FALSE) AS conflict,
         COUNT(a.id) > 0 AS has_rows
  FROM canonical_spending_returns_v1 r
  LEFT JOIN spending_category_allocations a
    ON a.subject_event_id=r.return_id AND a.allocation_kind='RETURN'
  GROUP BY r.scope_id, r.certification_run_id, r.source_state_key, r.return_id, r.currency, r.return_amount
), explicit_rows AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id AS subject_event_id, p.currency,
         c.category_code, a.amount AS category_gross,
         0::NUMERIC(18,2) AS category_returns, a.allocation_status
  FROM canonical_spending_purchases_v1 p
  JOIN spending_category_allocations a
    ON a.scope_id=p.scope_id AND a.certification_run_id=p.certification_run_id
   AND a.source_state_key=p.source_state_key AND a.allocation_kind='PURCHASE'
   AND a.subject_event_id=p.purchase_id AND a.allocation_status='ALLOCATED'
   AND NOT EXISTS (SELECT 1 FROM spending_category_allocations s
                   WHERE s.scope_id=a.scope_id AND s.supersedes_allocation_id=a.id)
  JOIN purchase_stats ps
    ON ps.scope_id=p.scope_id AND ps.certification_run_id=p.certification_run_id
   AND ps.source_state_key=p.source_state_key AND ps.subject_event_id=p.purchase_id
   AND NOT ps.conflict
  JOIN spending_categories c ON c.id=a.category_id
  UNION ALL
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id, r.currency, c.category_code,
         0::NUMERIC(18,2), a.amount, a.allocation_status
  FROM canonical_spending_returns_v1 r
  JOIN spending_category_allocations a
    ON a.scope_id=r.scope_id AND a.certification_run_id=r.certification_run_id
   AND a.source_state_key=r.source_state_key AND a.allocation_kind='RETURN'
   AND a.subject_event_id=r.return_id AND a.allocation_status='ALLOCATED'
   AND NOT EXISTS (SELECT 1 FROM spending_category_allocations s
                   WHERE s.scope_id=a.scope_id AND s.supersedes_allocation_id=a.id)
  JOIN return_stats rs
    ON rs.scope_id=r.scope_id AND rs.certification_run_id=r.certification_run_id
   AND rs.source_state_key=r.source_state_key AND rs.subject_event_id=r.return_id
   AND NOT rs.conflict
  JOIN spending_categories c ON c.id=a.category_id
), fallback_rows AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id, p.currency, 'UNCLASSIFIED',
         CASE WHEN s.conflict THEN p.amount ELSE p.amount-s.allocated END,
         0::NUMERIC(18,2), CASE WHEN s.conflict THEN 'REVIEW_REQUIRED' ELSE 'UNCLASSIFIED' END
  FROM purchase_stats s JOIN canonical_spending_purchases_v1 p
    ON p.scope_id=s.scope_id AND p.certification_run_id=s.certification_run_id
   AND p.source_state_key=s.source_state_key AND p.purchase_id=s.subject_event_id
  WHERE s.conflict OR NOT s.has_rows OR s.allocated < s.amount
  UNION ALL
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id, r.currency, 'UNRESOLVED_RETURN',
         0::NUMERIC(18,2), CASE WHEN s.conflict THEN s.return_amount ELSE s.return_amount-s.allocated END,
         CASE WHEN s.conflict THEN 'REVIEW_REQUIRED' ELSE 'REVIEW_REQUIRED' END
  FROM return_stats s JOIN canonical_spending_returns_v1 r
    ON r.scope_id=s.scope_id AND r.certification_run_id=s.certification_run_id
   AND r.source_state_key=s.source_state_key AND r.return_id=s.subject_event_id
  WHERE s.conflict OR NOT s.has_rows OR s.allocated < s.return_amount
)
SELECT * FROM explicit_rows
UNION ALL
SELECT * FROM fallback_rows;

CREATE OR REPLACE VIEW canonical_spending_person_allocations_v1 AS
WITH purchase_stats AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id AS subject_event_id, p.currency, p.amount,
         COALESCE(SUM(a.amount) FILTER (
           WHERE a.allocation_status='ALLOCATED'
             AND NOT EXISTS (SELECT 1 FROM spending_person_allocations s
                             WHERE s.scope_id=a.scope_id
                               AND s.supersedes_allocation_id=a.id)
         ), 0)::NUMERIC(18,2) AS allocated,
         COALESCE(BOOL_OR(a.allocation_status <> 'ALLOCATED'
           OR a.currency <> p.currency
           OR a.scope_id <> p.scope_id
           OR a.certification_run_id <> p.certification_run_id
           OR a.source_state_key <> p.source_state_key), FALSE) AS conflict,
         COUNT(a.id) > 0 AS has_rows
  FROM canonical_spending_purchases_v1 p
  LEFT JOIN spending_person_allocations a
    ON a.subject_event_id=p.purchase_id AND a.allocation_kind='PURCHASE'
  GROUP BY p.scope_id, p.certification_run_id, p.source_state_key, p.purchase_id, p.currency, p.amount
), return_stats AS (
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id AS subject_event_id, r.currency, r.return_amount,
         COALESCE(SUM(a.amount) FILTER (
           WHERE a.allocation_status='ALLOCATED'
             AND NOT EXISTS (SELECT 1 FROM spending_person_allocations s
                             WHERE s.scope_id=a.scope_id
                               AND s.supersedes_allocation_id=a.id)
         ), 0)::NUMERIC(18,2) AS allocated,
         COALESCE(BOOL_OR(a.allocation_status <> 'ALLOCATED'
           OR a.currency <> r.currency
           OR a.scope_id <> r.scope_id
           OR a.certification_run_id <> r.certification_run_id
           OR a.source_state_key <> r.source_state_key), FALSE) AS conflict,
         COUNT(a.id) > 0 AS has_rows
  FROM canonical_spending_returns_v1 r
  LEFT JOIN spending_person_allocations a
    ON a.subject_event_id=r.return_id AND a.allocation_kind='RETURN'
  GROUP BY r.scope_id, r.certification_run_id, r.source_state_key, r.return_id, r.currency, r.return_amount
), explicit_rows AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id AS subject_event_id, a.person_id, p.currency,
         a.amount AS person_gross, 0::NUMERIC(18,2) AS person_returns, a.allocation_status
  FROM canonical_spending_purchases_v1 p
  JOIN spending_person_allocations a
    ON a.scope_id=p.scope_id AND a.certification_run_id=p.certification_run_id
   AND a.source_state_key=p.source_state_key AND a.allocation_kind='PURCHASE'
   AND a.subject_event_id=p.purchase_id AND a.allocation_status='ALLOCATED'
   AND NOT EXISTS (SELECT 1 FROM spending_person_allocations s
                   WHERE s.scope_id=a.scope_id AND s.supersedes_allocation_id=a.id)
  JOIN purchase_stats ps
    ON ps.scope_id=p.scope_id AND ps.certification_run_id=p.certification_run_id
   AND ps.source_state_key=p.source_state_key AND ps.subject_event_id=p.purchase_id
   AND NOT ps.conflict
  UNION ALL
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id, a.person_id, r.currency,
         0::NUMERIC(18,2), a.amount, a.allocation_status
  FROM canonical_spending_returns_v1 r
  JOIN spending_person_allocations a
    ON a.scope_id=r.scope_id AND a.certification_run_id=r.certification_run_id
   AND a.source_state_key=r.source_state_key AND a.allocation_kind='RETURN'
   AND a.subject_event_id=r.return_id AND a.allocation_status='ALLOCATED'
   AND NOT EXISTS (SELECT 1 FROM spending_person_allocations s
                   WHERE s.scope_id=a.scope_id AND s.supersedes_allocation_id=a.id)
  JOIN return_stats rs
    ON rs.scope_id=r.scope_id AND rs.certification_run_id=r.certification_run_id
   AND rs.source_state_key=r.source_state_key AND rs.subject_event_id=r.return_id
   AND NOT rs.conflict
), fallback_rows AS (
  SELECT p.scope_id, p.certification_run_id, p.source_state_key,
         p.purchase_id, NULL::BIGINT, p.currency,
         CASE WHEN s.conflict THEN p.amount ELSE p.amount-s.allocated END, 0::NUMERIC(18,2),
         CASE WHEN s.conflict THEN 'REVIEW_REQUIRED' ELSE 'UNATTRIBUTED' END
  FROM purchase_stats s JOIN canonical_spending_purchases_v1 p
    ON p.scope_id=s.scope_id AND p.certification_run_id=s.certification_run_id
   AND p.source_state_key=s.source_state_key AND p.purchase_id=s.subject_event_id
  WHERE s.conflict OR NOT s.has_rows OR s.allocated < s.amount
  UNION ALL
  SELECT r.scope_id, r.certification_run_id, r.source_state_key,
         r.return_id, NULL::BIGINT, r.currency,
         0::NUMERIC(18,2), CASE WHEN s.conflict THEN s.return_amount ELSE s.return_amount-s.allocated END,
         'REVIEW_REQUIRED'
  FROM return_stats s JOIN canonical_spending_returns_v1 r
    ON r.scope_id=s.scope_id AND r.certification_run_id=s.certification_run_id
   AND r.source_state_key=s.source_state_key AND r.return_id=s.subject_event_id
  WHERE s.conflict OR NOT s.has_rows OR s.allocated < s.return_amount
)
SELECT * FROM explicit_rows
UNION ALL
SELECT * FROM fallback_rows;

CREATE OR REPLACE VIEW canonical_spending_household_summary_v1 AS
WITH monetary AS (
  SELECT scope_id, certification_run_id, certification_model_version, source_state_key,
         currency, amount AS gross_spend, 0::NUMERIC(18,2) AS confirmed_returns
  FROM canonical_spending_purchases_v1
  UNION ALL
  SELECT scope_id, certification_run_id, certification_model_version, source_state_key,
         currency, 0::NUMERIC(18,2), return_amount
  FROM canonical_spending_returns_v1
)
SELECT scope_id, certification_run_id, certification_model_version, source_state_key, currency,
       SUM(gross_spend)::NUMERIC(18,2) AS gross_spend,
       SUM(confirmed_returns)::NUMERIC(18,2) AS confirmed_returns,
       (SUM(gross_spend)-SUM(confirmed_returns))::NUMERIC(18,2) AS net_spend
FROM monetary
GROUP BY scope_id, certification_run_id, certification_model_version, source_state_key, currency;

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

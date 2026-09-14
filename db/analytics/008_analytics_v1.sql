-- Analytics V1 curated, read-only source surfaces.
-- Apply only through a separately approved deployment; this directory is not
-- scanned by the runtime migration loader.
CREATE OR REPLACE VIEW analytics_certification_facts AS
SELECT f.id, f.scope_id, f.subject_type, f.subject_id, f.metric_code, f.dimension,
       f.status, f.amount, f.currency, f.event_at, f.reason_code, f.rule_code,
       f.rule_version, f.ledger_entry_id, f.business_event_id, f.graph_evidence_id,
       f.source_state_key
FROM certification_facts f;

CREATE OR REPLACE VIEW analytics_blocked_exposure AS
SELECT id, scope_id, subject_id, amount, currency, event_at, reason_code,
       rule_code, rule_version, ledger_entry_id, business_event_id,
       graph_evidence_id, source_state_key
FROM analytics_certification_facts
WHERE metric_code = 'BLOCKED_EXPOSURE' AND status = 'BLOCKED';

CREATE OR REPLACE VIEW analytics_proof_chain AS
SELECT f.id AS certification_fact_id, f.metric_code, f.status, f.amount, f.currency,
       f.event_at, f.reason_code, f.rule_code, f.rule_version,
       f.source_state_key, f.ledger_entry_id, f.business_event_id,
       f.graph_evidence_id, e.event_type, e.resolution_status, e.origin,
       e.graph_model_version, e.semantic_key AS event_semantic_key,
       l.receipt_id, l.normalization_version, rff.normalized_content_sha256,
       rff.normalization_status, rff.fiscal_operation_type, rff.payment_stage
FROM analytics_certification_facts f
JOIN business_events e ON e.id = f.business_event_id
LEFT JOIN ledger_source_links l ON l.ledger_entry_id = f.ledger_entry_id
LEFT JOIN receipt_fiscal_facts rff ON rff.receipt_id = l.receipt_id
  AND rff.normalization_version = l.normalization_version
WHERE f.status IN ('CERTIFIED', 'PROVISIONAL', 'BLOCKED');

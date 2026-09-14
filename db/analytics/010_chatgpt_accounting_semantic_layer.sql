-- ChatGPT accounting semantic layer.
-- Apply separately as an approved read-only access deployment.
-- This file does not write or alter any public accounting rows.

CREATE SCHEMA IF NOT EXISTS chatgpt_accounting;
REVOKE ALL ON SCHEMA chatgpt_accounting FROM PUBLIC;

CREATE OR REPLACE VIEW chatgpt_accounting.receipts AS
SELECT id, fns_id, date_time, seller, seller_inn, total_sum, currency,
       source, received_at, fiscal_document_number, fiscal_drive_number,
       fiscal_sign, kkt_reg_id, raw_updated_at
FROM public.receipts;

CREATE OR REPLACE VIEW chatgpt_accounting.receipt_items AS
SELECT id, receipt_id, position, name, quantity, price, item_sum,
       provider_inn, nds
FROM public.receipt_items;

CREATE OR REPLACE VIEW chatgpt_accounting.receipt_fiscal_facts AS
SELECT receipt_id, normalization_version, normalization_status,
       ffd_version_code, ffd_version, fiscal_operation_type,
       household_cash_direction, cash_total_sum, cash_total_state,
       ecash_total_sum, ecash_total_state, prepaid_sum, prepaid_state,
       credit_sum, credit_state, provision_sum, provision_state,
       payment_components_status, payment_stage, correction_status,
       normalized_at
FROM public.receipt_fiscal_facts;

CREATE OR REPLACE VIEW chatgpt_accounting.receipt_item_fiscal_facts AS
SELECT receipt_item_id, normalization_version, payment_type_code,
       payment_type_semantic, product_type_code, provider_inn, gtin,
       normalized_at
FROM public.receipt_item_fiscal_facts;

CREATE OR REPLACE VIEW chatgpt_accounting.normalization_issues AS
SELECT id, receipt_id, receipt_item_id, normalization_version,
       issue_code, detected_at
FROM public.normalization_issues;

CREATE OR REPLACE VIEW chatgpt_accounting.business_events AS
SELECT id, scope_id, event_type, resolution_status, origin,
       graph_model_version, rule_code, rule_version, semantic_key,
       amount, currency, description, created_at
FROM public.business_events;

CREATE OR REPLACE VIEW chatgpt_accounting.business_event_evidence AS
SELECT id, event_id, receipt_id, receipt_item_id, normalization_version,
       evidence_role, origin, graph_model_version, rule_code,
       rule_version, semantic_key, created_at
FROM public.business_event_evidence;

CREATE OR REPLACE VIEW chatgpt_accounting.business_event_edges AS
SELECT id, scope_id, source_event_id, target_event_id, relation_type,
       resolution_status, origin, graph_model_version, rule_code,
       rule_version, semantic_key, explanation, created_at
FROM public.business_event_edges;

CREATE OR REPLACE VIEW chatgpt_accounting.business_event_allocations AS
SELECT id, scope_id, target_event_id, source_receipt_id,
       source_receipt_item_id, normalization_version, allocated_quantity,
       allocated_amount, currency, allocation_role, resolution_status,
       origin, graph_model_version, rule_code, rule_version, semantic_key,
       explanation, created_at
FROM public.business_event_allocations;

CREATE OR REPLACE VIEW chatgpt_accounting.ledger_accounts AS
SELECT id, scope_id, account_code, account_type, description, created_at
FROM public.ledger_accounts;

CREATE OR REPLACE VIEW chatgpt_accounting.ledger_entries AS
SELECT id, scope_id, source_event_id, currency, event_at, semantic_key,
       derivation_rule, derivation_version, derivation_status,
       certification_status, origin, reason_code, description, created_at
FROM public.ledger_entries;

CREATE OR REPLACE VIEW chatgpt_accounting.ledger_postings AS
SELECT id, ledger_entry_id, account_id, currency, debit, credit,
       source_allocation_id, source_receipt_id, created_at
FROM public.ledger_postings;

CREATE OR REPLACE VIEW chatgpt_accounting.ledger_source_links AS
SELECT id, ledger_entry_id, business_event_id, graph_evidence_id,
       graph_allocation_id, receipt_id, normalization_version, link_role,
       semantic_key, created_at
FROM public.ledger_source_links;

CREATE OR REPLACE VIEW chatgpt_accounting.certification_facts AS
SELECT id, run_id, scope_id, subject_type, subject_id, metric_code,
       dimension, status, amount, currency, event_at, reason_code,
       rule_code, rule_version, ledger_entry_id, business_event_id,
       graph_evidence_id, semantic_key, source_state_key, evaluated_at
FROM public.certification_facts;

CREATE OR REPLACE VIEW chatgpt_accounting.receipt_source_observations AS
SELECT id, receipt_id, fns_source_id, source_receipt_id,
       source_content_sha256, observed_at
FROM public.receipt_source_observations;

CREATE OR REPLACE VIEW chatgpt_accounting.fns_source_receipt_refs AS
SELECT id, fns_source_id, source_receipt_id, receipt_id, status,
       first_seen_at, last_seen_at, detail_last_attempt_at,
       detail_next_retry_at, detail_attempt_count, detail_http_status,
       detail_error_code, detail_error_signature, resolved_at, created_at,
       updated_at
FROM public.fns_source_receipt_refs;

CREATE OR REPLACE VIEW chatgpt_accounting.persons AS
SELECT id, scope_id, person_key, display_name, created_at
FROM public.persons;

CREATE OR REPLACE VIEW chatgpt_accounting.fns_sources AS
SELECT id, scope_id, source_key, display_name, enabled, created_at, updated_at
FROM public.fns_sources;

CREATE OR REPLACE VIEW chatgpt_accounting.fns_source_person AS
SELECT fns_source_id, person_id, relation_type, created_at
FROM public.fns_source_person;

CREATE OR REPLACE VIEW chatgpt_accounting.fns_source_sync_state AS
SELECT fns_source_id, last_sync_started_at, last_sync_finished_at,
       last_error, last_error_class, fetched_count, canonical_inserted_count,
       observation_replayed_count, updated_at
FROM public.fns_source_sync_state;

CREATE OR REPLACE VIEW chatgpt_accounting.analytics_purchases AS
SELECT purchase_id, scope_id, certification_fact_id, purchased_at, amount,
       currency, status, rule_code, event_type, receipt_id, seller,
       seller_inn, item_count
FROM public.analytics_purchases;

CREATE OR REPLACE VIEW chatgpt_accounting.analytics_purchase_items AS
SELECT scope_id, purchase_id, certification_fact_id, receipt_id,
       purchased_at, seller, seller_inn, item_position, item_name,
       quantity, price, item_sum, nds, currency
FROM public.analytics_purchase_items;

CREATE OR REPLACE VIEW chatgpt_accounting.reconciliation_runs AS
SELECT id, scope_id, model_version, source_state_key, period_from,
       period_to, status, started_at, finished_at
FROM public.reconciliation_runs;

CREATE OR REPLACE VIEW chatgpt_accounting.reconciliation_results AS
SELECT id, run_id, metric_code, status, amount, currency, count_items,
       reason_code, semantic_key, created_at
FROM public.reconciliation_results;

COMMENT ON SCHEMA chatgpt_accounting IS
'Read-only accounting semantic layer for ChatGPT. Select views in this schema in BlazeSQL. Use analytics_* for ordinary analytics and the proof-chain views for audit questions. Never infer payer or owner from FNS source provenance.';

COMMENT ON VIEW chatgpt_accounting.receipts IS 'One row per canonical fiscal receipt. Receipt is evidence, not automatically a purchase or cash-flow event.';
COMMENT ON VIEW chatgpt_accounting.receipt_items IS 'One row per item line of a canonical receipt. An item line is not independently an economic purchase.';
COMMENT ON VIEW chatgpt_accounting.receipt_fiscal_facts IS 'Normalized fiscal and payment semantics for a receipt; missing values remain explicit states.';
COMMENT ON VIEW chatgpt_accounting.receipt_item_fiscal_facts IS 'Normalized fiscal attributes for receipt item lines, excluding raw payload.';
COMMENT ON VIEW chatgpt_accounting.normalization_issues IS 'Detected normalization issues without raw diagnostic payload.';
COMMENT ON VIEW chatgpt_accounting.business_events IS 'Business graph events derived from normalized evidence.';
COMMENT ON VIEW chatgpt_accounting.business_event_evidence IS 'Links business events to normalized receipt or item evidence.';
COMMENT ON VIEW chatgpt_accounting.business_event_edges IS 'Directed relationships between business events.';
COMMENT ON VIEW chatgpt_accounting.business_event_allocations IS 'Allocations from receipt evidence to business events.';
COMMENT ON VIEW chatgpt_accounting.ledger_accounts IS 'Ledger account definitions within an accounting scope.';
COMMENT ON VIEW chatgpt_accounting.ledger_entries IS 'Double-entry ledger entries linked to business events.';
COMMENT ON VIEW chatgpt_accounting.ledger_postings IS 'Debit and credit postings belonging to ledger entries.';
COMMENT ON VIEW chatgpt_accounting.ledger_source_links IS 'Audit links from ledger entries to graph and receipt evidence.';
COMMENT ON VIEW chatgpt_accounting.certification_facts IS 'Certification results for accounting subjects; use with ledger and graph evidence.';
COMMENT ON VIEW chatgpt_accounting.receipt_source_observations IS 'Append-only provenance: a source observed a canonical receipt.';
COMMENT ON VIEW chatgpt_accounting.fns_source_receipt_refs IS 'Per-source reference lifecycle, including unresolved and unavailable detail states.';
COMMENT ON VIEW chatgpt_accounting.persons IS 'Accounting person metadata; not proof of payer or economic ownership.';
COMMENT ON VIEW chatgpt_accounting.fns_sources IS 'FNS source metadata without session or device references.';
COMMENT ON VIEW chatgpt_accounting.fns_source_person IS 'Mapping between FNS sources and accounting persons.';
COMMENT ON VIEW chatgpt_accounting.fns_source_sync_state IS 'Per-source synchronization status and counters.';
COMMENT ON VIEW chatgpt_accounting.analytics_purchases IS 'Curated one-row-per-certified-acquisition analytics surface.';
COMMENT ON VIEW chatgpt_accounting.analytics_purchase_items IS 'Curated item-grain view for certified acquisitions.';
COMMENT ON VIEW chatgpt_accounting.reconciliation_runs IS 'Accounting reconciliation run metadata.';
COMMENT ON VIEW chatgpt_accounting.reconciliation_results IS 'Reconciliation metrics and certification status.';

COMMENT ON COLUMN chatgpt_accounting.receipts.fns_id IS 'Canonical FNS identity; not a source-person identity.';
COMMENT ON COLUMN chatgpt_accounting.receipts.total_sum IS 'Fiscal receipt total; do not treat as confirmed cash flow.';
COMMENT ON COLUMN chatgpt_accounting.receipt_source_observations.fns_source_id IS 'Provenance source that observed the receipt; not payer or owner.';
COMMENT ON COLUMN chatgpt_accounting.fns_sources.display_name IS 'Human-readable source label; source identity is not economic ownership.';
COMMENT ON COLUMN chatgpt_accounting.certification_facts.status IS 'Accounting certification status, not merely fiscal receipt presence.';
COMMENT ON COLUMN chatgpt_accounting.ledger_postings.debit IS 'Debit amount; pair with credit and ledger entry for balance analysis.';
COMMENT ON COLUMN chatgpt_accounting.ledger_postings.credit IS 'Credit amount; pair with debit and ledger entry for balance analysis.';
COMMENT ON COLUMN chatgpt_accounting.analytics_purchases.amount IS 'Certified acquisition amount at purchase grain.';
COMMENT ON COLUMN chatgpt_accounting.analytics_purchase_items.item_sum IS 'Item-grain amount; do not sum with purchase-grain amounts.';

REVOKE ALL ON ALL TABLES IN SCHEMA chatgpt_accounting FROM PUBLIC;
GRANT USAGE ON SCHEMA chatgpt_accounting TO chatgpt_reader;
GRANT SELECT ON
  chatgpt_accounting.receipts,
  chatgpt_accounting.receipt_items,
  chatgpt_accounting.receipt_fiscal_facts,
  chatgpt_accounting.receipt_item_fiscal_facts,
  chatgpt_accounting.normalization_issues,
  chatgpt_accounting.business_events,
  chatgpt_accounting.business_event_evidence,
  chatgpt_accounting.business_event_edges,
  chatgpt_accounting.business_event_allocations,
  chatgpt_accounting.ledger_accounts,
  chatgpt_accounting.ledger_entries,
  chatgpt_accounting.ledger_postings,
  chatgpt_accounting.ledger_source_links,
  chatgpt_accounting.certification_facts,
  chatgpt_accounting.receipt_source_observations,
  chatgpt_accounting.fns_source_receipt_refs,
  chatgpt_accounting.persons,
  chatgpt_accounting.fns_sources,
  chatgpt_accounting.fns_source_person,
  chatgpt_accounting.fns_source_sync_state,
  chatgpt_accounting.analytics_purchases,
  chatgpt_accounting.analytics_purchase_items,
  chatgpt_accounting.reconciliation_runs,
  chatgpt_accounting.reconciliation_results
TO chatgpt_reader;

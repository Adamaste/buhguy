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

CREATE OR REPLACE VIEW chatgpt_accounting.user_receipts AS
SELECT DISTINCT ON (p.id, r.id)
       p.id AS person_id,
       p.person_key,
       p.display_name AS person_display_name,
       r.id AS receipt_id,
       r.fns_id,
       r.date_time,
       r.seller,
       r.seller_inn,
       r.total_sum,
       r.currency,
       r.operation_type,
       s.id AS fns_source_id,
       s.source_key,
       s.display_name AS source_display_name,
       o.source_receipt_id,
       o.observed_at
FROM public.receipts r
JOIN public.receipt_source_observations o ON o.receipt_id = r.id
JOIN public.fns_sources s ON s.id = o.fns_source_id AND s.enabled
JOIN public.fns_source_person sp ON sp.fns_source_id = s.id
JOIN public.persons p ON p.id = sp.person_id
ORDER BY p.id, r.id, o.observed_at DESC, o.id DESC;

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

CREATE OR REPLACE VIEW chatgpt_accounting.bank_sources AS
SELECT id, source_key, source_type, display_name, enabled, created_at, updated_at
FROM public.bank_sources;

CREATE OR REPLACE VIEW chatgpt_accounting.bank_transaction_account_resolution AS
SELECT bt.id AS bank_transaction_id,
       COALESCE(ar.resolution_state, 'UNKNOWN') AS resolution_state,
       ar.financial_account_id,
       CASE WHEN ar.financial_account_id IS NOT NULL THEN fa.display_name END AS financial_account_display_name,
       CASE WHEN ar.financial_account_id IS NOT NULL THEN
         (SELECT array_agg(DISTINCT far.person_id ORDER BY far.person_id)
          FROM public.financial_account_person_relations far
          WHERE far.financial_account_id = ar.financial_account_id)
       END AS financial_account_person_ids,
       CASE WHEN ar.financial_account_id IS NOT NULL THEN
         (SELECT array_agg(DISTINCT far.relation_type ORDER BY far.relation_type)
          FROM public.financial_account_person_relations far
          WHERE far.financial_account_id = ar.financial_account_id)
       END AS financial_account_person_relation_types,
       ar.provenance,
       ar.reason,
       ar.resolved_at
FROM public.bank_transactions bt
LEFT JOIN public.bank_transaction_account_resolution ar
  ON ar.bank_transaction_id = bt.id
LEFT JOIN public.financial_accounts fa
  ON fa.id = ar.financial_account_id;

CREATE OR REPLACE VIEW chatgpt_accounting.bank_transaction_payment_instrument_resolution AS
SELECT bt.id AS bank_transaction_id,
       COALESCE(pr.resolution_state, 'UNKNOWN') AS resolution_state,
       pr.payment_instrument_id,
       CASE WHEN pr.payment_instrument_id IS NOT NULL THEN pi.display_name END AS payment_instrument_display_name,
       pr.provenance,
       pr.reason,
       pr.resolved_at
FROM public.bank_transactions bt
LEFT JOIN public.bank_transaction_payment_instrument_resolution pr
  ON pr.bank_transaction_id = bt.id
LEFT JOIN public.payment_instruments pi
  ON pi.id = pr.payment_instrument_id;

CREATE OR REPLACE VIEW chatgpt_accounting.bank_transaction_person_context AS
SELECT bt.id AS bank_transaction_id,
       beo.bank_source_id,
       COALESCE(array_agg(DISTINCT bsp.person_id ORDER BY bsp.person_id)
                FILTER (WHERE bsp.person_id IS NOT NULL), ARRAY[]::BIGINT[]) AS source_context_person_ids,
       COALESCE(array_agg(DISTINCT bsp.relation_type ORDER BY bsp.relation_type)
                FILTER (WHERE bsp.relation_type IS NOT NULL), ARRAY[]::TEXT[]) AS source_context_relation_types
FROM public.bank_transactions bt
JOIN public.bank_event_observations beo ON beo.id = bt.observation_id
LEFT JOIN public.bank_source_person bsp ON bsp.bank_source_id = beo.bank_source_id
GROUP BY bt.id, beo.bank_source_id;

CREATE OR REPLACE VIEW chatgpt_accounting.bank_transactions AS
SELECT bt.id, bt.observation_id, beo.bank_source_id,
       bs.source_key, bs.source_type, bs.display_name AS source_display_name,
       bt.occurred_at, bt.amount, bt.currency, bt.direction,
       bt.merchant, bt.counterparty,
       bt.normalization_status, bt.normalization_version,
       bt.evidence_quality, beo.observed_at, beo.event_time,
       beo.ingestion_metadata->>'provider' AS provider,
       beo.ingestion_metadata->>'adapter' AS adapter,
       beo.ingestion_metadata->>'schemaVersion' AS schema_version,
       bt.event_type,
       ar.resolution_state AS account_resolution_state,
       ar.financial_account_id,
       ar.financial_account_display_name,
       ar.financial_account_person_ids,
       ar.financial_account_person_relation_types,
       pr.resolution_state AS payment_instrument_resolution_state,
       pr.payment_instrument_id,
       pr.payment_instrument_display_name,
       pc.source_context_person_ids,
       pc.source_context_relation_types
FROM public.bank_transactions bt
JOIN public.bank_event_observations beo ON beo.id = bt.observation_id
JOIN public.bank_sources bs ON bs.id = beo.bank_source_id
JOIN chatgpt_accounting.bank_transaction_account_resolution ar
  ON ar.bank_transaction_id = bt.id
JOIN chatgpt_accounting.bank_transaction_payment_instrument_resolution pr
  ON pr.bank_transaction_id = bt.id
JOIN chatgpt_accounting.bank_transaction_person_context pc
  ON pc.bank_transaction_id = bt.id;

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
COMMENT ON VIEW chatgpt_accounting.user_receipts IS 'Canonical receipt inventory by household person. Use this view for receipt existence/history/provenance questions. analytics_purchases is a derived economic-purchase view and is not a complete fiscal receipt inventory.';
COMMENT ON VIEW chatgpt_accounting.analytics_purchases IS 'Certified economic purchase analytics. Not a complete receipt inventory.';
COMMENT ON VIEW chatgpt_accounting.analytics_purchase_items IS 'Curated item-grain view for certified acquisitions.';
COMMENT ON VIEW chatgpt_accounting.reconciliation_runs IS 'Accounting reconciliation run metadata.';
COMMENT ON VIEW chatgpt_accounting.reconciliation_results IS 'Reconciliation metrics and certification status.';
COMMENT ON VIEW chatgpt_accounting.bank_sources IS 'Bank source metadata without credentials or raw event payloads.';
COMMENT ON VIEW chatgpt_accounting.bank_transaction_account_resolution IS 'One row per bank transaction with explicit account-resolution state. A resolved account display label and person relations are evidence-backed; UNKNOWN remains visible.';
COMMENT ON VIEW chatgpt_accounting.bank_transaction_payment_instrument_resolution IS 'One row per bank transaction with separate payment-instrument resolution. Card evidence never infers a financial account.';
COMMENT ON VIEW chatgpt_accounting.bank_transaction_person_context IS 'One row per bank transaction containing source-person context only. These relations do not prove financial-account ownership.';
COMMENT ON VIEW chatgpt_accounting.bank_transactions IS 'One row per normalized bank transaction with explicit normalization, resolution, and source-context state. A bank transaction is not automatically a purchase, receipt, payer, or accounting certification.';

COMMENT ON COLUMN chatgpt_accounting.receipts.fns_id IS 'Canonical FNS identity; not a source-person identity.';
COMMENT ON COLUMN chatgpt_accounting.receipts.total_sum IS 'Fiscal receipt total; do not treat as confirmed cash flow.';
COMMENT ON COLUMN chatgpt_accounting.receipt_source_observations.fns_source_id IS 'Provenance source that observed the receipt; not payer or owner.';
COMMENT ON COLUMN chatgpt_accounting.fns_sources.display_name IS 'Human-readable source label; source identity is not economic ownership.';
COMMENT ON COLUMN chatgpt_accounting.certification_facts.status IS 'Accounting certification status, not merely fiscal receipt presence.';
COMMENT ON COLUMN chatgpt_accounting.ledger_postings.debit IS 'Debit amount; pair with credit and ledger entry for balance analysis.';
COMMENT ON COLUMN chatgpt_accounting.ledger_postings.credit IS 'Credit amount; pair with debit and ledger entry for balance analysis.';
COMMENT ON COLUMN chatgpt_accounting.analytics_purchases.amount IS 'Certified acquisition amount at purchase grain.';
COMMENT ON COLUMN chatgpt_accounting.analytics_purchase_items.item_sum IS 'Item-grain amount; do not sum with purchase-grain amounts.';
COMMENT ON COLUMN chatgpt_accounting.bank_transactions.direction IS 'Explicit bank direction when evidence provides it; UNKNOWN is retained instead of inferred.';
COMMENT ON COLUMN chatgpt_accounting.bank_transactions.evidence_quality IS 'Quality of normalized evidence, not confidence that the event is a purchase.';
COMMENT ON COLUMN chatgpt_accounting.bank_transactions.source_context_person_ids IS 'Capture/accounting context only; never use this field as account ownership proof.';
COMMENT ON COLUMN chatgpt_accounting.bank_transactions.account_resolution_state IS 'EXACT, MANUAL, RECONCILED, or UNKNOWN; only the explicit resolution row determines account assignment.';
COMMENT ON COLUMN chatgpt_accounting.bank_transactions.payment_instrument_resolution_state IS 'Separate card/instrument evidence state; no card-to-account inference is implied.';

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
  chatgpt_accounting.user_receipts,
  chatgpt_accounting.fns_source_receipt_refs,
  chatgpt_accounting.persons,
  chatgpt_accounting.fns_sources,
  chatgpt_accounting.fns_source_person,
  chatgpt_accounting.fns_source_sync_state,
  chatgpt_accounting.analytics_purchases,
  chatgpt_accounting.analytics_purchase_items,
  chatgpt_accounting.reconciliation_runs,
  chatgpt_accounting.reconciliation_results,
  chatgpt_accounting.bank_sources,
  chatgpt_accounting.bank_transaction_account_resolution,
  chatgpt_accounting.bank_transaction_payment_instrument_resolution,
  chatgpt_accounting.bank_transaction_person_context,
  chatgpt_accounting.bank_transactions
TO chatgpt_reader;

-- Keep BlazeSQL on the explicit semantic layer instead of legacy public views.
REVOKE SELECT ON public.analytics_purchases, public.analytics_purchase_items FROM chatgpt_reader;

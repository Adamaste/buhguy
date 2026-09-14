CREATE TABLE IF NOT EXISTS accounting_scopes (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_event_types (
  event_type TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

INSERT INTO business_event_types(event_type, description) VALUES
  ('PURCHASE', 'Business purchase concept'),
  ('PAYMENT', 'Payment event'),
  ('PREPAYMENT', 'Prepayment event'),
  ('ADVANCE', 'Advance paid before fulfillment'),
  ('FULFILLMENT', 'Fulfillment or settlement event'),
  ('RETURN', 'Return event'),
  ('REFUND', 'Refund event'),
  ('CREDIT', 'Credit event'),
  ('CREDIT_PAYMENT', 'Credit repayment event'),
  ('STORED_VALUE_ACQUISITION', 'Stored value acquisition'),
  ('STORED_VALUE_REDEMPTION', 'Stored value redemption'),
  ('TRANSFER', 'Account transfer'),
  ('CASH_WITHDRAWAL', 'Cash withdrawal'),
  ('CASH_DEPOSIT', 'Cash deposit'),
  ('FEE', 'Fee event'),
  ('INTEREST', 'Interest event'),
  ('CORRECTION', 'Correction event')
ON CONFLICT (event_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS business_event_relations (
  relation_type TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

INSERT INTO business_event_relations(relation_type, description) VALUES
  ('PAYMENT_FOR', 'Payment supports purchase'),
  ('PREPAYMENT_FOR', 'Prepayment supports purchase'),
  ('FULFILLS', 'Fulfillment supports purchase'),
  ('RETURNS', 'Return relates to purchase'),
  ('REFUNDS', 'Refund relates to return or purchase'),
  ('SETTLES', 'Settlement relates to prior obligation')
ON CONFLICT (relation_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS business_graph_rules (
  rule_code TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (rule_code, rule_version)
);

CREATE TABLE IF NOT EXISTS business_graph_runs (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  graph_model_version TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('SYSTEM_DERIVED', 'MANUAL', 'EXTERNAL_CONFIRMED')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE (scope_id, graph_model_version, rule_code, rule_version, started_at),
  FOREIGN KEY (rule_code, rule_version) REFERENCES business_graph_rules(rule_code, rule_version)
);

CREATE TABLE IF NOT EXISTS business_events (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  event_type TEXT NOT NULL REFERENCES business_event_types(event_type),
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('CANDIDATE', 'CONFIRMED', 'AMBIGUOUS', 'REJECTED', 'SUPERSEDED')),
  origin TEXT NOT NULL CHECK (origin IN ('SYSTEM_DERIVED', 'MANUAL', 'EXTERNAL_CONFIRMED')),
  graph_model_version TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  semantic_key CHAR(64) NOT NULL,
  amount NUMERIC(14, 2),
  currency TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, semantic_key, graph_model_version, rule_code, rule_version, origin),
  UNIQUE (scope_id, id),
  FOREIGN KEY (rule_code, rule_version) REFERENCES business_graph_rules(rule_code, rule_version)
);

CREATE INDEX IF NOT EXISTS business_events_scope_status_idx
  ON business_events(scope_id, resolution_status);

CREATE TABLE IF NOT EXISTS business_event_evidence (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES business_events(id) ON DELETE CASCADE,
  receipt_id BIGINT,
  receipt_item_id BIGINT,
  normalization_version TEXT NOT NULL,
  evidence_role TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('SYSTEM_DERIVED', 'MANUAL', 'EXTERNAL_CONFIRMED')),
  graph_model_version TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  semantic_key CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (receipt_id IS NOT NULL OR receipt_item_id IS NOT NULL),
  CHECK (NOT (receipt_id IS NOT NULL AND receipt_item_id IS NOT NULL) OR normalization_version IS NOT NULL),
  FOREIGN KEY (rule_code, rule_version) REFERENCES business_graph_rules(rule_code, rule_version),
  FOREIGN KEY (receipt_id, normalization_version) REFERENCES receipt_fiscal_facts(receipt_id, normalization_version),
  FOREIGN KEY (receipt_item_id, normalization_version) REFERENCES receipt_item_fiscal_facts(receipt_item_id, normalization_version)
);

CREATE INDEX IF NOT EXISTS business_event_evidence_event_idx
  ON business_event_evidence(event_id);

CREATE TABLE IF NOT EXISTS business_event_edges (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  source_event_id BIGINT NOT NULL,
  target_event_id BIGINT NOT NULL,
  relation_type TEXT NOT NULL REFERENCES business_event_relations(relation_type),
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('CANDIDATE', 'CONFIRMED', 'AMBIGUOUS', 'REJECTED', 'SUPERSEDED')),
  origin TEXT NOT NULL CHECK (origin IN ('SYSTEM_DERIVED', 'MANUAL', 'EXTERNAL_CONFIRMED')),
  graph_model_version TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  semantic_key CHAR(64) NOT NULL UNIQUE,
  explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_event_id <> target_event_id),
  FOREIGN KEY (rule_code, rule_version) REFERENCES business_graph_rules(rule_code, rule_version),
  FOREIGN KEY (scope_id, source_event_id) REFERENCES business_events(scope_id, id),
  FOREIGN KEY (scope_id, target_event_id) REFERENCES business_events(scope_id, id)
);

CREATE INDEX IF NOT EXISTS business_event_edges_scope_source_idx
  ON business_event_edges(scope_id, source_event_id);
CREATE INDEX IF NOT EXISTS business_event_edges_scope_target_idx
  ON business_event_edges(scope_id, target_event_id);

CREATE TABLE IF NOT EXISTS business_event_allocations (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  target_event_id BIGINT NOT NULL,
  source_receipt_id BIGINT,
  source_receipt_item_id BIGINT,
  normalization_version TEXT NOT NULL,
  allocated_quantity NUMERIC(14, 3) CHECK (allocated_quantity IS NULL OR allocated_quantity >= 0),
  allocated_amount NUMERIC(14, 2) CHECK (allocated_amount IS NULL OR allocated_amount >= 0),
  currency TEXT NOT NULL,
  allocation_role TEXT NOT NULL,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('CANDIDATE', 'CONFIRMED', 'AMBIGUOUS', 'REJECTED', 'SUPERSEDED')),
  origin TEXT NOT NULL CHECK (origin IN ('SYSTEM_DERIVED', 'MANUAL', 'EXTERNAL_CONFIRMED')),
  graph_model_version TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  semantic_key CHAR(64) NOT NULL UNIQUE,
  explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_receipt_id IS NOT NULL OR source_receipt_item_id IS NOT NULL),
  CHECK (allocated_quantity IS NOT NULL OR allocated_amount IS NOT NULL),
  FOREIGN KEY (rule_code, rule_version) REFERENCES business_graph_rules(rule_code, rule_version),
  FOREIGN KEY (scope_id, target_event_id) REFERENCES business_events(scope_id, id),
  FOREIGN KEY (source_receipt_id, normalization_version) REFERENCES receipt_fiscal_facts(receipt_id, normalization_version),
  FOREIGN KEY (source_receipt_item_id, normalization_version) REFERENCES receipt_item_fiscal_facts(receipt_item_id, normalization_version)
);

CREATE INDEX IF NOT EXISTS business_event_allocations_target_idx
  ON business_event_allocations(target_event_id);

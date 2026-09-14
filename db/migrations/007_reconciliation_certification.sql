CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  model_version TEXT NOT NULL,
  source_state_key CHAR(64) NOT NULL,
  period_from TIMESTAMPTZ,
  period_to TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'READY', 'FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE (scope_id, model_version, source_state_key, period_from, period_to)
);

CREATE TABLE IF NOT EXISTS reconciliation_results (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  metric_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CERTIFIED', 'PROVISIONAL', 'BLOCKED')),
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL,
  count_items INTEGER NOT NULL CHECK (count_items >= 0),
  reason_code TEXT,
  semantic_key CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certification_facts (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  subject_type TEXT NOT NULL,
  subject_id BIGINT NOT NULL,
  metric_code TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('BUSINESS_CERTIFICATION', 'FUNDING_CERTIFICATION', 'CLASSIFICATION_CERTIFICATION')),
  status TEXT NOT NULL CHECK (status IN ('CERTIFIED', 'PROVISIONAL', 'BLOCKED')),
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL,
  reason_code TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  ledger_entry_id BIGINT REFERENCES ledger_entries(id),
  business_event_id BIGINT REFERENCES business_events(id),
  graph_evidence_id BIGINT REFERENCES business_event_evidence(id),
  semantic_key CHAR(64) NOT NULL UNIQUE,
  source_state_key CHAR(64) NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PostgreSQL UNIQUE constraints treat NULL periods as distinct; this index makes
-- the unbounded certification run key idempotent and remains inferable by the
-- existing INSERT ... ON CONFLICT(column list) statements.
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_runs_scope_model_state_period_unique
  ON reconciliation_runs (scope_id, model_version, source_state_key, period_from, period_to)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS certification_facts_run_metric_idx
  ON certification_facts(run_id, metric_code, status, event_at);
CREATE INDEX IF NOT EXISTS certification_facts_subject_idx
  ON certification_facts(scope_id, subject_type, subject_id);

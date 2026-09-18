CREATE TABLE IF NOT EXISTS bank_sources (
  id BIGSERIAL PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('ANDROID_NOTIFICATION', 'BANK_API', 'MANUAL_IMPORT')),
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_source_person (
  bank_source_id BIGINT NOT NULL REFERENCES bank_sources(id) ON DELETE CASCADE,
  person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL DEFAULT 'OWNER',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bank_source_id, person_id)
);

CREATE TABLE IF NOT EXISTS bank_event_observations (
  id BIGSERIAL PRIMARY KEY,
  bank_source_id BIGINT NOT NULL REFERENCES bank_sources(id) ON DELETE RESTRICT,
  source_event_id TEXT,
  dedup_key CHAR(64) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  event_time TIMESTAMPTZ,
  payload JSONB NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  ingestion_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bank_source_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS bank_event_observations_source_time_idx
  ON bank_event_observations(bank_source_id, observed_at);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id BIGSERIAL PRIMARY KEY,
  observation_id BIGINT NOT NULL UNIQUE REFERENCES bank_event_observations(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ,
  amount NUMERIC(18, 2),
  currency CHAR(3),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT', 'UNKNOWN')),
  merchant TEXT,
  counterparty TEXT,
  account_reference TEXT,
  normalization_status TEXT NOT NULL CHECK (normalization_status IN ('READY', 'PARTIAL', 'UNKNOWN', 'REJECTED')),
  normalization_version TEXT NOT NULL,
  evidence_quality TEXT NOT NULL CHECK (evidence_quality IN ('EXACT', 'PARTIAL', 'INSUFFICIENT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (amount IS NULL OR amount >= 0),
  CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS bank_transactions_occurred_at_idx
  ON bank_transactions(occurred_at);

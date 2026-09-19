CREATE TABLE IF NOT EXISTS bank_device_credentials (
  id BIGSERIAL PRIMARY KEY,
  credential_key TEXT NOT NULL UNIQUE,
  bank_source_id BIGINT NOT NULL REFERENCES bank_sources(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  secret_hash CHAR(64) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bank_device_credentials_source_idx
  ON bank_device_credentials(bank_source_id);

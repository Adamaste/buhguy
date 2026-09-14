CREATE TABLE IF NOT EXISTS fns_source_receipt_refs (
  id BIGSERIAL PRIMARY KEY,
  fns_source_id BIGINT NOT NULL REFERENCES fns_sources(id) ON DELETE CASCADE,
  source_receipt_id TEXT NOT NULL,
  receipt_id BIGINT REFERENCES receipts(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_DETAIL', 'RESOLVED', 'FNS_DETAIL_UNAVAILABLE', 'RETRYABLE_DETAIL_ERROR', 'CONFLICT')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail_last_attempt_at TIMESTAMPTZ,
  detail_next_retry_at TIMESTAMPTZ,
  detail_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (detail_attempt_count >= 0),
  detail_http_status INTEGER,
  detail_error_code TEXT,
  detail_error_signature CHAR(64),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fns_source_id, source_receipt_id),
  CHECK ((status = 'RESOLVED') = (receipt_id IS NOT NULL)),
  CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fns_source_receipt_refs_retry_idx
  ON fns_source_receipt_refs(fns_source_id, status, detail_next_retry_at);

CREATE INDEX IF NOT EXISTS fns_source_receipt_refs_receipt_idx
  ON fns_source_receipt_refs(receipt_id);

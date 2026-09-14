CREATE TABLE IF NOT EXISTS receipts (
  id BIGSERIAL PRIMARY KEY,
  fns_id TEXT NOT NULL UNIQUE,
  date_time TIMESTAMPTZ,
  seller TEXT,
  seller_inn TEXT,
  total_sum NUMERIC(14, 2),
  currency TEXT,
  source TEXT NOT NULL DEFAULT 'fns_moi_cheki_online',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fiscal_document_number TEXT,
  fiscal_drive_number TEXT,
  fiscal_sign TEXT,
  kkt_reg_id TEXT,
  raw_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS receipt_items (
  id BIGSERIAL PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity NUMERIC(14, 3),
  price NUMERIC(14, 2),
  item_sum NUMERIC(14, 2),
  provider_inn TEXT,
  nds NUMERIC(14, 2),
  raw JSONB,
  UNIQUE (receipt_id, position)
);
CREATE TABLE IF NOT EXISTS receipt_raw (
  receipt_id BIGINT PRIMARY KEY REFERENCES receipts(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sync_state (
  account_key TEXT PRIMARY KEY,
  last_sync_started_at TIMESTAMPTZ,
  last_sync_finished_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

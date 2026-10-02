CREATE TABLE IF NOT EXISTS bank_source_provider_account_bindings (
  id BIGSERIAL PRIMARY KEY,
  bank_source_id BIGINT NOT NULL REFERENCES bank_sources(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  financial_account_id BIGINT NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK (provenance = 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_source_provider_active_binding_idx
  ON bank_source_provider_account_bindings(bank_source_id, provider)
  WHERE active;

CREATE INDEX IF NOT EXISTS bank_source_provider_binding_account_idx
  ON bank_source_provider_account_bindings(financial_account_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (bank_source_id, provider, financial_account_id, active) ON public.bank_source_provider_account_bindings TO receipt_collector';
  END IF;
END $$;

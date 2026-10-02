-- Immutable provider-reported balance evidence, separate from transaction semantics.
CREATE TABLE bank_balance_observations (
  observation_id BIGINT PRIMARY KEY REFERENCES bank_event_observations(id) ON DELETE RESTRICT,
  bank_transaction_id BIGINT NOT NULL UNIQUE REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  balance_kind TEXT NOT NULL CHECK (balance_kind = 'PROVIDER_REPORTED_BALANCE'),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'RUB'),
  event_time TIMESTAMPTZ NOT NULL,
  normalization_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE bank_balance_observations IS
  'Immutable provider-reported observed balance evidence; not a calculated, current, or accounting-certified balance.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT INSERT ON public.bank_balance_observations TO receipt_collector';
  END IF;
END $$;

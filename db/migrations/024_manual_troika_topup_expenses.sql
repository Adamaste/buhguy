-- Append-only, user-confirmed Troika top-ups are immediate transport expenses.
DO $$
BEGIN
  ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_account_type_check;
  ALTER TABLE ledger_accounts
    ADD CONSTRAINT ledger_accounts_account_type_check
    CHECK (account_type IN ('ASSET', 'CONTROL', 'RECEIVABLE', 'EXPENSE'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_instruments'::regclass
      AND conname = 'payment_instruments_scope_id_id_unique'
  ) THEN
    ALTER TABLE payment_instruments
      ADD CONSTRAINT payment_instruments_scope_id_id_unique UNIQUE (scope_id, id);
  END IF;
END $$;

CREATE TABLE manual_troika_topup_expenses (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  bank_source_id BIGINT NOT NULL REFERENCES bank_sources(id) ON DELETE RESTRICT,
  bank_transaction_id BIGINT NOT NULL UNIQUE REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  business_event_id BIGINT NOT NULL,
  ledger_entry_id BIGINT NOT NULL,
  financial_account_id BIGINT NOT NULL,
  payment_instrument_id BIGINT NOT NULL,
  person_id BIGINT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'ru.alfabank.mobile.android'),
  category_code TEXT NOT NULL CHECK (category_code = 'PUBLIC_TRANSPORT'),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'RUB'),
  occurred_at TIMESTAMPTZ NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance = 'USER_CONFIRMED'),
  evidence_basis TEXT NOT NULL CHECK (evidence_basis IN ('USER_CONFIRMATION', 'BANK_DOCUMENT_AND_USER_CONFIRMATION')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, id),
  UNIQUE (scope_id, business_event_id),
  UNIQUE (scope_id, ledger_entry_id),
  FOREIGN KEY (scope_id, business_event_id) REFERENCES business_events(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, ledger_entry_id) REFERENCES ledger_entries(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, financial_account_id) REFERENCES financial_accounts(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, payment_instrument_id) REFERENCES payment_instruments(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, person_id) REFERENCES persons(scope_id, id) ON DELETE RESTRICT
);

CREATE TABLE manual_troika_topup_receipt_links (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL,
  manual_troika_topup_expense_id BIGINT NOT NULL UNIQUE,
  receipt_id BIGINT NOT NULL UNIQUE REFERENCES receipts(id) ON DELETE RESTRICT,
  business_event_evidence_id BIGINT NOT NULL UNIQUE REFERENCES business_event_evidence(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK (provenance = 'USER_CONFIRMED'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (scope_id, manual_troika_topup_expense_id)
    REFERENCES manual_troika_topup_expenses(scope_id, id) ON DELETE RESTRICT
);

CREATE INDEX manual_troika_topup_scope_idx
  ON manual_troika_topup_expenses(scope_id, occurred_at);

CREATE FUNCTION reject_manual_troika_topup_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'manual Troika expense evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER manual_troika_topup_expenses_append_only
  BEFORE UPDATE OR DELETE ON manual_troika_topup_expenses
  FOR EACH ROW EXECUTE FUNCTION reject_manual_troika_topup_mutation();

CREATE TRIGGER manual_troika_topup_receipt_links_append_only
  BEFORE UPDATE OR DELETE ON manual_troika_topup_receipt_links
  FOR EACH ROW EXECUTE FUNCTION reject_manual_troika_topup_mutation();

-- Keep the operator/runtime surface limited to the explicit confirmation path.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_collector') THEN
    EXECUTE 'GRANT SELECT (rule_code, rule_version) ON public.business_graph_rules TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, observation_id, occurred_at, amount, currency, direction, event_type, normalization_status) ON public.bank_transactions TO receipt_collector';
    EXECUTE 'GRANT SELECT (bank_source_id, event_time) ON public.bank_event_observations TO receipt_collector';
    EXECUTE 'GRANT SELECT (provider, active) ON public.financial_accounts TO receipt_collector';
    EXECUTE 'GRANT SELECT (financial_account_id, scope_id, provider, instrument_type, active) ON public.payment_instruments TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, provider, reference_kind, reference_value, payment_instrument_id) ON public.bank_account_references TO receipt_collector';
    EXECUTE 'GRANT SELECT (bank_transaction_id, financial_account_id, resolution_state) ON public.bank_transaction_account_resolution TO receipt_collector';
    EXECUTE 'GRANT SELECT (bank_transaction_id, payment_instrument_id, resolution_state) ON public.bank_transaction_payment_instrument_resolution TO receipt_collector';
    EXECUTE 'GRANT SELECT (payment_instrument_id, person_id, relation_type) ON public.payment_instrument_person_relations TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, operation_type, date_time, currency, total_sum) ON public.receipts TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, receipt_id, fns_source_id) ON public.receipt_source_observations TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id) ON public.fns_sources TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_key) ON public.accounting_scopes TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id) ON public.persons TO receipt_collector';
    EXECUTE 'GRANT SELECT (bank_source_id, person_id, relation_type) ON public.bank_source_person TO receipt_collector';
    EXECUTE 'GRANT SELECT (financial_account_id, person_id, relation_type, provenance) ON public.financial_account_person_relations TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, bank_transaction_id, receipt_id) ON public.bank_receipt_matches TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, ledger_entry_id, business_event_id, graph_evidence_id, receipt_id, link_role, bank_transaction_id) ON public.ledger_source_links TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, bank_source_id, bank_transaction_id, business_event_id, ledger_entry_id, financial_account_id, payment_instrument_id, person_id, provider, category_code, amount, currency, occurred_at, provenance, evidence_basis, reason, semantic_key) ON public.manual_troika_topup_expenses TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, bank_source_id, bank_transaction_id, business_event_id, ledger_entry_id, financial_account_id, payment_instrument_id, person_id, provider, category_code, amount, currency, occurred_at, provenance, evidence_basis, reason, semantic_key) ON public.manual_troika_topup_expenses TO receipt_collector';
    EXECUTE 'GRANT SELECT (id, scope_id, manual_troika_topup_expense_id, receipt_id, business_event_evidence_id, provenance, reason, semantic_key) ON public.manual_troika_topup_receipt_links TO receipt_collector';
    EXECUTE 'GRANT INSERT (scope_id, manual_troika_topup_expense_id, receipt_id, business_event_evidence_id, provenance, reason, semantic_key) ON public.manual_troika_topup_receipt_links TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.manual_troika_topup_expenses_id_seq TO receipt_collector';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.manual_troika_topup_receipt_links_id_seq TO receipt_collector';
  END IF;
END $$;

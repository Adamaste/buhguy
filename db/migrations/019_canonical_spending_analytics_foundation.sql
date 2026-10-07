-- Canonical spending analytics foundation. This is schema/read-model support
-- only: no classifier, writer, replay, backfill, or production rollout.

CREATE TABLE IF NOT EXISTS spending_taxonomies (
  id BIGSERIAL PRIMARY KEY,
  taxonomy_version TEXT NOT NULL UNIQUE CHECK (length(btrim(taxonomy_version)) > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spending_categories (
  id BIGSERIAL PRIMARY KEY,
  taxonomy_id BIGINT NOT NULL REFERENCES spending_taxonomies(id) ON DELETE RESTRICT,
  category_code TEXT NOT NULL CHECK (category_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  parent_category_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (taxonomy_id, id),
  UNIQUE (taxonomy_id, category_code),
  FOREIGN KEY (taxonomy_id, parent_category_id)
    REFERENCES spending_categories(taxonomy_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS spending_classification_decisions (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  taxonomy_id BIGINT NOT NULL REFERENCES spending_taxonomies(id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('PURCHASE', 'RECEIPT_ITEM')),
  subject_id BIGINT NOT NULL CHECK (subject_id > 0),
  category_id BIGINT NOT NULL,
  decision_status TEXT NOT NULL CHECK (decision_status IN ('CLASSIFIED', 'UNCLASSIFIED', 'REVIEW_REQUIRED', 'DISPUTED', 'SUPERSEDED')),
  decision_source TEXT NOT NULL CHECK (decision_source IN ('RULE', 'MODEL', 'MANUAL')),
  rule_or_model_version TEXT NOT NULL CHECK (length(btrim(rule_or_model_version)) > 0),
  provenance_key CHAR(64) NOT NULL CHECK (provenance_key ~ '^[0-9a-f]{64}$'),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  supersedes_decision_id BIGINT REFERENCES spending_classification_decisions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (supersedes_decision_id IS NULL OR supersedes_decision_id <> id),
  FOREIGN KEY (taxonomy_id, category_id) REFERENCES spending_categories(taxonomy_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS spending_classification_subject_idx
  ON spending_classification_decisions(scope_id, subject_type, subject_id, taxonomy_id);

CREATE UNIQUE INDEX IF NOT EXISTS spending_classification_supersedes_unique
  ON spending_classification_decisions(supersedes_decision_id)
  WHERE supersedes_decision_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS spending_return_relationships (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  return_event_id BIGINT NOT NULL,
  purchase_event_id BIGINT,
  receipt_item_id BIGINT,
  relationship_status TEXT NOT NULL CHECK (relationship_status IN ('LINKED', 'UNATTRIBUTED', 'REVIEW_REQUIRED', 'SUPERSEDED')),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  supersedes_relationship_id BIGINT REFERENCES spending_return_relationships(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (purchase_event_id IS NOT NULL OR receipt_item_id IS NOT NULL OR relationship_status IN ('UNATTRIBUTED', 'REVIEW_REQUIRED', 'SUPERSEDED')),
  CHECK (supersedes_relationship_id IS NULL OR supersedes_relationship_id <> id),
  FOREIGN KEY (scope_id, return_event_id) REFERENCES business_events(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, purchase_event_id) REFERENCES business_events(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (receipt_item_id) REFERENCES receipt_items(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS spending_return_relationship_scope_idx
  ON spending_return_relationships(scope_id, return_event_id, relationship_status);

CREATE UNIQUE INDEX IF NOT EXISTS spending_return_relationship_active_unique
  ON spending_return_relationships(scope_id, return_event_id)
  WHERE relationship_status <> 'SUPERSEDED';

CREATE UNIQUE INDEX IF NOT EXISTS spending_return_relationship_supersedes_unique
  ON spending_return_relationships(supersedes_relationship_id)
  WHERE supersedes_relationship_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS spending_category_allocations (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  certification_run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  source_state_key CHAR(64) NOT NULL CHECK (source_state_key ~ '^[0-9a-f]{64}$'),
  allocation_kind TEXT NOT NULL CHECK (allocation_kind IN ('PURCHASE', 'RETURN')),
  subject_event_id BIGINT NOT NULL,
  receipt_item_id BIGINT,
  category_id BIGINT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocation_status TEXT NOT NULL CHECK (allocation_status IN ('ALLOCATED', 'UNCLASSIFIED', 'REVIEW_REQUIRED', 'DISPUTED', 'SUPERSEDED')),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  supersedes_allocation_id BIGINT REFERENCES spending_category_allocations(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (supersedes_allocation_id IS NULL OR supersedes_allocation_id <> id),
  FOREIGN KEY (scope_id, subject_event_id) REFERENCES business_events(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (receipt_item_id) REFERENCES receipt_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id) REFERENCES spending_categories(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS spending_category_allocations_snapshot_idx
  ON spending_category_allocations(scope_id, certification_run_id, source_state_key, allocation_kind, subject_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS spending_category_allocations_supersedes_unique
  ON spending_category_allocations(supersedes_allocation_id)
  WHERE supersedes_allocation_id IS NOT NULL;

ALTER TABLE persons ADD CONSTRAINT persons_scope_id_id_unique UNIQUE (scope_id, id);

CREATE TABLE IF NOT EXISTS spending_person_allocations (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id) ON DELETE RESTRICT,
  certification_run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  source_state_key CHAR(64) NOT NULL CHECK (source_state_key ~ '^[0-9a-f]{64}$'),
  allocation_kind TEXT NOT NULL CHECK (allocation_kind IN ('PURCHASE', 'RETURN')),
  subject_event_id BIGINT NOT NULL,
  person_id BIGINT,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocation_status TEXT NOT NULL CHECK (allocation_status IN ('ALLOCATED', 'UNATTRIBUTED', 'REVIEW_REQUIRED', 'DISPUTED', 'SUPERSEDED')),
  provenance_key CHAR(64) NOT NULL CHECK (provenance_key ~ '^[0-9a-f]{64}$'),
  semantic_key CHAR(64) NOT NULL UNIQUE CHECK (semantic_key ~ '^[0-9a-f]{64}$'),
  supersedes_allocation_id BIGINT REFERENCES spending_person_allocations(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((person_id IS NOT NULL AND allocation_status = 'ALLOCATED') OR (person_id IS NULL AND allocation_status IN ('UNATTRIBUTED', 'REVIEW_REQUIRED', 'DISPUTED', 'SUPERSEDED'))),
  CHECK (supersedes_allocation_id IS NULL OR supersedes_allocation_id <> id),
  FOREIGN KEY (scope_id, subject_event_id) REFERENCES business_events(scope_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, person_id) REFERENCES persons(scope_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS spending_person_allocations_snapshot_idx
  ON spending_person_allocations(scope_id, certification_run_id, source_state_key, allocation_kind, subject_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS spending_person_allocations_supersedes_unique
  ON spending_person_allocations(supersedes_allocation_id)
  WHERE supersedes_allocation_id IS NOT NULL;

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_scope_id_id_state_unique
  UNIQUE (scope_id, id, source_state_key);

ALTER TABLE spending_category_allocations
  ADD CONSTRAINT spending_category_allocations_run_state_fk
  FOREIGN KEY (scope_id, certification_run_id, source_state_key)
  REFERENCES reconciliation_runs(scope_id, id, source_state_key) ON DELETE RESTRICT;

ALTER TABLE spending_person_allocations
  ADD CONSTRAINT spending_person_allocations_run_state_fk
  FOREIGN KEY (scope_id, certification_run_id, source_state_key)
  REFERENCES reconciliation_runs(scope_id, id, source_state_key) ON DELETE RESTRICT;

INSERT INTO spending_taxonomies(taxonomy_version, status)
VALUES ('household-spending-taxonomy-v1', 'ACTIVE')
ON CONFLICT (taxonomy_version) DO NOTHING;

INSERT INTO spending_categories(taxonomy_id, category_code)
SELECT t.id, c.category_code
FROM spending_taxonomies t
CROSS JOIN (VALUES
  ('GROCERIES'), ('DINING'), ('HEALTH_MEDICINE'), ('BEAUTY_PERSONAL_CARE'),
  ('BEAUTY_SERVICES'), ('CLOTHING'), ('PETS'), ('HOME_HOUSEHOLD'),
  ('UTILITIES'), ('INSURANCE'), ('PARKING'), ('FUEL'), ('PUBLIC_TRANSPORT'),
  ('ELECTRONICS_DIGITAL'), ('DELIVERY_SERVICES'), ('GIFTS'),
  ('FINANCIAL_SERVICES'), ('OTHER'), ('UNCLASSIFIED'), ('REVIEW_REQUIRED'),
  ('UNRESOLVED_RETURN')
) AS c(category_code)
WHERE t.taxonomy_version='household-spending-taxonomy-v1'
ON CONFLICT (taxonomy_id, category_code) DO NOTHING;

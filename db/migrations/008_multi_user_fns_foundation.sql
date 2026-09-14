CREATE TABLE IF NOT EXISTS persons (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  person_key TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, person_key)
);

CREATE TABLE IF NOT EXISTS fns_sources (
  id BIGSERIAL PRIMARY KEY,
  scope_id BIGINT NOT NULL REFERENCES accounting_scopes(id),
  source_key TEXT NOT NULL,
  display_name TEXT,
  session_ref TEXT NOT NULL,
  device_ref TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id, source_key)
);

CREATE TABLE IF NOT EXISTS fns_source_person (
  fns_source_id BIGINT NOT NULL REFERENCES fns_sources(id) ON DELETE CASCADE,
  person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'OBSERVED_BY' CHECK (relation_type = 'OBSERVED_BY'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fns_source_id, person_id)
);

CREATE TABLE IF NOT EXISTS receipt_source_observations (
  id BIGSERIAL PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  fns_source_id BIGINT NOT NULL REFERENCES fns_sources(id) ON DELETE CASCADE,
  source_receipt_id TEXT NOT NULL,
  source_content_sha256 CHAR(64),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fns_source_id, source_receipt_id),
  UNIQUE (fns_source_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS receipt_source_observations_receipt_idx
  ON receipt_source_observations(receipt_id);

CREATE TABLE IF NOT EXISTS fns_source_sync_state (
  fns_source_id BIGINT PRIMARY KEY REFERENCES fns_sources(id) ON DELETE CASCADE,
  last_sync_started_at TIMESTAMPTZ,
  last_sync_finished_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_class TEXT,
  fetched_count INTEGER NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
  canonical_inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (canonical_inserted_count >= 0),
  observation_replayed_count INTEGER NOT NULL DEFAULT 0 CHECK (observation_replayed_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The legacy source is metadata-only: no token or cookie is copied into SQL.
INSERT INTO accounting_scopes(scope_key, label) VALUES ('default', 'Default accounting scope')
ON CONFLICT (scope_key) DO NOTHING;
INSERT INTO persons(scope_id, person_key, display_name)
SELECT id, 'legacy-current-user', 'Legacy current user'
FROM accounting_scopes WHERE scope_key='default'
ON CONFLICT (scope_id, person_key) DO NOTHING;
INSERT INTO fns_sources(scope_id, source_key, display_name, session_ref, device_ref)
SELECT id, 'legacy-default', 'Legacy FNS source', 'filesystem:default/session.json', 'filesystem:default/session.json'
FROM accounting_scopes WHERE scope_key='default'
ON CONFLICT (scope_id, source_key) DO NOTHING;
INSERT INTO fns_source_person(fns_source_id, person_id)
SELECT s.id, p.id FROM fns_sources s JOIN persons p ON p.scope_id=s.scope_id
WHERE s.source_key='legacy-default' AND p.person_key='legacy-current-user'
ON CONFLICT DO NOTHING;
INSERT INTO receipt_source_observations(fns_source_id, receipt_id, source_receipt_id)
SELECT s.id, r.id, r.fns_id FROM fns_sources s CROSS JOIN receipts r
WHERE s.source_key='legacy-default'
ON CONFLICT DO NOTHING;
INSERT INTO fns_source_sync_state(fns_source_id)
SELECT id FROM fns_sources WHERE source_key='legacy-default'
ON CONFLICT DO NOTHING;

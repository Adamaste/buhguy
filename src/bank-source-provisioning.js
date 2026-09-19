const SOURCE_TYPES = new Set(['ANDROID_NOTIFICATION', 'BANK_API', 'MANUAL_IMPORT']);
const SOURCE_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

export class BankSourceProvisioningError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'BankSourceProvisioningError';
    this.code = code;
  }
}

function requireSourceKey(value) {
  if (typeof value !== 'string' || !SOURCE_KEY_PATTERN.test(value)) {
    throw new BankSourceProvisioningError('INVALID_SOURCE_KEY', 'source-key must be 1-128 safe identifier characters');
  }
  return value;
}

function requireDisplayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new BankSourceProvisioningError('INVALID_DISPLAY_NAME', 'display-name is required and must be at most 200 characters');
  }
  return value.trim();
}

function requireSourceType(value = 'ANDROID_NOTIFICATION') {
  if (!SOURCE_TYPES.has(value)) throw new BankSourceProvisioningError('INVALID_SOURCE_TYPE', `source-type must be one of ${[...SOURCE_TYPES].join(', ')}`);
  return value;
}

function requireScopeKey(value = 'default') {
  if (typeof value !== 'string' || !SOURCE_KEY_PATTERN.test(value)) throw new BankSourceProvisioningError('INVALID_SCOPE_KEY', 'scope-key must be a safe identifier');
  return value;
}

export async function createProvisionedBankSource(pool, { sourceKey, displayName, sourceType = 'ANDROID_NOTIFICATION' }) {
  const safeKey = requireSourceKey(sourceKey);
  const safeName = requireDisplayName(displayName);
  const safeType = requireSourceType(sourceType);
  try {
    const result = await pool.query(`INSERT INTO bank_sources(source_key,source_type,display_name)
      VALUES($1,$2,$3) RETURNING id,source_key,source_type,display_name,enabled,created_at,updated_at`, [safeKey, safeType, safeName]);
    return result.rows[0];
  } catch (error) {
    if (error?.code === '23505') throw new BankSourceProvisioningError('SOURCE_ALREADY_EXISTS', 'source-key already exists');
    throw error;
  }
}

export async function listProvisionedBankSources(pool) {
  const result = await pool.query(`SELECT s.id,s.source_key,s.source_type,s.display_name,s.enabled,s.created_at,s.updated_at,
      p.person_key,p.display_name AS person_display_name,sp.relation_type
    FROM bank_sources s
    LEFT JOIN bank_source_person sp ON sp.bank_source_id=s.id
    LEFT JOIN persons p ON p.id=sp.person_id
    ORDER BY s.id,p.person_key`);
  const sources = new Map();
  for (const row of result.rows) {
    let source = sources.get(row.id);
    if (!source) {
      source = { id: Number(row.id), source_key: row.source_key, source_type: row.source_type, display_name: row.display_name, enabled: row.enabled, created_at: row.created_at, updated_at: row.updated_at, persons: [] };
      sources.set(row.id, source);
    }
    if (row.person_key) source.persons.push({ person_key: row.person_key, display_name: row.person_display_name, relation_type: row.relation_type });
  }
  return [...sources.values()];
}

export async function setProvisionedBankSourceEnabled(pool, { sourceKey, enabled }) {
  const safeKey = requireSourceKey(sourceKey);
  const result = await pool.query(`UPDATE bank_sources SET enabled=$2,updated_at=NOW()
    WHERE source_key=$1 RETURNING id,source_key,source_type,display_name,enabled,created_at,updated_at`, [safeKey, Boolean(enabled)]);
  if (!result.rowCount) throw new BankSourceProvisioningError('SOURCE_NOT_FOUND', 'source-key was not found');
  return result.rows[0];
}

export async function linkProvisionedBankSourcePerson(pool, { sourceKey, personKey, relationType = 'OWNER', scopeKey = 'default' }) {
  const safeSourceKey = requireSourceKey(sourceKey);
  const safePersonKey = requireSourceKey(personKey);
  const safeScopeKey = requireScopeKey(scopeKey);
  if (relationType !== 'OWNER') throw new BankSourceProvisioningError('INVALID_RELATION_TYPE', 'only OWNER is supported');
  const source = (await pool.query('SELECT id FROM bank_sources WHERE source_key=$1', [safeSourceKey])).rows[0];
  if (!source) throw new BankSourceProvisioningError('SOURCE_NOT_FOUND', 'source-key was not found');
  const person = (await pool.query(`SELECT p.id,p.person_key,p.display_name
    FROM persons p JOIN accounting_scopes s ON s.id=p.scope_id
    WHERE s.scope_key=$1 AND p.person_key=$2`, [safeScopeKey, safePersonKey])).rows[0];
  if (!person) throw new BankSourceProvisioningError('PERSON_NOT_FOUND', 'person-key was not found in the accounting scope');
  await pool.query(`INSERT INTO bank_source_person(bank_source_id,person_id,relation_type)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [source.id, person.id, relationType]);
  return { sourceKey: safeSourceKey, personKey: person.person_key, displayName: person.display_name, relationType };
}

const SOURCE_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const PROVIDER_PATTERN = /^[a-zA-Z0-9._-]{1,200}$/;
export const SOURCE_PROVIDER_BINDING_PROVENANCE = 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT';

export class BankSourceProviderBindingError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'BankSourceProviderBindingError';
    this.code = code;
  }
}

function requireSourceKey(value) {
  if (typeof value !== 'string' || !SOURCE_KEY_PATTERN.test(value)) throw new BankSourceProviderBindingError('INVALID_SOURCE_KEY', 'sourceKey is required');
  return value;
}

function requireProvider(value) {
  if (typeof value !== 'string' || !PROVIDER_PATTERN.test(value)) throw new BankSourceProviderBindingError('INVALID_PROVIDER', 'provider is required');
  return value;
}

function requireAccountId(value) {
  if (!Number.isInteger(Number(value)) || Number(value) < 1) throw new BankSourceProviderBindingError('INVALID_ACCOUNT_ID', 'financialAccountId is required');
  return Number(value);
}

function requireReason(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new BankSourceProviderBindingError('INVALID_REASON', 'reason is required');
  return value.trim();
}

async function loadSourceScope(client, sourceId) {
  const result = await client.query(`SELECT DISTINCT p.scope_id
    FROM bank_source_person sp
    JOIN persons p ON p.id=sp.person_id
    WHERE sp.bank_source_id=$1`, [sourceId]);
  if (result.rowCount === 0) throw new BankSourceProviderBindingError('SOURCE_SCOPE_UNRESOLVED', 'Bank source has no accounting scope');
  if (result.rowCount > 1) throw new BankSourceProviderBindingError('SOURCE_SCOPE_AMBIGUOUS', 'Bank source has multiple accounting scopes');
  return Number(result.rows[0].scope_id);
}

export async function bindBankSourceProviderAccount(pool, { sourceKey, provider, financialAccountId, reason }) {
  const safeSourceKey = requireSourceKey(sourceKey);
  const safeProvider = requireProvider(provider);
  const accountId = requireAccountId(financialAccountId);
  const safeReason = requireReason(reason);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = (await client.query('SELECT id FROM bank_sources WHERE source_key=$1 FOR UPDATE', [safeSourceKey])).rows[0];
    if (!source) throw new BankSourceProviderBindingError('SOURCE_NOT_FOUND', 'source-key was not found');
    const scopeId = await loadSourceScope(client, source.id);
    const account = (await client.query('SELECT id,scope_id FROM financial_accounts WHERE id=$1', [accountId])).rows[0];
    if (!account) throw new BankSourceProviderBindingError('ACCOUNT_NOT_FOUND', 'financial account was not found');
    if (Number(account.scope_id) !== scopeId) throw new BankSourceProviderBindingError('SCOPE_MISMATCH', 'source and financial account are outside the same accounting scope');
    const existing = (await client.query(`SELECT id,bank_source_id,provider,financial_account_id,provenance,reason,active,created_at,updated_at
      FROM bank_source_provider_account_bindings
      WHERE bank_source_id=$1 AND provider=$2 AND active FOR UPDATE`, [source.id, safeProvider])).rows[0];
    if (existing) {
      if (Number(existing.financial_account_id) !== accountId) throw new BankSourceProviderBindingError('BINDING_CONFLICT', 'an active source/provider binding already targets another account');
      await client.query('COMMIT');
      return existing;
    }
    const result = await client.query(`INSERT INTO bank_source_provider_account_bindings
      (bank_source_id,provider,financial_account_id,provenance,reason)
      VALUES($1,$2,$3,$4,$5)
      RETURNING id,bank_source_id,provider,financial_account_id,provenance,reason,active,created_at,updated_at`, [source.id, safeProvider, accountId, SOURCE_PROVIDER_BINDING_PROVENANCE, safeReason]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function listBankSourceProviderAccountBindings(pool, { sourceKey = null, provider = null } = {}) {
  const safeSourceKey = sourceKey == null ? null : requireSourceKey(sourceKey);
  const safeProvider = provider == null ? null : requireProvider(provider);
  const result = await pool.query(`SELECT b.id,b.bank_source_id,s.source_key,b.provider,b.financial_account_id,
      b.provenance,b.reason,b.active,b.created_at,b.updated_at
    FROM bank_source_provider_account_bindings b
    JOIN bank_sources s ON s.id=b.bank_source_id
    WHERE ($1::text IS NULL OR s.source_key=$1) AND ($2::text IS NULL OR b.provider=$2)
    ORDER BY b.id`, [safeSourceKey, safeProvider]);
  return result.rows;
}

export async function disableBankSourceProviderAccountBinding(pool, { sourceKey, provider }) {
  const safeSourceKey = requireSourceKey(sourceKey);
  const safeProvider = requireProvider(provider);
  const result = await pool.query(`UPDATE bank_source_provider_account_bindings b
    SET active=FALSE,updated_at=NOW()
    FROM bank_sources s
    WHERE s.id=b.bank_source_id AND s.source_key=$1 AND b.provider=$2 AND b.active
    RETURNING b.id,b.bank_source_id,b.provider,b.financial_account_id,b.provenance,b.reason,b.active,b.created_at,b.updated_at`, [safeSourceKey, safeProvider]);
  if (!result.rowCount) throw new BankSourceProviderBindingError('BINDING_NOT_FOUND', 'active source/provider binding was not found');
  return result.rows[0];
}

export async function findActiveSourceProviderAccountBinding(client, { bankSourceId, provider, scopeId }) {
  if (!bankSourceId || !provider || !scopeId) return null;
  const result = await client.query(`SELECT b.financial_account_id
    FROM bank_source_provider_account_bindings b
    JOIN financial_accounts a ON a.id=b.financial_account_id
    WHERE b.bank_source_id=$1 AND b.provider=$2 AND b.active AND a.scope_id=$3`, [bankSourceId, provider, scopeId]);
  return result.rows.length === 1 ? Number(result.rows[0].financial_account_id) : null;
}

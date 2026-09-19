import crypto from 'node:crypto';

export const DEVICE_CREDENTIAL_VERSION = 'bg1';

function safeSourceKey(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value);
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function sameHash(left, right) {
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createDeviceToken(credentialKey, secret) {
  return `${DEVICE_CREDENTIAL_VERSION}.${credentialKey}.${secret}`;
}

export function parseDeviceToken(token) {
  if (typeof token !== 'string') return null;
  const match = /^bg1\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return match ? { credentialKey: match[1], secret: match[2] } : null;
}

export async function createBankDeviceCredential(pool, { sourceKey, displayName }) {
  if (!safeSourceKey(sourceKey)) throw new Error('sourceKey is required and must be a safe identifier');
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 200) throw new Error('displayName is required');
  const source = (await pool.query('SELECT id FROM bank_sources WHERE source_key=$1', [sourceKey])).rows[0];
  if (!source) {
    const error = new Error('Bank source was not found');
    error.code = 'SOURCE_NOT_FOUND';
    throw error;
  }
  const credentialKey = crypto.randomBytes(12).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = createDeviceToken(credentialKey, secret);
  const result = await pool.query(`INSERT INTO bank_device_credentials(credential_key,bank_source_id,display_name,secret_hash)
    VALUES($1,$2,$3,$4) RETURNING id,credential_key,bank_source_id,display_name,enabled,created_at,last_used_at,revoked_at`,
  [credentialKey, source.id, displayName.trim(), hashSecret(secret)]);
  return { ...result.rows[0], token };
}

export async function authenticateBankDevice(pool, token) {
  const parsed = parseDeviceToken(token);
  if (!parsed) return { ok: false };
  const result = await pool.query(`SELECT c.id,c.secret_hash,c.enabled,c.revoked_at,s.id AS bank_source_id,s.source_key,s.enabled AS source_enabled
    FROM bank_device_credentials c JOIN bank_sources s ON s.id=c.bank_source_id WHERE c.credential_key=$1`, [parsed.credentialKey]);
  const row = result.rows[0];
  if (!row || !row.enabled || row.revoked_at || !row.source_enabled || !sameHash(row.secret_hash, hashSecret(parsed.secret))) return { ok: false };
  await pool.query('UPDATE bank_device_credentials SET last_used_at=NOW() WHERE id=$1', [row.id]);
  return { ok: true, credentialId: Number(row.id), bankSourceId: Number(row.bank_source_id), sourceKey: row.source_key };
}

export async function listBankDeviceCredentials(pool) {
  const result = await pool.query(`SELECT c.id,c.credential_key,c.bank_source_id,c.display_name,c.enabled,c.created_at,c.last_used_at,c.revoked_at,s.source_key
    FROM bank_device_credentials c JOIN bank_sources s ON s.id=c.bank_source_id ORDER BY c.id`);
  return result.rows;
}

export async function revokeBankDeviceCredential(pool, credentialKey) {
  if (typeof credentialKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(credentialKey)) throw new Error('credential key is invalid');
  const result = await pool.query(`UPDATE bank_device_credentials SET enabled=FALSE,revoked_at=COALESCE(revoked_at,NOW())
    WHERE credential_key=$1 RETURNING id,credential_key,enabled,revoked_at`, [credentialKey]);
  if (!result.rowCount) {
    const error = new Error('Device credential was not found');
    error.code = 'CREDENTIAL_NOT_FOUND';
    throw error;
  }
  return result.rows[0];
}

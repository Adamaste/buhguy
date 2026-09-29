const RELATION_TYPES = new Set(['OWNER', 'AUTHORIZED_USER']);
const INSTRUMENT_TYPES = new Set(['CARD', 'VIRTUAL_CARD', 'OTHER']);
const REFERENCE_KINDS = new Set(['MASKED_CARD', 'MASKED_ACCOUNT', 'OTHER']);
const RESOLUTION_STATES = new Set(['EXACT', 'MANUAL', 'RECONCILED', 'UNKNOWN']);

function requiredText(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} is required`);
  return value.trim();
}

function requiredId(value, field) {
  if (!Number.isInteger(Number(value)) || Number(value) < 1) throw new Error(`${field} is required`);
  return Number(value);
}

function requireState(value) {
  if (!RESOLUTION_STATES.has(value)) throw new Error('Unsupported resolution state');
  return value;
}

export function buildBankTransactionCoverage(rows = []) {
  const total = rows.length;
  const resolved = rows.filter((row) => row.financialAccountId != null && row.resolutionState !== 'UNKNOWN').length;
  const states = Object.fromEntries([...RESOLUTION_STATES].map((state) => [state, rows.filter((row) => row.resolutionState === state).length]));
  const unresolved = total - resolved;
  return {
    totalBankTransactions: total,
    resolvedAccount: resolved,
    unresolvedAccount: unresolved,
    exact: states.EXACT,
    manual: states.MANUAL,
    reconciled: states.RECONCILED,
    unknown: states.UNKNOWN + rows.filter((row) => row.resolutionState == null).length,
    invariant: total === resolved + unresolved,
  };
}

export async function bankTransactionAccountCoverage(pool) {
  const result = await pool.query(`SELECT bt.id AS "transactionId", r.financial_account_id AS "financialAccountId",
      r.resolution_state AS "resolutionState"
    FROM bank_transactions bt
    LEFT JOIN bank_transaction_account_resolution r ON r.bank_transaction_id=bt.id
    ORDER BY bt.id`);
  return buildBankTransactionCoverage(result.rows);
}

export async function createFinancialAccount(pool, { scopeKey = 'default', institution, provider = null, displayName, currency = 'RUB', active = true }) {
  const scope = requiredText(scopeKey, 'scopeKey', 128);
  const institutionValue = requiredText(institution, 'institution');
  const name = requiredText(displayName, 'displayName');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be an uppercase ISO 4217 code');
  const result = await pool.query(`INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency,active)
    SELECT id,$2,$3,$4,$5,$6 FROM accounting_scopes WHERE scope_key=$1
    RETURNING id,scope_id,institution,provider,display_name,currency,active`, [scope, institutionValue, provider, name, currency, Boolean(active)]);
  if (!result.rowCount) throw new Error(`Accounting scope not found: ${scope}`);
  return result.rows[0];
}

export async function relateFinancialAccountPerson(pool, { financialAccountId, personId, relationType, provenance, reason }) {
  if (!RELATION_TYPES.has(relationType)) throw new Error('Unsupported account-person relation type');
  const accountPerson = (await pool.query(`SELECT a.id AS account_id, a.scope_id AS account_scope_id, p.id AS person_id, p.scope_id AS person_scope_id
    FROM financial_accounts a CROSS JOIN persons p WHERE a.id=$1 AND p.id=$2`, [requiredId(financialAccountId, 'financialAccountId'), requiredId(personId, 'personId')])).rows[0];
  if (!accountPerson) throw new Error('Financial account or person was not found');
  if (Number(accountPerson.account_scope_id) !== Number(accountPerson.person_scope_id)) throw new Error('Financial account and person are outside the same accounting scope');
  const result = await pool.query(`INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason)
    VALUES($1,$2,$3,$4,$5) RETURNING id,financial_account_id,person_id,relation_type,provenance,reason`, [requiredId(financialAccountId, 'financialAccountId'), requiredId(personId, 'personId'), relationType, requiredText(provenance, 'provenance'), requiredText(reason, 'reason', 1000)]);
  return result.rows[0];
}

export async function createPaymentInstrument(pool, { financialAccountId, instrumentType, provider = null, displayName, active = true }) {
  if (!INSTRUMENT_TYPES.has(instrumentType)) throw new Error('Unsupported payment instrument type');
  const result = await pool.query(`INSERT INTO payment_instruments(financial_account_id,instrument_type,provider,display_name,active)
    VALUES($1,$2,$3,$4,$5) RETURNING id,financial_account_id,instrument_type,provider,display_name,active`, [requiredId(financialAccountId, 'financialAccountId'), instrumentType, provider, requiredText(displayName, 'displayName'), Boolean(active)]);
  return result.rows[0];
}

export async function createBankAccountReference(pool, { financialAccountId, provider, referenceKind, referenceValue }) {
  if (!REFERENCE_KINDS.has(referenceKind)) throw new Error('Unsupported account reference kind');
  const result = await pool.query(`INSERT INTO bank_account_references(financial_account_id,provider,reference_kind,reference_value)
    VALUES($1,$2,$3,$4) RETURNING id,financial_account_id,provider,reference_kind,reference_value`, [requiredId(financialAccountId, 'financialAccountId'), requiredText(provider, 'provider'), referenceKind, requiredText(referenceValue, 'referenceValue', 200)]);
  return result.rows[0];
}

export async function resolveBankTransactionAccount(pool, { bankTransactionId, financialAccountId = null, resolutionState, provenance, reason }) {
  const state = requireState(resolutionState);
  if (state === 'EXACT') throw new Error('EXACT resolution requires proven account reference evidence');
  if (state === 'UNKNOWN' && financialAccountId != null) throw new Error('UNKNOWN resolution cannot name a financial account');
  if (state !== 'UNKNOWN' && financialAccountId == null) throw new Error(`${state} resolution requires a financial account`);
  const transactionId = requiredId(bankTransactionId, 'bankTransactionId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await loadTransactionContext(client, transactionId);
    if (state !== 'UNKNOWN') {
      const account = (await client.query('SELECT id,scope_id FROM financial_accounts WHERE id=$1', [requiredId(financialAccountId, 'financialAccountId')])).rows[0];
      if (!account) throw new Error('Financial account was not found');
      if (Number(account.scope_id) !== Number(context.scopeId)) throw new Error('Financial account is outside the transaction scope');
    }
    const result = await client.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(bank_transaction_id) DO UPDATE SET financial_account_id=EXCLUDED.financial_account_id,
        resolution_state=EXCLUDED.resolution_state,provenance=EXCLUDED.provenance,reason=EXCLUDED.reason,resolved_at=NOW()
      RETURNING bank_transaction_id,financial_account_id,resolution_state,provenance,reason`, [transactionId, financialAccountId == null ? null : requiredId(financialAccountId, 'financialAccountId'), state, requiredText(provenance, 'provenance'), requiredText(reason, 'reason', 1000)]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function loadTransactionContext(client, transactionId) {
  const result = await client.query(`SELECT bt.id, bt.account_reference AS "accountReference",
      eo.ingestion_metadata->>'provider' AS provider,
      COALESCE(array_agg(DISTINCT p.scope_id) FILTER (WHERE p.scope_id IS NOT NULL), ARRAY[]::bigint[]) AS scope_ids
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id=bt.observation_id
    LEFT JOIN bank_source_person sp ON sp.bank_source_id=eo.bank_source_id AND sp.relation_type='OWNER'
    LEFT JOIN persons p ON p.id=sp.person_id
    WHERE bt.id=$1
    GROUP BY bt.id, eo.ingestion_metadata`, [transactionId]);
  const context = result.rows[0];
  if (!context) throw new Error('Bank transaction was not found');
  if (context.scope_ids.length !== 1) throw new Error('Bank source accounting scope is not unique');
  return { ...context, scopeId: Number(context.scope_ids[0]) };
}

async function persistResolution(client, { transactionId, financialAccountId = null, resolutionState, provenance, reason }) {
  const result = await client.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(bank_transaction_id) DO UPDATE SET financial_account_id=EXCLUDED.financial_account_id,
      resolution_state=EXCLUDED.resolution_state,provenance=EXCLUDED.provenance,reason=EXCLUDED.reason,resolved_at=NOW()
    RETURNING bank_transaction_id,financial_account_id,resolution_state,provenance,reason`, [transactionId, financialAccountId, resolutionState, requiredText(provenance, 'provenance'), requiredText(reason, 'reason', 1000)]);
  return result.rows[0];
}

export async function resolveBankTransactionAccountFromReference(pool, { bankTransactionId }) {
  const transactionId = requiredId(bankTransactionId, 'bankTransactionId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await loadTransactionContext(client, transactionId);
    const candidates = context.provider && context.accountReference
      ? (await client.query(`SELECT DISTINCT r.financial_account_id
          FROM bank_account_references r
          JOIN financial_accounts a ON a.id=r.financial_account_id
          WHERE r.provider=$1 AND r.reference_value=$2 AND a.scope_id=$3
          ORDER BY r.financial_account_id`, [context.provider, context.accountReference, context.scopeId])).rows
      : [];
    let result;
    if (candidates.length === 1) {
      result = await persistResolution(client, { transactionId, financialAccountId: Number(candidates[0].financial_account_id), resolutionState: 'EXACT', provenance: 'OBSERVED_PROVIDER_REFERENCE', reason: 'One provider-scoped account reference candidate' });
    } else {
      const reason = candidates.length > 1 ? 'Ambiguous provider-scoped account reference candidates' : 'No provider-scoped account reference candidate';
      result = await persistResolution(client, { transactionId, resolutionState: 'UNKNOWN', provenance: candidates.length > 1 ? 'OBSERVED_PROVIDER_REFERENCE_AMBIGUOUS' : 'OBSERVED_PROVIDER_REFERENCE_UNRESOLVED', reason });
    }
    await client.query('COMMIT');
    return { ...result, candidateCount: candidates.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export const BANK_ACCOUNT_RESOLUTION_STATES = Object.freeze([...RESOLUTION_STATES]);

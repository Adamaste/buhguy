import { fiscalContentFingerprint } from './fiscal-evidence.js';
import { GRAPH_MODEL_VERSION } from './business-event-graph.js';
import { lockMatchedPurchaseBankTransaction, lockMatchedPurchaseScope, lockMatchedPurchaseScopeTransaction } from './matched-purchase-locks.js';

export const TROIKA_PREPAID_WALLET_ENABLED_ENV = 'TROIKA_PREPAID_WALLET_MANUAL_ENABLED';
export const TROIKA_PREPAID_WALLET_RULE = 'TROIKA_PREPAID_WALLET_V1';
export const TROIKA_PREPAID_WALLET_VERSION = 'troika-prepaid-wallet-v1';
export const TROIKA_WALLET_LEDGER_RULE = 'LEDGER_TROIKA_PREPAID_WALLET_V1';
export const TROIKA_WALLET_LEDGER_VERSION = 'troika-prepaid-wallet-ledger-v1';
export const TROIKA_PROVIDER = 'ru.alfabank.mobile.android';
const NORMALIZATION_VERSION = 'fiscal-normalizer-v1';
const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
function positiveId(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('INVALID_ARGUMENT', `${name} must be a positive integer`);
  return parsed;
}
function requiredText(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('INVALID_ARGUMENT', `${name} is required`);
  return value.trim();
}
function canonicalMoney(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !MONEY.test(value) || (!allowZero && value === '0.00')) fail('INVALID_ARGUMENT', 'amount must be a canonical decimal string');
  return value;
}
function canonicalTime(value, name) {
  const date = new Date(value);
  if (!(typeof value === 'string' || value instanceof Date) || Number.isNaN(date.getTime())) fail('INVALID_ARGUMENT', `${name} must be a valid timestamp`);
  return date.toISOString();
}
function enabled() {
  if (process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV] !== 'true') fail('TROIKA_WALLET_WRITES_DISABLED');
}
function sameStored(row, fields) {
  return Object.entries(fields).every(([key, value]) => String(row[key] ?? '') === String(value ?? ''));
}
function cents(value) {
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)\.\d{2}$/.test(text)) fail('WALLET_BALANCE_INVALID');
  const [units, fraction] = text.split('.');
  return BigInt(units) * 100n + BigInt(fraction);
}
function fromCents(value) {
  if (value < 0n) return `-${fromCents(-value)}`;
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

export function calculatePrepaidWalletBalance(snapshot, movements, at) {
  if (!snapshot) return { status: 'BASELINE_REQUIRED', balance: null, snapshotId: null };
  const atTime = Date.parse(at);
  const snapshotTime = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(atTime) || !Number.isFinite(snapshotTime) || snapshotTime >= atTime) return { status: 'BASELINE_NOT_BEFORE_EVENT', balance: null, snapshotId: Number(snapshot.id) };
  let balance = cents(snapshot.balance);
  for (const movement of movements) {
    const movementTime = Date.parse(movement.occurredAt);
    if (!Number.isFinite(movementTime)) return { status: 'MOVEMENT_TIME_INVALID', balance: null, snapshotId: Number(snapshot.id) };
    if (!['TOPUP', 'RIDE_REDEMPTION'].includes(movement.movementType)) return { status: 'MOVEMENT_TYPE_INVALID', balance: null, snapshotId: Number(snapshot.id) };
    if (movementTime === snapshotTime) return { status: 'AMBIGUOUS_SNAPSHOT_BOUNDARY', balance: null, snapshotId: Number(snapshot.id) };
    if (movementTime <= snapshotTime || movementTime > atTime) continue;
    const value = cents(movement.amount);
    balance += movement.movementType === 'TOPUP' ? value : movement.movementType === 'RIDE_REDEMPTION' ? -value : 0n;
  }
  return { status: balance < 0n ? 'INSUFFICIENT_BALANCE' : 'KNOWN', balance: fromCents(balance), snapshotId: Number(snapshot.id) };
}

async function walletScope(pool, walletId) {
  const row = (await pool.query(`SELECT scope.scope_key
    FROM prepaid_wallets wallet JOIN accounting_scopes scope ON scope.id=wallet.scope_id
    WHERE wallet.id=$1`, [walletId])).rows[0];
  if (!row) fail('WALLET_NOT_FOUND');
  return row.scope_key;
}

async function withScopeTransaction(pool, scopeKey, operation, bankTransactionId = null) {
  const client = await pool.connect();
  let releaseScopeLock = null;
  try {
    releaseScopeLock = await lockMatchedPurchaseScope(client, scopeKey);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await lockMatchedPurchaseScopeTransaction(client, scopeKey);
    if (bankTransactionId !== null) await lockMatchedPurchaseBankTransaction(client, bankTransactionId);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    let releaseError;
    if (releaseScopeLock) {
      try { await releaseScopeLock(); } catch (error) { releaseError = error; }
    }
    client.release(releaseError);
  }
}

export async function createPrepaidWallet(pool, {
  scopeKey, ownerPersonId, walletKey = 'troika', displayName = 'Тройка', currency = 'RUB', reason,
}) {
  enabled();
  const key = requiredText(walletKey, 'walletKey', 120);
  const name = requiredText(displayName, 'displayName', 160);
  const note = requiredText(reason, 'reason');
  const personId = positiveId(ownerPersonId, 'ownerPersonId');
  if (currency !== 'RUB') fail('WALLET_CURRENCY_UNSUPPORTED');
  const result = await withScopeTransaction(pool, requiredText(scopeKey, 'scopeKey', 120), async (client) => {
    const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
    if (!scope) fail('SCOPE_NOT_FOUND');
    const person = (await client.query('SELECT id FROM persons WHERE id=$1 AND scope_id=$2', [personId, scope.id])).rows[0];
    if (!person) fail('OWNER_SCOPE_CONFLICT');
    const inserted = await client.query(`INSERT INTO prepaid_wallets(scope_id,owner_person_id,wallet_key,display_name,currency,provenance,reason)
      VALUES($1,$2,$3,$4,$5,'USER_CONFIRMED',$6)
      ON CONFLICT(scope_id,wallet_key) DO NOTHING RETURNING id`, [scope.id, personId, key, name, currency, note]);
    const row = (await client.query(`SELECT id,scope_id,owner_person_id,wallet_key,display_name,currency,provenance,reason
      FROM prepaid_wallets WHERE scope_id=$1 AND wallet_key=$2 FOR SHARE`, [scope.id, key])).rows[0];
    if (!row || !sameStored(row, { owner_person_id: personId, display_name: name, currency, provenance: 'USER_CONFIRMED', reason: note })) fail('WALLET_IDENTITY_CONFLICT');
    return { walletId: Number(row.id), created: inserted.rowCount === 1 };
  });
  return result;
}

async function validatedTopupInputs(client, fields) {
  const scope = (await client.query('SELECT id,scope_key FROM accounting_scopes WHERE scope_key=$1', [fields.scopeKey])).rows[0];
  const wallet = (await client.query(`SELECT id,scope_id,owner_person_id,currency
    FROM prepaid_wallets WHERE id=$1 FOR UPDATE`, [fields.walletId])).rows[0];
  if (!scope || !wallet) fail(!scope ? 'SCOPE_NOT_FOUND' : 'WALLET_NOT_FOUND');
  if (Number(wallet.scope_id) !== Number(scope.id) || Number(wallet.owner_person_id) !== fields.ownerPersonId || wallet.currency !== 'RUB') fail('WALLET_OWNER_OR_SCOPE_CONFLICT');

  const tx = (await client.query(`SELECT bt.id,bt.occurred_at,bt.amount::text AS amount,bt.currency,bt.direction,bt.event_type,
      bt.normalization_status,bt.account_reference,bt.account_reference_kind,eo.bank_source_id,eo.ingestion_metadata->>'provider' AS provider
    FROM bank_transactions bt JOIN bank_event_observations eo ON eo.id=bt.observation_id
    WHERE bt.id=$1 FOR UPDATE OF bt`, [fields.bankTransactionId])).rows[0];
  if (!tx) fail('BANK_TRANSACTION_NOT_FOUND');
  if (tx.provider !== TROIKA_PROVIDER || tx.currency !== 'RUB' || !tx.amount || !tx.occurred_at) fail('BANK_TRANSACTION_PROVIDER_OR_MONEY_CONFLICT');
  if (String(tx.amount) !== fields.amount) fail('BANK_TRANSACTION_AMOUNT_CONFLICT');
  if (tx.account_reference_kind === 'MASKED_CARD' && tx.account_reference !== '****5580') fail('BANK_TRANSACTION_CARD_REFERENCE_CONFLICT');
  if (tx.direction === 'CREDIT' || tx.event_type === 'CREDIT' || tx.event_type === 'CREDIT_PAYMENT'
    || tx.event_type === 'REFUND' || tx.event_type === 'CASH_WITHDRAWAL' || tx.event_type === 'CASH_DEPOSIT'
    || tx.normalization_status === 'REJECTED') fail('BANK_TRANSACTION_CONTRADICTS_TOPUP');

  const accountResolution = (await client.query(`SELECT financial_account_id,resolution_state
    FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1`, [fields.bankTransactionId])).rows[0];
  if (accountResolution && accountResolution.resolution_state !== 'UNKNOWN'
    && Number(accountResolution.financial_account_id) !== fields.financialAccountId) fail('BANK_TRANSACTION_ACCOUNT_RESOLUTION_CONFLICT');
  const instrumentResolution = (await client.query(`SELECT payment_instrument_id,resolution_state
    FROM bank_transaction_payment_instrument_resolution WHERE bank_transaction_id=$1`, [fields.bankTransactionId])).rows[0];
  if (instrumentResolution && instrumentResolution.resolution_state !== 'UNKNOWN'
    && Number(instrumentResolution.payment_instrument_id) !== fields.paymentInstrumentId) fail('BANK_TRANSACTION_PAYMENT_INSTRUMENT_CONFLICT');

  const sourceOwners = (await client.query(`SELECT DISTINCT person.id AS person_id,person.scope_id
    FROM bank_source_person relation JOIN persons person ON person.id=relation.person_id
    WHERE relation.bank_source_id=$1 AND relation.relation_type='OWNER' ORDER BY person.scope_id,person.id`, [tx.bank_source_id])).rows;
  if (sourceOwners.length !== 1 || Number(sourceOwners[0].person_id) !== fields.ownerPersonId || Number(sourceOwners[0].scope_id) !== Number(scope.id)) fail('BANK_SOURCE_OWNER_SCOPE_CONFLICT');

  const account = (await client.query(`SELECT id,scope_id,currency,provider,active
    FROM financial_accounts WHERE id=$1 FOR UPDATE`, [fields.financialAccountId])).rows[0];
  const accountOwners = (await client.query(`SELECT count(*) FILTER (WHERE relation.relation_type='OWNER')::int AS owner_count,
      count(*) FILTER (WHERE relation.relation_type='OWNER' AND relation.person_id=$2 AND person.scope_id=$3)::int AS expected_owner_count
    FROM financial_account_person_relations relation JOIN persons person ON person.id=relation.person_id
    WHERE relation.financial_account_id=$1`, [fields.financialAccountId, fields.ownerPersonId, scope.id])).rows[0];
  const instrument = (await client.query(`SELECT id,scope_id,financial_account_id,provider,instrument_type,active
    FROM payment_instruments WHERE id=$1 FOR UPDATE`, [fields.paymentInstrumentId])).rows[0];
  const instrumentOwners = (await client.query(`SELECT count(*) FILTER (WHERE relation.relation_type='OWNER')::int AS owner_count,
      count(*) FILTER (WHERE relation.relation_type='OWNER' AND relation.person_id=$2 AND person.scope_id=$3)::int AS expected_owner_count
    FROM payment_instrument_person_relations relation JOIN persons person ON person.id=relation.person_id
    WHERE relation.payment_instrument_id=$1`, [fields.paymentInstrumentId, fields.ownerPersonId, scope.id])).rows[0];
  const cardReferences = (await client.query(`SELECT reference.id,reference.payment_instrument_id
    FROM bank_account_references reference
    JOIN payment_instruments candidate ON candidate.id=reference.payment_instrument_id
    WHERE reference.provider=$1 AND reference.reference_kind='MASKED_CARD'
      AND reference.reference_value='****5580' AND candidate.scope_id=$2
    ORDER BY reference.id`, [TROIKA_PROVIDER, scope.id])).rows;
  if (!account || !instrument || !account.active || !instrument.active || account.currency !== 'RUB'
    || account.provider !== TROIKA_PROVIDER || instrument.provider !== TROIKA_PROVIDER || instrument.instrument_type !== 'CARD'
    || Number(account.scope_id) !== Number(scope.id) || Number(instrument.scope_id) !== Number(scope.id)
    || Number(instrument.financial_account_id) !== Number(account.id) || Number(account.id) !== fields.financialAccountId
    || Number(instrument.id) !== fields.paymentInstrumentId || Number(accountOwners.owner_count) !== 1 || Number(accountOwners.expected_owner_count) !== 1
    || Number(instrumentOwners.owner_count) !== 1 || Number(instrumentOwners.expected_owner_count) !== 1
    || cardReferences.length !== 1 || Number(cardReferences[0].payment_instrument_id) !== fields.paymentInstrumentId) fail('BANK_ACCOUNT_INSTRUMENT_OWNER_CONFLICT');
  return { scope, wallet, transaction: tx };
}

async function existingTopup(client, fields) {
  const row = (await client.query(`SELECT id,scope_id,wallet_id,movement_type,amount::text AS amount,currency,occurred_at,
      bank_transaction_id,source_provider,financial_account_id,payment_instrument_id,source_account_provenance,evidence_basis,
      confirmed_by_person_id,provenance,confirmation_key,reason,business_event_id,ledger_entry_id,semantic_key
    FROM prepaid_wallet_movements WHERE bank_transaction_id=$1 OR confirmation_key=$2 ORDER BY id FOR UPDATE`, [fields.bankTransactionId, fields.confirmationKey])).rows;
  if (!row.length) return null;
  if (row.length !== 1) fail('TOPUP_IDEMPOTENCY_CONFLICT');
  const found = row[0];
  const expected = {
    scope_id: fields.scopeId, wallet_id: fields.walletId, movement_type: 'TOPUP', amount: fields.amount, currency: 'RUB',
    bank_transaction_id: fields.bankTransactionId, source_provider: TROIKA_PROVIDER, financial_account_id: fields.financialAccountId,
    payment_instrument_id: fields.paymentInstrumentId, source_account_provenance: 'USER_CONFIRMED', evidence_basis: fields.evidenceBasis,
    confirmed_by_person_id: fields.ownerPersonId, provenance: 'USER_CONFIRMED', confirmation_key: fields.confirmationKey, reason: fields.reason,
  };
  if (!sameStored(found, expected) || new Date(found.occurred_at).toISOString() !== fields.occurredAt) fail('TOPUP_IDEMPOTENCY_CONFLICT');
  const postings = (await client.query(`SELECT account.account_code,posting.debit::text AS debit,posting.credit::text AS credit
    FROM ledger_postings posting JOIN ledger_accounts account ON account.id=posting.account_id
    WHERE posting.ledger_entry_id=$1 ORDER BY account.account_code`, [found.ledger_entry_id])).rows;
  const expectedWallet = `PREPAID_WALLET:${fields.walletId}`;
  const expectedBank = `FINANCIAL_ACCOUNT:${fields.financialAccountId}`;
  if (postings.length !== 2 || !postings.some((p) => p.account_code === expectedWallet && p.debit === fields.amount && p.credit === '0.00')
    || !postings.some((p) => p.account_code === expectedBank && p.debit === '0.00' && p.credit === fields.amount)) fail('TOPUP_LEDGER_CONFLICT');
  return { movementId: Number(found.id), businessEventId: Number(found.business_event_id), ledgerEntryId: Number(found.ledger_entry_id), created: false, replayed: true };
}

async function ensureLedgerAccount(client, { scopeId, code, type, description, financialAccountId = null, currency = null }) {
  await client.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope_id,account_code) DO NOTHING`, [scopeId, code, type, description, financialAccountId, currency]);
  const row = (await client.query(`SELECT id,account_type,financial_account_id,account_currency
    FROM ledger_accounts WHERE scope_id=$1 AND account_code=$2 FOR SHARE`, [scopeId, code])).rows[0];
  if (!row || row.account_type !== type || (row.financial_account_id === null ? null : Number(row.financial_account_id)) !== financialAccountId || row.account_currency !== currency) fail('LEDGER_ACCOUNT_CATALOG_CONFLICT');
  return Number(row.id);
}

async function insertManualEvent(client, { scopeId, walletId, movementId, movementType, amount, currency, occurredAt, reason }) {
  const eventType = movementType === 'TOPUP' ? 'STORED_VALUE_ACQUISITION' : 'STORED_VALUE_REDEMPTION';
  const ruleVersion = TROIKA_PREPAID_WALLET_VERSION;
  const semanticKey = fiscalContentFingerprint({ scopeId, walletId, movementId, movementType, amount, currency, occurredAt, provenance: 'USER_CONFIRMED' });
  await client.query(`INSERT INTO business_graph_rules(rule_code,rule_version,description)
    VALUES($1,$2,'User-confirmed Troika prepaid wallet movements') ON CONFLICT(rule_code,rule_version) DO NOTHING`, [TROIKA_PREPAID_WALLET_RULE, ruleVersion]);
  const inserted = await client.query(`INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
    VALUES($1,$2,'CONFIRMED','MANUAL',$9,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(scope_id,semantic_key,graph_model_version,rule_code,rule_version,origin) DO NOTHING RETURNING id`, [scopeId, eventType, TROIKA_PREPAID_WALLET_RULE, ruleVersion, semanticKey, amount, currency, reason, GRAPH_MODEL_VERSION]);
  const event = (await client.query(`SELECT id,event_type,resolution_status,origin,rule_code,rule_version,semantic_key,amount::text AS amount,currency
    FROM business_events WHERE scope_id=$1 AND semantic_key=$2 AND graph_model_version=$3 AND rule_code=$4 AND rule_version=$5 AND origin='MANUAL'`, [scopeId, semanticKey, GRAPH_MODEL_VERSION, TROIKA_PREPAID_WALLET_RULE, ruleVersion])).rows[0];
  if (!event || event.event_type !== eventType || event.resolution_status !== 'CONFIRMED' || event.origin !== 'MANUAL'
    || event.rule_code !== TROIKA_PREPAID_WALLET_RULE || event.rule_version !== ruleVersion || event.amount !== amount || event.currency !== currency) fail('BUSINESS_EVENT_IDENTITY_CONFLICT');
  return { eventId: Number(event.id), semanticKey, created: inserted.rowCount === 1 };
}

async function insertManualLedger(client, { scopeId, eventId, movementId, movementType, amount, currency, occurredAt, walletId, financialAccountId, reason }) {
  const walletCode = `PREPAID_WALLET:${walletId}`;
  const bankAccountId = movementType === 'TOPUP'
    ? await ensureLedgerAccount(client, { scopeId, code: `FINANCIAL_ACCOUNT:${financialAccountId}`, type: 'ASSET', description: 'Confirmed bank financial account', financialAccountId, currency })
    : null;
  const walletAccountId = await ensureLedgerAccount(client, { scopeId, code: walletCode, type: 'ASSET', description: 'Troika prepaid transport wallet' });
  const rideExpenseId = movementType === 'RIDE_REDEMPTION'
    ? await ensureLedgerAccount(client, { scopeId, code: 'TRANSPORT_EXPENSE', type: 'EXPENSE', description: 'Confirmed public transport use' })
    : null;
  const ledgerSemanticKey = fiscalContentFingerprint({ rule: TROIKA_WALLET_LEDGER_RULE, scopeId, eventId, movementId, movementType, amount, currency });
  const derivationRule = TROIKA_WALLET_LEDGER_RULE;
  const inserted = await client.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description)
    VALUES($1,$2,$3,$4,$5,$6,$7,'READY','BUSINESS_CONFIRMED','MANUAL',$8,$9)
    ON CONFLICT(scope_id,semantic_key,derivation_rule,derivation_version,origin) DO NOTHING RETURNING id`, [scopeId, eventId, currency, occurredAt, ledgerSemanticKey, derivationRule, TROIKA_WALLET_LEDGER_VERSION, `USER_CONFIRMED_${movementType}`, reason]);
  const ledger = (await client.query(`SELECT id,source_event_id,semantic_key,derivation_rule,derivation_version,origin,currency
    FROM ledger_entries WHERE scope_id=$1 AND semantic_key=$2 AND derivation_rule=$3 AND derivation_version=$4 AND origin='MANUAL'`, [scopeId, ledgerSemanticKey, derivationRule, TROIKA_WALLET_LEDGER_VERSION])).rows[0];
  if (!ledger || Number(ledger.source_event_id) !== eventId || ledger.currency !== currency) fail('LEDGER_ENTRY_IDENTITY_CONFLICT');
  const entryId = Number(ledger.id);
  const expectedPostings = movementType === 'TOPUP'
    ? [{ accountId: walletAccountId, debit: amount, credit: '0.00' }, { accountId: bankAccountId, debit: '0.00', credit: amount }]
    : [{ accountId: rideExpenseId, debit: amount, credit: '0.00' }, { accountId: walletAccountId, debit: '0.00', credit: amount }];
  for (const posting of expectedPostings) await client.query(`INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [entryId, posting.accountId, currency, posting.debit, posting.credit]);
  const actualPostings = (await client.query('SELECT account_id,debit::text AS debit,credit::text AS credit FROM ledger_postings WHERE ledger_entry_id=$1 ORDER BY account_id', [entryId])).rows;
  if (actualPostings.length !== expectedPostings.length) fail('LEDGER_POSTINGS_CONFLICT');
  for (const expected of expectedPostings) {
    if (!actualPostings.some((row) => Number(row.account_id) === expected.accountId && row.debit === expected.debit && row.credit === expected.credit)) fail('LEDGER_POSTINGS_CONFLICT');
  }
  const linkRole = movementType === 'TOPUP' ? 'PREPAID_WALLET_TOPUP' : 'PREPAID_WALLET_RIDE';
  return { ledgerEntryId: entryId, bankAccountId, walletAccountId, linkRole, inserted: inserted.rowCount === 1 };
}

async function addLedgerSourceLink(client, { ledgerEntryId, eventId, receiptId = null, bankTransactionId = null, role, semanticKey }) {
  await client.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,receipt_id,link_role,semantic_key,bank_transaction_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(semantic_key) DO NOTHING`, [ledgerEntryId, eventId, receiptId, role, semanticKey, bankTransactionId]);
  const rows = (await client.query(`SELECT id,ledger_entry_id,business_event_id,receipt_id,link_role,semantic_key,bank_transaction_id
    FROM ledger_source_links WHERE semantic_key=$1`, [semanticKey])).rows;
  if (rows.length !== 1 || Number(rows[0].ledger_entry_id) !== ledgerEntryId || Number(rows[0].business_event_id) !== eventId
    || (rows[0].receipt_id === null ? null : Number(rows[0].receipt_id)) !== receiptId
    || rows[0].link_role !== role || (rows[0].bank_transaction_id === null ? null : Number(rows[0].bank_transaction_id)) !== bankTransactionId) fail('LEDGER_SOURCE_LINK_CONFLICT');
  return Number(rows[0].id);
}

export async function confirmPrepaidWalletTopup(pool, {
  walletId, bankTransactionId, financialAccountId, paymentInstrumentId, ownerPersonId,
  amount: requestedAmount, currency = 'RUB', evidenceBasis, confirmationKey, reason,
}) {
  enabled();
  const fields = {
    walletId: positiveId(walletId, 'walletId'), bankTransactionId: positiveId(bankTransactionId, 'bankTransactionId'),
    financialAccountId: positiveId(financialAccountId, 'financialAccountId'), paymentInstrumentId: positiveId(paymentInstrumentId, 'paymentInstrumentId'),
    ownerPersonId: positiveId(ownerPersonId, 'ownerPersonId'), amount: canonicalMoney(requestedAmount), currency,
    evidenceBasis, confirmationKey: requiredText(confirmationKey, 'confirmationKey', 200), reason: requiredText(reason, 'reason'),
  };
  if (currency !== 'RUB' || !['USER_CONFIRMATION', 'BANK_DOCUMENT_AND_USER_CONFIRMATION'].includes(evidenceBasis)) fail('INVALID_TOPUP_PROVENANCE');
  const scopeKey = await walletScope(pool, fields.walletId);
  return withScopeTransaction(pool, scopeKey, async (client) => {
    const scopeAndWallet = await validatedTopupInputs(client, { ...fields, scopeKey });
    fields.scopeId = Number(scopeAndWallet.scope.id);
    const occurredAt = new Date(scopeAndWallet.transaction.occurred_at).toISOString();
    fields.occurredAt = occurredAt;
    const existing = await existingTopup(client, fields);
    if (existing) return existing;
    if ((await client.query('SELECT 1 FROM bank_receipt_matches WHERE bank_transaction_id=$1 LIMIT 1', [fields.bankTransactionId])).rowCount) fail('BANK_TRANSACTION_ALREADY_MATCHED');
    if ((await client.query('SELECT 1 FROM ledger_source_links WHERE bank_transaction_id=$1 LIMIT 1', [fields.bankTransactionId])).rowCount) fail('BANK_TRANSACTION_ALREADY_LEDGER_LINKED');
    const movementIdForIdentity = fields.bankTransactionId;
    const event = await insertManualEvent(client, { scopeId: fields.scopeId, walletId: fields.walletId, movementId: movementIdForIdentity, movementType: 'TOPUP', amount: fields.amount, currency, occurredAt, reason: fields.reason });
    const ledger = await insertManualLedger(client, { scopeId: fields.scopeId, eventId: event.eventId, movementId: movementIdForIdentity, movementType: 'TOPUP', amount: fields.amount, currency, occurredAt, walletId: fields.walletId, financialAccountId: fields.financialAccountId, reason: fields.reason });
    const linkKey = fiscalContentFingerprint({ ledgerEntryId: ledger.ledgerEntryId, eventId: event.eventId, bankTransactionId: fields.bankTransactionId, role: ledger.linkRole });
    await addLedgerSourceLink(client, { ledgerEntryId: ledger.ledgerEntryId, eventId: event.eventId, bankTransactionId: fields.bankTransactionId, role: ledger.linkRole, semanticKey: linkKey });
    const movementKey = fiscalContentFingerprint({ scopeId: fields.scopeId, walletId: fields.walletId, bankTransactionId: fields.bankTransactionId, amount: fields.amount, currency, evidenceBasis, provenance: 'USER_CONFIRMED' });
    const inserted = await client.query(`INSERT INTO prepaid_wallet_movements(scope_id,wallet_id,movement_type,amount,currency,occurred_at,bank_transaction_id,source_provider,financial_account_id,payment_instrument_id,source_account_provenance,evidence_basis,confirmed_by_person_id,provenance,confirmation_key,reason,business_event_id,ledger_entry_id,semantic_key)
      VALUES($1,$2,'TOPUP',$3,$4,$5,$6,$7,$8,$9,'USER_CONFIRMED',$10,$11,'USER_CONFIRMED',$12,$13,$14,$15,$16) RETURNING id`, [fields.scopeId, fields.walletId, fields.amount, currency, occurredAt, fields.bankTransactionId, TROIKA_PROVIDER, fields.financialAccountId, fields.paymentInstrumentId, fields.evidenceBasis, fields.ownerPersonId, fields.confirmationKey, fields.reason, event.eventId, ledger.ledgerEntryId, movementKey]);
    if (inserted.rowCount !== 1) fail('TOPUP_INSERT_FAILED');
    return { movementId: Number(inserted.rows[0].id), businessEventId: event.eventId, ledgerEntryId: ledger.ledgerEntryId, created: true, replayed: false };
  }, fields.bankTransactionId);
}

export async function recordPrepaidWalletBalanceSnapshot(pool, {
  walletId, ownerPersonId, balance, currency = 'RUB', observedAt, confirmationKey, reason,
}) {
  enabled();
  const fields = { walletId: positiveId(walletId, 'walletId'), ownerPersonId: positiveId(ownerPersonId, 'ownerPersonId'), balance: canonicalMoney(balance, { allowZero: true }), currency, observedAt: canonicalTime(observedAt, 'observedAt'), confirmationKey: requiredText(confirmationKey, 'confirmationKey', 200), reason: requiredText(reason, 'reason') };
  const scopeKey = await walletScope(pool, fields.walletId);
  if (currency !== 'RUB') fail('WALLET_CURRENCY_UNSUPPORTED');
  return withScopeTransaction(pool, scopeKey, async (client) => {
    const wallet = (await client.query('SELECT scope_id,owner_person_id,currency FROM prepaid_wallets WHERE id=$1 FOR UPDATE', [fields.walletId])).rows[0];
    if (!wallet || Number(wallet.owner_person_id) !== fields.ownerPersonId || wallet.currency !== currency) fail('WALLET_OWNER_OR_SCOPE_CONFLICT');
    const existing = (await client.query(`SELECT id,scope_id,wallet_id,balance::text AS balance,currency,observed_at,confirmed_by_person_id,provenance,confirmation_key,reason
      FROM prepaid_wallet_balance_snapshots WHERE confirmation_key=$1 FOR UPDATE`, [fields.confirmationKey])).rows[0];
    if (existing) {
      if (!sameStored(existing, { scope_id: Number(wallet.scope_id), wallet_id: fields.walletId, balance: fields.balance, currency, confirmed_by_person_id: fields.ownerPersonId, provenance: 'USER_CONFIRMED', confirmation_key: fields.confirmationKey, reason: fields.reason })
        || new Date(existing.observed_at).toISOString() !== fields.observedAt) fail('BALANCE_SNAPSHOT_IDEMPOTENCY_CONFLICT');
      return { snapshotId: Number(existing.id), created: false, replayed: true };
    }
    const sameInstant = (await client.query(`SELECT id FROM prepaid_wallet_balance_snapshots
      WHERE scope_id=$1 AND wallet_id=$2 AND observed_at=$3 LIMIT 1 FOR UPDATE`, [wallet.scope_id, fields.walletId, fields.observedAt])).rows[0];
    if (sameInstant) fail('BALANCE_SNAPSHOT_CONFLICT');
    const inserted = await client.query(`INSERT INTO prepaid_wallet_balance_snapshots(scope_id,wallet_id,balance,currency,observed_at,confirmed_by_person_id,provenance,confirmation_key,reason)
      VALUES($1,$2,$3,$4,$5,$6,'USER_CONFIRMED',$7,$8) RETURNING id`, [wallet.scope_id, fields.walletId, fields.balance, currency, fields.observedAt, fields.ownerPersonId, fields.confirmationKey, fields.reason]);
    return { snapshotId: Number(inserted.rows[0].id), created: true, replayed: false };
  });
}

async function balanceAt(client, { scopeId, walletId, ownerPersonId, at }) {
  const snapshot = (await client.query(`SELECT id,balance::text AS balance,currency,observed_at
    FROM prepaid_wallet_balance_snapshots WHERE scope_id=$1 AND wallet_id=$2 AND observed_at < $3
    ORDER BY observed_at DESC,id DESC LIMIT 1`, [scopeId, walletId, at])).rows[0];
  if (!snapshot) return { status: 'BASELINE_REQUIRED', balance: null, snapshotId: null };
  if (snapshot.currency !== 'RUB') return { status: 'WALLET_CURRENCY_UNSUPPORTED', balance: null, snapshotId: Number(snapshot.id) };
  const movements = (await client.query(`SELECT movement_type AS "movementType",amount::text AS amount,occurred_at AS "occurredAt"
    FROM prepaid_wallet_movements WHERE scope_id=$1 AND wallet_id=$2 AND occurred_at <= $3 ORDER BY occurred_at,id`, [scopeId, walletId, at])).rows;
  const result = calculatePrepaidWalletBalance({ id: snapshot.id, balance: snapshot.balance, observedAt: snapshot.observed_at }, movements, at);
  if (result.status !== 'KNOWN' || !result.balance || cents(result.balance) < 0n) return result;
  return { ...result, ownerPersonId };
}

export async function getPrepaidWalletBalanceAt(pool, { walletId, at }) {
  const id = positiveId(walletId, 'walletId');
  const timestamp = canonicalTime(at, 'at');
  const scope = (await pool.query('SELECT scope_id,owner_person_id FROM prepaid_wallets WHERE id=$1', [id])).rows[0];
  if (!scope) fail('WALLET_NOT_FOUND');
  return balanceAt(pool, { scopeId: Number(scope.scope_id), walletId: id, ownerPersonId: Number(scope.owner_person_id), at: timestamp });
}

async function existingMovementByConfirmation(client, confirmationKey) {
  return (await client.query(`SELECT id,scope_id,wallet_id,movement_type,amount::text AS amount,currency,occurred_at,bank_transaction_id,
      confirmed_by_person_id,confirmation_key,reason,business_event_id,ledger_entry_id
    FROM prepaid_wallet_movements WHERE confirmation_key=$1 FOR UPDATE`, [confirmationKey])).rows[0] ?? null;
}

export async function confirmPrepaidWalletRide(pool, {
  walletId, receiptId, ownerPersonId, amount: requestedAmount, currency = 'RUB', occurredAt, confirmationKey, reason,
}) {
  enabled();
  const fields = { walletId: positiveId(walletId, 'walletId'), receiptId: positiveId(receiptId, 'receiptId'), ownerPersonId: positiveId(ownerPersonId, 'ownerPersonId'), amount: canonicalMoney(requestedAmount), currency, occurredAt: canonicalTime(occurredAt, 'occurredAt'), confirmationKey: requiredText(confirmationKey, 'confirmationKey', 200), reason: requiredText(reason, 'reason') };
  if (currency !== 'RUB') fail('WALLET_CURRENCY_UNSUPPORTED');
  const scopeKey = await walletScope(pool, fields.walletId);
  return withScopeTransaction(pool, scopeKey, async (client) => {
    const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
    const wallet = (await client.query('SELECT scope_id,owner_person_id,currency FROM prepaid_wallets WHERE id=$1 FOR UPDATE', [fields.walletId])).rows[0];
    if (!scope || !wallet || Number(wallet.scope_id) !== Number(scope.id) || Number(wallet.owner_person_id) !== fields.ownerPersonId || wallet.currency !== currency) fail('WALLET_OWNER_OR_SCOPE_CONFLICT');
    const existing = await existingMovementByConfirmation(client, fields.confirmationKey);
    if (existing) {
      if (!sameStored(existing, { scope_id: Number(scope.id), wallet_id: fields.walletId, movement_type: 'RIDE_REDEMPTION', amount: fields.amount, currency, confirmed_by_person_id: fields.ownerPersonId, confirmation_key: fields.confirmationKey, reason: fields.reason })
        || new Date(existing.occurred_at).toISOString() !== fields.occurredAt) fail('MOVEMENT_IDEMPOTENCY_CONFLICT');
      const evidenceRows = (await client.query('SELECT receipt_id FROM prepaid_wallet_receipt_evidence WHERE wallet_movement_id=$1', [existing.id])).rows;
      if (evidenceRows.length !== 1 || Number(evidenceRows[0].receipt_id) !== fields.receiptId) fail('RIDE_RECEIPT_IDEMPOTENCY_CONFLICT');
      const facts = await receiptEvidenceFacts(client, { receiptId: fields.receiptId, scopeId: Number(scope.id), movementType: 'RIDE_REDEMPTION', amount: fields.amount, currency });
      const evidence = await persistWalletReceiptEvidence(client, {
        scopeId: Number(scope.id), movementId: Number(existing.id), receiptId: fields.receiptId, ledgerEntryId: Number(existing.ledger_entry_id),
        paymentStage: facts.paymentStage, amount: fields.amount, currency, normalizedContentSha256: facts.normalizedContentSha256,
        confirmationKey: fields.confirmationKey, reason: fields.reason,
      });
      if (!evidence.replayed) fail('RIDE_RECEIPT_EVIDENCE_IDEMPOTENCY_CONFLICT');
      return { movementId: Number(existing.id), businessEventId: Number(existing.business_event_id), ledgerEntryId: Number(existing.ledger_entry_id), created: false, replayed: true, balance: null };
    }
    const balance = await balanceAt(client, { scopeId: Number(scope.id), walletId: fields.walletId, ownerPersonId: fields.ownerPersonId, at: fields.occurredAt });
    if (balance.status === 'BASELINE_REQUIRED') fail('WALLET_BALANCE_BASELINE_REQUIRED');
    if (balance.status !== 'KNOWN') fail(`WALLET_BALANCE_${balance.status}`);
    if (cents(balance.balance) < cents(fields.amount)) fail('WALLET_INSUFFICIENT_BALANCE');
    const receiptFacts = await receiptEvidenceFacts(client, { receiptId: fields.receiptId, scopeId: Number(scope.id), movementType: 'RIDE_REDEMPTION', amount: fields.amount, currency });
    await assertReceiptNotAccounted(client, { receiptId: fields.receiptId, scopeId: Number(scope.id) });
    const movementIdentity = fields.confirmationKey;
    const event = await insertManualEvent(client, { scopeId: Number(scope.id), walletId: fields.walletId, movementId: movementIdentity, movementType: 'RIDE_REDEMPTION', amount: fields.amount, currency, occurredAt: fields.occurredAt, reason: fields.reason });
    const ledger = await insertManualLedger(client, { scopeId: Number(scope.id), eventId: event.eventId, movementId: movementIdentity, movementType: 'RIDE_REDEMPTION', amount: fields.amount, currency, occurredAt: fields.occurredAt, walletId: fields.walletId, financialAccountId: null, reason: fields.reason });
    const inserted = await client.query(`INSERT INTO prepaid_wallet_movements(scope_id,wallet_id,movement_type,amount,currency,occurred_at,confirmed_by_person_id,provenance,confirmation_key,reason,business_event_id,ledger_entry_id,semantic_key)
      VALUES($1,$2,'RIDE_REDEMPTION',$3,$4,$5,$6,'USER_CONFIRMED',$7,$8,$9,$10,$11) RETURNING id`, [scope.id, fields.walletId, fields.amount, currency, fields.occurredAt, fields.ownerPersonId, fields.confirmationKey, fields.reason, event.eventId, ledger.ledgerEntryId, fiscalContentFingerprint({ scopeId: Number(scope.id), walletId: fields.walletId, confirmationKey: fields.confirmationKey, movementType: 'RIDE_REDEMPTION', amount: fields.amount, currency })]);
    const linkKey = fiscalContentFingerprint({ ledgerEntryId: ledger.ledgerEntryId, eventId: event.eventId, confirmationKey: fields.confirmationKey, role: ledger.linkRole });
    await addLedgerSourceLink(client, { ledgerEntryId: ledger.ledgerEntryId, eventId: event.eventId, role: ledger.linkRole, semanticKey: linkKey });
    const receiptEvidence = await persistWalletReceiptEvidence(client, {
      scopeId: Number(scope.id), movementId: Number(inserted.rows[0].id), receiptId: fields.receiptId, ledgerEntryId: ledger.ledgerEntryId,
      paymentStage: receiptFacts.paymentStage, amount: fields.amount, currency, normalizedContentSha256: receiptFacts.normalizedContentSha256,
      confirmationKey: fields.confirmationKey, reason: fields.reason,
    });
    if (!receiptEvidence.created) fail('RIDE_RECEIPT_EVIDENCE_IDEMPOTENCY_CONFLICT');
    return { movementId: Number(inserted.rows[0].id), businessEventId: event.eventId, ledgerEntryId: ledger.ledgerEntryId, created: true, replayed: false, balance: fromCents(cents(balance.balance) - cents(fields.amount)) };
  });
}

async function receiptScope(client, receiptId) {
  const scopes = (await client.query(`SELECT DISTINCT source.scope_id
    FROM receipt_source_observations observation JOIN fns_sources source ON source.id=observation.fns_source_id
    WHERE observation.receipt_id=$1 ORDER BY source.scope_id`, [receiptId])).rows;
  return scopes.length === 1 ? Number(scopes[0].scope_id) : null;
}

async function receiptEvidenceFacts(client, { receiptId, scopeId, movementType, amount, currency }) {
  const receipt = (await client.query(`SELECT receipt.total_sum::text AS amount,receipt.currency,
      facts.normalized_content_sha256,facts.normalization_status,facts.payment_components_status,facts.payment_stage
    FROM receipts receipt JOIN receipt_fiscal_facts facts ON facts.receipt_id=receipt.id AND facts.normalization_version=$2
    WHERE receipt.id=$1`, [receiptId, NORMALIZATION_VERSION])).rows[0];
  if (!receipt) fail('RECEIPT_NORMALIZATION_NOT_FOUND');
  if (await receiptScope(client, receiptId) !== Number(scopeId)) fail('RECEIPT_SCOPE_CONFLICT');
  const paymentStage = movementType === 'TOPUP' ? 'PREPAYMENT_ONLY' : 'SETTLEMENT_ONLY';
  if (receipt.normalization_status !== 'READY' || receipt.payment_components_status !== 'RECONCILED'
    || receipt.payment_stage !== paymentStage || String(receipt.amount) !== String(amount) || receipt.currency !== currency
    || !SHA256.test(String(receipt.normalized_content_sha256 ?? ''))) fail('RECEIPT_WALLET_EVIDENCE_CONFLICT');
  return { paymentStage, normalizedContentSha256: String(receipt.normalized_content_sha256).toLowerCase() };
}

async function assertReceiptNotAccounted(client, { receiptId, scopeId }) {
  if ((await client.query('SELECT 1 FROM bank_receipt_matches WHERE receipt_id=$1 LIMIT 1', [receiptId])).rowCount
    || (await client.query(`SELECT 1 FROM business_event_evidence evidence JOIN business_events event ON event.id=evidence.event_id
      WHERE evidence.receipt_id=$1 AND event.scope_id=$2 LIMIT 1`, [receiptId, scopeId])).rowCount
    || (await client.query(`SELECT 1 FROM ledger_source_links link JOIN ledger_entries entry ON entry.id=link.ledger_entry_id
      WHERE link.receipt_id=$1 AND entry.scope_id=$2 LIMIT 1`, [receiptId, scopeId])).rowCount) fail('RECEIPT_ALREADY_ACCOUNTED');
}

async function persistWalletReceiptEvidence(client, {
  scopeId, movementId, receiptId, ledgerEntryId, paymentStage, amount, currency, normalizedContentSha256, confirmationKey, reason,
}) {
  const existing = (await client.query(`SELECT id,scope_id,wallet_movement_id,receipt_id,normalization_version,payment_stage,amount::text AS amount,currency,
      normalized_content_sha256,provenance,confirmation_key,reason
    FROM prepaid_wallet_receipt_evidence WHERE receipt_id=$1 OR confirmation_key=$2 OR wallet_movement_id=$3 ORDER BY id FOR UPDATE`, [
    receiptId, confirmationKey, movementId,
  ])).rows;
  const expected = {
    scope_id: scopeId, wallet_movement_id: movementId, receipt_id: receiptId, normalization_version: NORMALIZATION_VERSION,
    payment_stage: paymentStage, amount, currency, normalized_content_sha256: normalizedContentSha256,
    provenance: 'USER_CONFIRMED', confirmation_key: confirmationKey, reason,
  };
  if (existing.length) {
    if (existing.length !== 1 || !sameStored(existing[0], expected)) fail('RECEIPT_EVIDENCE_IDEMPOTENCY_CONFLICT');
    const link = (await client.query('SELECT source_event_id FROM ledger_entries WHERE id=$1', [ledgerEntryId])).rows[0];
    if (!link) fail('WALLET_LEDGER_ENTRY_NOT_FOUND');
    const linkKey = fiscalContentFingerprint({ ledgerEntryId, movementId, receiptId, role: 'PREPAID_WALLET_RECEIPT_EVIDENCE' });
    await addLedgerSourceLink(client, { ledgerEntryId, eventId: Number(link.source_event_id), receiptId, role: 'PREPAID_WALLET_RECEIPT_EVIDENCE', semanticKey: linkKey });
    return { evidenceId: Number(existing[0].id), created: false, replayed: true };
  }
  await assertReceiptNotAccounted(client, { receiptId, scopeId });
  const semanticKey = fiscalContentFingerprint({ scopeId, movementId, receiptId, normalizationVersion: NORMALIZATION_VERSION, paymentStage, amount, currency, normalizedContentSha256 });
  const inserted = await client.query(`INSERT INTO prepaid_wallet_receipt_evidence(scope_id,wallet_movement_id,receipt_id,normalization_version,payment_stage,amount,currency,normalized_content_sha256,provenance,confirmation_key,reason,semantic_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'USER_CONFIRMED',$9,$10,$11) RETURNING id`, [scopeId, movementId, receiptId, NORMALIZATION_VERSION, paymentStage, amount, currency, normalizedContentSha256, confirmationKey, reason, semanticKey]);
  const link = (await client.query('SELECT source_event_id FROM ledger_entries WHERE id=$1', [ledgerEntryId])).rows[0];
  if (!link) fail('WALLET_LEDGER_ENTRY_NOT_FOUND');
  const linkKey = fiscalContentFingerprint({ ledgerEntryId, movementId, receiptId, role: 'PREPAID_WALLET_RECEIPT_EVIDENCE' });
  await addLedgerSourceLink(client, { ledgerEntryId, eventId: Number(link.source_event_id), receiptId, role: 'PREPAID_WALLET_RECEIPT_EVIDENCE', semanticKey: linkKey });
  return { evidenceId: Number(inserted.rows[0].id), created: true, replayed: false };
}

export async function linkPrepaidWalletReceiptEvidence(pool, {
  walletMovementId, receiptId, ownerPersonId, confirmationKey, reason,
}) {
  enabled();
  const movementId = positiveId(walletMovementId, 'walletMovementId');
  const receipt = positiveId(receiptId, 'receiptId');
  const ownerId = positiveId(ownerPersonId, 'ownerPersonId');
  const key = requiredText(confirmationKey, 'confirmationKey', 200);
  const note = requiredText(reason, 'reason');
  const lookup = (await pool.query(`SELECT wallet.scope_id,scope.scope_key,movement.bank_transaction_id
    FROM prepaid_wallet_movements movement JOIN prepaid_wallets wallet ON wallet.id=movement.wallet_id
    JOIN accounting_scopes scope ON scope.id=wallet.scope_id WHERE movement.id=$1`, [movementId])).rows[0];
  if (!lookup) fail('WALLET_MOVEMENT_NOT_FOUND');
  return withScopeTransaction(pool, lookup.scope_key, async (client) => {
    const movement = (await client.query(`SELECT movement.id,movement.scope_id,movement.wallet_id,movement.movement_type,movement.amount::text AS amount,movement.currency,
        movement.confirmed_by_person_id,movement.ledger_entry_id,wallet.owner_person_id
      FROM prepaid_wallet_movements movement JOIN prepaid_wallets wallet ON wallet.id=movement.wallet_id
      WHERE movement.id=$1 FOR UPDATE OF movement`, [movementId])).rows[0];
    if (!movement || Number(movement.scope_id) !== Number(lookup.scope_id) || Number(movement.owner_person_id) !== ownerId
      || Number(movement.confirmed_by_person_id) !== ownerId) fail('WALLET_OWNER_OR_SCOPE_CONFLICT');
    const facts = await receiptEvidenceFacts(client, { receiptId: receipt, scopeId: Number(movement.scope_id), movementType: movement.movement_type, amount: String(movement.amount), currency: movement.currency });
    const result = await persistWalletReceiptEvidence(client, {
      scopeId: Number(movement.scope_id), movementId, receiptId: receipt, ledgerEntryId: Number(movement.ledger_entry_id),
      paymentStage: facts.paymentStage, amount: String(movement.amount), currency: movement.currency,
      normalizedContentSha256: facts.normalizedContentSha256, confirmationKey: key, reason: note,
    });
    return { ...result, movementId, receiptId: receipt, paymentStage: facts.paymentStage };
  }, lookup.bank_transaction_id === null ? null : Number(lookup.bank_transaction_id));
}

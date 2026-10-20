import { fiscalContentFingerprint } from './fiscal-evidence.js';
import { businessEventEvidenceSemanticKey, GRAPH_MODEL_VERSION, MANUAL } from './business-event-graph.js';
import { refreshCertificationForEvents } from './certification.js';
import { lockMatchedPurchaseBankTransaction, lockMatchedPurchaseScope, lockMatchedPurchaseScopeTransaction } from './matched-purchase-locks.js';
import { resolveFnsReceiptCurrency } from './fns-receipt-currency.js';

export const MANUAL_TROIKA_TOPUP_RULE = 'MANUAL_TROIKA_TOPUP_EXPENSE_V1';
export const MANUAL_TROIKA_TOPUP_VERSION = 'v1';
export const ALFA_PROVIDER = 'ru.alfabank.mobile.android';
export const ALFA_DEBIT_CARD_REFERENCE = '****5580';
export const TROIKA_EXPENSE_CATEGORY = 'PUBLIC_TRANSPORT';
const NORMALIZED_FACT_VERSION = 'fiscal-normalizer-v1';
const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const ID = /^[1-9]\d*$/;
const RECEIPT_WINDOW_MS = 5 * 60 * 1000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function positiveId(value, name) {
  if (!(Number.isSafeInteger(Number(value)) && Number(value) > 0)) fail(`${name}_INVALID`);
  return Number(value);
}

function canonicalMoney(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : String(value ?? '');
  if (!MONEY.test(text) || text === '0.00') fail('AMOUNT_INVALID');
  return text;
}

function requiredText(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${name}_INVALID`);
  return value.trim();
}

function stable(value) { return fiscalContentFingerprint(value); }
function sameTimestamp(left, right) { return new Date(left).toISOString() === new Date(right).toISOString(); }

async function transactionContext(client, bankTransactionId) {
  const rows = (await client.query(`SELECT bt.id,bt.observation_id,bt.occurred_at,bt.amount::text AS amount,bt.currency,
      bt.direction,bt.event_type,bt.normalization_status,
      eo.event_time,eo.bank_source_id,eo.ingestion_metadata->>'provider' AS provider
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id=bt.observation_id
    WHERE bt.id=$1`, [bankTransactionId])).rows;
  if (rows.length !== 1) fail('BANK_TRANSACTION_NOT_FOUND');
  const tx = rows[0];
  if (tx.provider !== ALFA_PROVIDER) fail('BANK_PROVIDER_MISMATCH');
  if (tx.normalization_status === 'REJECTED') fail('BANK_TRANSACTION_REJECTED');
  if (!['UNKNOWN', 'PURCHASE'].includes(tx.event_type) || !['UNKNOWN', 'DEBIT'].includes(tx.direction)) fail('BANK_TRANSACTION_CONFLICTING_NORMALIZATION');
  if (tx.currency && tx.currency !== 'RUB') fail('BANK_CURRENCY_CONFLICT');
  const occurredAt = tx.occurred_at ?? tx.event_time;
  if (!occurredAt) fail('BANK_EVENT_TIME_MISSING');
  if (tx.occurred_at && tx.event_time
    && Math.abs(new Date(tx.occurred_at).getTime() - new Date(tx.event_time).getTime()) > RECEIPT_WINDOW_MS) fail('BANK_EVENT_TIME_CONFLICT');
  return { ...tx, occurredAt: new Date(occurredAt).toISOString() };
}

async function assertSourceOwner(client, bankSourceId, personId, scopeId) {
  const owners = (await client.query(`SELECT p.id,p.scope_id
    FROM bank_source_person sp JOIN persons p ON p.id=sp.person_id
    WHERE sp.bank_source_id=$1 AND sp.relation_type='OWNER' ORDER BY p.id`, [bankSourceId])).rows;
  if (owners.length !== 1 || Number(owners[0].id) !== personId || Number(owners[0].scope_id) !== scopeId) fail('BANK_SOURCE_OWNER_CONFLICT');
}

async function assertCardAndAccount(client, { scopeId, personId, financialAccountId, paymentInstrumentId }) {
  const accounts = (await client.query(`SELECT id,scope_id,provider,currency,active
    FROM financial_accounts WHERE id=$1`, [financialAccountId])).rows;
  const instruments = (await client.query(`SELECT id,scope_id,financial_account_id,provider,instrument_type,active
    FROM payment_instruments WHERE id=$1`, [paymentInstrumentId])).rows;
  if (accounts.length !== 1 || instruments.length !== 1) fail('ACCOUNT_OR_INSTRUMENT_NOT_FOUND');
  const account = accounts[0]; const instrument = instruments[0];
  if (Number(account.scope_id) !== scopeId || !account.active || account.provider !== ALFA_PROVIDER || account.currency !== 'RUB') fail('FINANCIAL_ACCOUNT_CONFLICT');
  if (Number(instrument.scope_id) !== scopeId || Number(instrument.financial_account_id) !== financialAccountId
    || !instrument.active || instrument.instrument_type !== 'CARD' || instrument.provider !== ALFA_PROVIDER) fail('PAYMENT_INSTRUMENT_CONFLICT');
  const references = (await client.query(`SELECT r.id,r.payment_instrument_id,i.scope_id
    FROM bank_account_references r
    JOIN payment_instruments i ON i.id=r.payment_instrument_id
    WHERE r.provider=$1 AND r.reference_kind='MASKED_CARD' AND r.reference_value=$2
    ORDER BY r.id`, [ALFA_PROVIDER, ALFA_DEBIT_CARD_REFERENCE])).rows;
  if (references.length !== 1 || Number(references[0].payment_instrument_id) !== paymentInstrumentId
    || Number(references[0].scope_id) !== scopeId) fail('CARD_REFERENCE_NOT_UNIQUE');
  const accountOwners = (await client.query(`SELECT person_id FROM financial_account_person_relations
    WHERE financial_account_id=$1 AND relation_type='OWNER'`, [financialAccountId])).rows;
  const instrumentOwners = (await client.query(`SELECT person_id FROM payment_instrument_person_relations
    WHERE payment_instrument_id=$1 AND relation_type='OWNER'`, [paymentInstrumentId])).rows;
  if (accountOwners.length !== 1 || Number(accountOwners[0].person_id) !== personId
    || instrumentOwners.length !== 1 || Number(instrumentOwners[0].person_id) !== personId) fail('ACCOUNT_OWNER_CONFLICT');
  return { account, instrument, referenceId: Number(references[0].id) };
}

async function assertNoConflictingResolution(client, bankTransactionId, financialAccountId, paymentInstrumentId) {
  const account = (await client.query(`SELECT financial_account_id,resolution_state FROM bank_transaction_account_resolution
    WHERE bank_transaction_id=$1`, [bankTransactionId])).rows[0];
  if (account?.financial_account_id != null && Number(account.financial_account_id) !== financialAccountId) fail('ACCOUNT_RESOLUTION_CONFLICT');
  const instrument = (await client.query(`SELECT payment_instrument_id,resolution_state FROM bank_transaction_payment_instrument_resolution
    WHERE bank_transaction_id=$1`, [bankTransactionId])).rows[0];
  if (instrument?.payment_instrument_id != null && Number(instrument.payment_instrument_id) !== paymentInstrumentId) fail('INSTRUMENT_RESOLUTION_CONFLICT');
}

async function assertTransactionNotPreviouslyAccounted(client, bankTransactionId) {
  if ((await client.query('SELECT 1 FROM bank_receipt_matches WHERE bank_transaction_id=$1', [bankTransactionId])).rowCount) fail('BANK_TRANSACTION_ALREADY_MATCHED');
  if ((await client.query('SELECT 1 FROM ledger_source_links WHERE bank_transaction_id=$1', [bankTransactionId])).rowCount) fail('BANK_TRANSACTION_ALREADY_ACCOUNTED');
}

async function ensureAssetAccount(client, scopeId, financialAccountId) {
  const code = `FINANCIAL_ACCOUNT:${financialAccountId}`;
  const rows = (await client.query(`SELECT id,scope_id,account_code,account_type,financial_account_id,account_currency
    FROM ledger_accounts WHERE scope_id=$1 AND (financial_account_id=$2 OR account_code=$3)`, [scopeId, financialAccountId, code])).rows;
  if (rows.length > 1) fail('LEDGER_ACCOUNT_MAPPING_CONFLICT');
  let row = rows[0];
  if (!row) {
    row = (await client.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency)
      VALUES($1,$2,'ASSET','Mapped financial account',$3,'RUB')
      ON CONFLICT DO NOTHING RETURNING id,scope_id,account_code,account_type,financial_account_id,account_currency`, [scopeId, code, financialAccountId])).rows[0];
    if (!row) row = (await client.query(`SELECT id,scope_id,account_code,account_type,financial_account_id,account_currency
      FROM ledger_accounts WHERE scope_id=$1 AND (financial_account_id=$2 OR account_code=$3)`, [scopeId, financialAccountId, code])).rows[0];
  }
  if (!row) fail('LEDGER_ACCOUNT_MAPPING_CONFLICT');
  if (Number(row.scope_id) !== scopeId || row.account_code !== code || row.account_type !== 'ASSET'
    || Number(row.financial_account_id) !== financialAccountId || row.account_currency !== 'RUB') fail('LEDGER_ACCOUNT_MAPPING_CONFLICT');
  return Number(row.id);
}

async function ensureTransportExpenseAccount(client, scopeId) {
  const code = `EXPENSE:${TROIKA_EXPENSE_CATEGORY}`;
  let row = (await client.query(`SELECT id,scope_id,account_code,account_type,financial_account_id,account_currency
    FROM ledger_accounts WHERE scope_id=$1 AND account_code=$2`, [scopeId, code])).rows[0];
  if (!row) {
    row = (await client.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description)
      VALUES($1,$2,'EXPENSE','Household transport expense')
      ON CONFLICT DO NOTHING RETURNING id,scope_id,account_code,account_type,financial_account_id,account_currency`, [scopeId, code])).rows[0];
    if (!row) row = (await client.query(`SELECT id,scope_id,account_code,account_type,financial_account_id,account_currency
      FROM ledger_accounts WHERE scope_id=$1 AND account_code=$2`, [scopeId, code])).rows[0];
  }
  if (!row) fail('LEDGER_EXPENSE_ACCOUNT_CONFLICT');
  if (Number(row.scope_id) !== scopeId || row.account_code !== code || row.account_type !== 'EXPENSE'
    || row.financial_account_id !== null || row.account_currency !== null) fail('LEDGER_EXPENSE_ACCOUNT_CONFLICT');
  return Number(row.id);
}

function sameConfirmation(row, expected) {
  return Number(row.scope_id) === expected.scopeId
    && Number(row.bank_source_id) === expected.bankSourceId
    && Number(row.financial_account_id) === expected.financialAccountId
    && Number(row.payment_instrument_id) === expected.paymentInstrumentId
    && Number(row.person_id) === expected.personId
    && String(row.amount) === expected.amount && row.currency === 'RUB'
    && sameTimestamp(row.occurred_at, expected.occurredAt)
    && row.provenance === 'USER_CONFIRMED' && row.evidence_basis === expected.evidenceBasis
    && row.reason === expected.reason;
}

async function validateExistingExpense(client, row, expected, bankTransactionId) {
  const event = (await client.query(`SELECT id,scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,amount,currency
    FROM business_events WHERE id=$1`, [row.business_event_id])).rows[0];
  const entry = (await client.query(`SELECT id,scope_id,source_event_id,currency,event_at,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code
    FROM ledger_entries WHERE id=$1`, [row.ledger_entry_id])).rows[0];
  const postings = (await client.query(`SELECT p.currency,p.debit::text,p.credit::text,a.account_code,a.account_type,a.financial_account_id
    FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.ledger_entry_id=$1 ORDER BY a.account_code`, [row.ledger_entry_id])).rows;
  const links = (await client.query(`SELECT business_event_id,bank_transaction_id,link_role
    FROM ledger_source_links WHERE bank_transaction_id=$1`, [bankTransactionId])).rows;
  const activeEntries = (await client.query(`SELECT count(*)::int AS count FROM ledger_entries e
    WHERE e.scope_id=$1 AND e.source_event_id=$2
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)`, [expected.scopeId, row.business_event_id])).rows[0].count;
  const matchCount = (await client.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE bank_transaction_id=$1', [bankTransactionId])).rows[0].count;
  const expectedPostings = [
    { currency: 'RUB', debit: expected.amount, credit: '0.00', account_code: `EXPENSE:${TROIKA_EXPENSE_CATEGORY}`, account_type: 'EXPENSE', financial_account_id: null },
    { currency: 'RUB', debit: '0.00', credit: expected.amount, account_code: `FINANCIAL_ACCOUNT:${expected.financialAccountId}`, account_type: 'ASSET', financial_account_id: expected.financialAccountId },
  ];
  const canonicalPostings = (values) => values.map((value) => ({
    currency: value.currency,
    debit: String(value.debit),
    credit: String(value.credit),
    account_code: value.account_code,
    account_type: value.account_type,
    financial_account_id: value.financial_account_id == null ? null : Number(value.financial_account_id),
  })).sort((left, right) => left.account_code.localeCompare(right.account_code));
  const expectedEvent = event && Number(event.scope_id) === expected.scopeId
    && event.event_type === 'PURCHASE' && event.resolution_status === 'CONFIRMED'
    && event.origin === 'MANUAL' && event.graph_model_version === GRAPH_MODEL_VERSION
    && event.rule_code === MANUAL_TROIKA_TOPUP_RULE && event.rule_version === MANUAL_TROIKA_TOPUP_VERSION
    && String(event.amount) === expected.amount && event.currency === 'RUB';
  const expectedEntry = entry && Number(entry.scope_id) === expected.scopeId
    && Number(entry.source_event_id) === Number(row.business_event_id)
    && entry.currency === 'RUB' && sameTimestamp(entry.event_at, expected.occurredAt)
    && entry.derivation_rule === MANUAL_TROIKA_TOPUP_RULE && entry.derivation_version === MANUAL_TROIKA_TOPUP_VERSION
    && entry.derivation_status === 'READY' && entry.certification_status === 'BUSINESS_CONFIRMED'
    && entry.origin === 'MANUAL' && entry.reason_code === 'USER_CONFIRMED_TROIKA_TOPUP';
  if (!expectedEvent || !expectedEntry || Number(activeEntries) !== 1 || Number(matchCount) !== 0
    || links.length !== 1 || Number(links[0].business_event_id) !== Number(row.business_event_id)
    || Number(links[0].bank_transaction_id) !== bankTransactionId || links[0].link_role !== 'MANUAL_TROIKA_TOPUP_BANK'
    || JSON.stringify(canonicalPostings(postings)) !== JSON.stringify(canonicalPostings(expectedPostings))) {
    fail('MANUAL_TOPUP_LEDGER_CONFLICT');
  }
}

export async function confirmTroikaTopupExpense(pool, options = {}) {
  const bankTransactionId = positiveId(options.bankTransactionId, 'BANK_TRANSACTION_ID');
  const financialAccountId = positiveId(options.financialAccountId, 'FINANCIAL_ACCOUNT_ID');
  const paymentInstrumentId = positiveId(options.paymentInstrumentId, 'PAYMENT_INSTRUMENT_ID');
  const personId = positiveId(options.personId, 'PERSON_ID');
  const scopeKey = requiredText(options.scopeKey ?? 'default', 'SCOPE_KEY', 128);
  const amount = canonicalMoney(options.amount);
  const evidenceBasis = options.evidenceBasis;
  if (!['USER_CONFIRMATION', 'BANK_DOCUMENT_AND_USER_CONFIRMATION'].includes(evidenceBasis)) fail('EVIDENCE_BASIS_INVALID');
  const reason = requiredText(options.reason, 'REASON');
  const client = await pool.connect();
  let releaseScopeLock = null;
  try {
    releaseScopeLock = await lockMatchedPurchaseScope(client, scopeKey);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await lockMatchedPurchaseScopeTransaction(client, scopeKey);
    await lockMatchedPurchaseBankTransaction(client, bankTransactionId);
    const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
    if (!scope) fail('ACCOUNTING_SCOPE_NOT_FOUND');
    const scopeId = Number(scope.id);
    const source = await transactionContext(client, bankTransactionId);
    const expected = { scopeId, bankSourceId: Number(source.bank_source_id), financialAccountId, paymentInstrumentId, personId, amount, occurredAt: source.occurredAt, evidenceBasis, reason };
    if (source.amount !== null && String(source.amount) !== amount) fail('BANK_AMOUNT_CONFLICT');
    await assertSourceOwner(client, source.bank_source_id, personId, scopeId);
    await assertCardAndAccount(client, { scopeId, personId, financialAccountId, paymentInstrumentId });
    await assertNoConflictingResolution(client, bankTransactionId, financialAccountId, paymentInstrumentId);
    const existing = (await client.query(`SELECT id,scope_id,bank_source_id,bank_transaction_id,business_event_id,ledger_entry_id,
        financial_account_id,payment_instrument_id,person_id,amount::text AS amount,currency,occurred_at,provenance,evidence_basis,reason
      FROM manual_troika_topup_expenses
      WHERE bank_transaction_id=$1`, [bankTransactionId])).rows[0];
    if (existing) {
      if (!sameConfirmation(existing, expected)) fail('MANUAL_TOPUP_CONFIRMATION_CONFLICT');
      if (Number(existing.bank_source_id) !== expected.bankSourceId || Number(existing.bank_transaction_id) !== bankTransactionId) fail('MANUAL_TOPUP_CONFIRMATION_CONFLICT');
      await validateExistingExpense(client, existing, expected, bankTransactionId);
      await client.query('COMMIT');
      return { created: false, reused: true, confirmationId: Number(existing.id), businessEventId: Number(existing.business_event_id), ledgerEntryId: Number(existing.ledger_entry_id), bankTransactionId };
    }
    await assertTransactionNotPreviouslyAccounted(client, bankTransactionId);

    const eventKey = stable({ model: MANUAL_TROIKA_TOPUP_RULE, version: MANUAL_TROIKA_TOPUP_VERSION, scopeKey, bankTransactionId });
    const ledgerKey = stable({ model: MANUAL_TROIKA_TOPUP_RULE, version: MANUAL_TROIKA_TOPUP_VERSION, bankTransactionId, financialAccountId, amount, currency: 'RUB', occurredAt: source.occurredAt, category: TROIKA_EXPENSE_CATEGORY });
    const description = 'User-confirmed Troika top-up recorded as transport expense';
    await client.query(`INSERT INTO business_graph_rules(rule_code,rule_version,description)
      VALUES($1,$2,$3) ON CONFLICT(rule_code,rule_version) DO NOTHING`, [MANUAL_TROIKA_TOPUP_RULE, MANUAL_TROIKA_TOPUP_VERSION, description]);
    const event = (await client.query(`INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
      VALUES($1,'PURCHASE','CONFIRMED','MANUAL',$2,$3,$4,$5,$6,'RUB',$7)
      ON CONFLICT(scope_id,semantic_key,graph_model_version,rule_code,rule_version,origin) DO NOTHING
      RETURNING id`, [scopeId, GRAPH_MODEL_VERSION, MANUAL_TROIKA_TOPUP_RULE, MANUAL_TROIKA_TOPUP_VERSION, eventKey, amount, description])).rows[0];
    if (!event) fail('MANUAL_TOPUP_EVENT_CONFLICT');
    const eventId = Number(event.id);
    const bankAssetAccountId = await ensureAssetAccount(client, scopeId, financialAccountId);
    const transportExpenseAccountId = await ensureTransportExpenseAccount(client, scopeId);
    const ledgerEntry = (await client.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description)
      VALUES($1,$2,'RUB',$3,$4,$5,$6,'READY','BUSINESS_CONFIRMED','MANUAL','USER_CONFIRMED_TROIKA_TOPUP',$7)
      RETURNING id`, [scopeId, eventId, source.occurredAt, ledgerKey, MANUAL_TROIKA_TOPUP_RULE, MANUAL_TROIKA_TOPUP_VERSION, description])).rows[0];
    const ledgerEntryId = Number(ledgerEntry.id);
    const postings = await client.query(`INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit)
      VALUES($1,$2,'RUB',$3,0),($1,$4,'RUB',0,$3) RETURNING id`, [ledgerEntryId, transportExpenseAccountId, amount, bankAssetAccountId]);
    if (postings.rowCount !== 2) fail('MANUAL_TOPUP_POSTINGS_INCOMPLETE');
    const semanticKey = stable({ model: MANUAL_TROIKA_TOPUP_RULE, version: MANUAL_TROIKA_TOPUP_VERSION, bankTransactionId, eventId, ledgerEntryId, financialAccountId, paymentInstrumentId, personId, amount, occurredAt: source.occurredAt, evidenceBasis, reason });
    const confirmation = (await client.query(`INSERT INTO manual_troika_topup_expenses(scope_id,bank_source_id,bank_transaction_id,business_event_id,ledger_entry_id,financial_account_id,payment_instrument_id,person_id,provider,category_code,amount,currency,occurred_at,provenance,evidence_basis,reason,semantic_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'RUB',$12,'USER_CONFIRMED',$13,$14,$15) RETURNING id`, [scopeId, source.bank_source_id, bankTransactionId, eventId, ledgerEntryId, financialAccountId, paymentInstrumentId, personId, ALFA_PROVIDER, TROIKA_EXPENSE_CATEGORY, amount, source.occurredAt, evidenceBasis, reason, semanticKey])).rows[0];
    const bankLinkKey = stable({ model: MANUAL_TROIKA_TOPUP_RULE, version: MANUAL_TROIKA_TOPUP_VERSION, ledgerEntryId, eventId, bankTransactionId, role: 'MANUAL_TROIKA_TOPUP_BANK' });
    await client.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,link_role,semantic_key,bank_transaction_id)
      VALUES($1,$2,'MANUAL_TROIKA_TOPUP_BANK',$3,$4)`, [ledgerEntryId, eventId, bankLinkKey, bankTransactionId]);
    await refreshCertificationForEvents(client, { scopeKey, eventIds: [eventId], client });
    await client.query('COMMIT');
    return { created: true, reused: false, confirmationId: Number(confirmation.id), businessEventId: eventId, ledgerEntryId, bankTransactionId };
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

export async function attachTroikaTopupReceipt(pool, options = {}) {
  const bankTransactionId = positiveId(options.bankTransactionId, 'BANK_TRANSACTION_ID');
  const receiptId = positiveId(options.receiptId, 'RECEIPT_ID');
  const reason = requiredText(options.reason, 'REASON');
  const scopeKey = requiredText(options.scopeKey ?? 'default', 'SCOPE_KEY', 128);
  const client = await pool.connect();
  let releaseScopeLock = null;
  try {
    releaseScopeLock = await lockMatchedPurchaseScope(client, scopeKey);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await lockMatchedPurchaseScopeTransaction(client, scopeKey);
    await lockMatchedPurchaseBankTransaction(client, bankTransactionId);
    const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
    if (!scope) fail('ACCOUNTING_SCOPE_NOT_FOUND');
    const confirmation = (await client.query(`SELECT id,scope_id,business_event_id,ledger_entry_id,amount::text,currency,occurred_at
      FROM manual_troika_topup_expenses WHERE bank_transaction_id=$1`, [bankTransactionId])).rows[0];
    if (!confirmation || Number(confirmation.scope_id) !== Number(scope.id)) fail('MANUAL_TOPUP_CONFIRMATION_NOT_FOUND');
    const existing = (await client.query(`SELECT id,scope_id,manual_troika_topup_expense_id,receipt_id,business_event_evidence_id,provenance,reason,semantic_key
      FROM manual_troika_topup_receipt_links WHERE manual_troika_topup_expense_id=$1`, [confirmation.id])).rows[0];
    if (existing) {
      if (Number(existing.receipt_id) !== receiptId || existing.reason !== reason) fail('MANUAL_TOPUP_RECEIPT_CONFLICT');
      const evidenceExists = (await client.query(`SELECT 1 FROM business_event_evidence
        WHERE id=$1 AND event_id=$2 AND receipt_id=$3 AND evidence_role='MANUAL_TROIKA_TOPUP_RECEIPT'
          AND origin='MANUAL' AND rule_code=$4 AND rule_version=$5`, [existing.business_event_evidence_id, confirmation.business_event_id, receiptId, MANUAL_TROIKA_TOPUP_RULE, MANUAL_TROIKA_TOPUP_VERSION])).rowCount;
      const linkExists = (await client.query(`SELECT 1 FROM ledger_source_links
        WHERE ledger_entry_id=$1 AND business_event_id=$2 AND graph_evidence_id=$3 AND receipt_id=$4
          AND link_role='MANUAL_TROIKA_TOPUP_RECEIPT'`, [confirmation.ledger_entry_id, confirmation.business_event_id, existing.business_event_evidence_id, receiptId])).rowCount;
      if (Number(existing.scope_id) !== Number(scope.id) || Number(existing.manual_troika_topup_expense_id) !== Number(confirmation.id)
        || existing.provenance !== 'USER_CONFIRMED' || !evidenceExists || !linkExists) fail('MANUAL_TOPUP_RECEIPT_CONFLICT');
      await client.query('COMMIT');
      return { created: false, reused: true, confirmationId: Number(confirmation.id), receiptId, businessEventId: Number(confirmation.business_event_id), ledgerEntryId: Number(confirmation.ledger_entry_id) };
    }
    const receipt = (await client.query(`SELECT r.id,r.date_time,r.operation_type,r.total_sum::text AS total_sum,r.currency,
        f.normalization_version,f.normalization_status,f.fiscal_operation_type,f.payment_stage,
        EXISTS(SELECT 1 FROM receipt_source_observations rso WHERE rso.receipt_id=r.id) AS fns_source_proven,
        ARRAY(SELECT DISTINCT fs.scope_id FROM receipt_source_observations rso
          JOIN fns_sources fs ON fs.id=rso.fns_source_id WHERE rso.receipt_id=r.id ORDER BY fs.scope_id) AS scope_ids
      FROM receipts r JOIN receipt_fiscal_facts f ON f.receipt_id=r.id AND f.normalization_version=$2
      WHERE r.id=$1`, [receiptId, NORMALIZED_FACT_VERSION])).rows[0];
    if (!receipt) fail('RECEIPT_NOT_FOUND_OR_NOT_NORMALIZED');
    const currency = resolveFnsReceiptCurrency({ explicitCurrency: receipt.currency, fnsSourceProven: receipt.fns_source_proven === true });
    if (Number(receipt.operation_type) !== 1 || Number(receipt.fiscal_operation_type) !== 1
      || receipt.normalization_status !== 'READY' || receipt.payment_stage !== 'PREPAYMENT_ONLY'
      || String(receipt.total_sum) !== String(confirmation.amount) || currency.status !== 'RESOLVED' || currency.currency !== 'RUB'
      || receipt.scope_ids.length !== 1 || Number(receipt.scope_ids[0]) !== Number(scope.id)
      || !receipt.date_time || Math.abs(new Date(receipt.date_time).getTime() - new Date(confirmation.occurred_at).getTime()) > RECEIPT_WINDOW_MS) fail('RECEIPT_NOT_EXACT_CONFIRMED_PREPAYMENT');
    if ((await client.query(`SELECT 1 FROM bank_receipt_matches WHERE receipt_id=$1
      UNION ALL SELECT 1 FROM business_event_evidence WHERE receipt_id=$1
      UNION ALL SELECT 1 FROM ledger_source_links WHERE receipt_id=$1 LIMIT 1`, [receiptId])).rowCount) fail('RECEIPT_ALREADY_ACCOUNTED');
    const evidenceKey = businessEventEvidenceSemanticKey({ scopeKey, eventId: Number(confirmation.business_event_id), receiptId, normalizationVersion: receipt.normalization_version, evidenceRole: 'MANUAL_TROIKA_TOPUP_RECEIPT', origin: MANUAL, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: MANUAL_TROIKA_TOPUP_RULE, ruleVersion: MANUAL_TROIKA_TOPUP_VERSION });
    const evidence = (await client.query(`INSERT INTO business_event_evidence(event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key)
      VALUES($1,$2,$3,'MANUAL_TROIKA_TOPUP_RECEIPT','MANUAL',$4,$5,$6,$7) RETURNING id`, [confirmation.business_event_id, receiptId, receipt.normalization_version, GRAPH_MODEL_VERSION, MANUAL_TROIKA_TOPUP_RULE, MANUAL_TROIKA_TOPUP_VERSION, evidenceKey])).rows[0];
    const linkKey = stable({ model: MANUAL_TROIKA_TOPUP_RULE, version: MANUAL_TROIKA_TOPUP_VERSION, ledgerEntryId: Number(confirmation.ledger_entry_id), eventId: Number(confirmation.business_event_id), receiptId, evidenceId: Number(evidence.id), role: 'MANUAL_TROIKA_TOPUP_RECEIPT' });
    await client.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,receipt_id,normalization_version,link_role,semantic_key)
      VALUES($1,$2,$3,$4,$5,'MANUAL_TROIKA_TOPUP_RECEIPT',$6)`, [confirmation.ledger_entry_id, confirmation.business_event_id, evidence.id, receiptId, receipt.normalization_version, linkKey]);
    const receiptLinkKey = stable({ model: MANUAL_TROIKA_TOPUP_RULE, version: MANUAL_TROIKA_TOPUP_VERSION, confirmationId: Number(confirmation.id), receiptId, evidenceId: Number(evidence.id), provenance: 'USER_CONFIRMED', reason });
    await client.query(`INSERT INTO manual_troika_topup_receipt_links(scope_id,manual_troika_topup_expense_id,receipt_id,business_event_evidence_id,provenance,reason,semantic_key)
      VALUES($1,$2,$3,$4,'USER_CONFIRMED',$5,$6)`, [scope.id, confirmation.id, receiptId, evidence.id, reason, receiptLinkKey]);
    await refreshCertificationForEvents(client, { scopeKey, eventIds: [Number(confirmation.business_event_id)], client });
    await client.query('COMMIT');
    return { created: true, reused: false, confirmationId: Number(confirmation.id), receiptId, businessEventId: Number(confirmation.business_event_id), ledgerEntryId: Number(confirmation.ledger_entry_id) };
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

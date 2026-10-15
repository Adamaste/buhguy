import crypto from 'node:crypto';
import { loadBankReceiptMatching } from './bank-receipt-matching.js';
import { loadMatchedPurchaseEnrichment, MATCHED_PURCHASE_ENRICHMENT_VERSION, LEDGER_DISPOSITIONS, MATCHED_PURCHASE_ENRICHMENT_STATUSES } from './matched-purchase-enrichment-projection.js';
import { refreshCertificationForEvents } from './certification.js';
import { businessEventEvidenceSemanticKey, GRAPH_MODEL_VERSION, SYSTEM_DERIVED } from './business-event-graph.js';
import { STANDALONE_PURCHASE_RULE, STANDALONE_PURCHASE_VERSION } from './standalone-purchase.js';
import { FNS_RECEIPT_CURRENCY_MODEL_VERSION, FNS_RECEIPT_CURRENCY_STATUSES, resolveFnsReceiptCurrency } from './fns-receipt-currency.js';
import { MATCHED_PURCHASE_AUTO_POLICY } from './matched-purchase-orchestration.js';
import { BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES } from './bank-receipt-matching.js';
import { SOURCE_PROVIDER_BINDING_PROVENANCE } from './bank-source-provider-binding.js';
import { APPROVED_INTERNAL_TRANSFER_WINDOW_MS, APPROVED_RECEIPT_WINDOW_MS } from './matched-purchase-reconciliation-constants.js';

export const MATCHED_PURCHASE_PERSISTENCE_VERSION = 'matched-purchase-persistence-v1';
export const MATCHED_PURCHASE_BANK_LEDGER_RULE = 'LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1';
const SHA256 = /^[0-9a-f]{64}$/i;
const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;

const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const requiredHash = (value, name) => { if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${name} is invalid`); return value.toLowerCase(); };
const requiredMoney = (value) => { if (typeof value !== 'string' || !MONEY.test(value) || value === '0.00') throw new Error('amount is invalid'); return value; };
const same = (a, b) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

function deltaSeconds(bankOccurredAt, receiptDateTime) {
  const delta = Date.parse(receiptDateTime) - Date.parse(bankOccurredAt);
  if (!Number.isSafeInteger(delta)) throw new Error('MATCH_TIME_INVALID');
  const sign = delta < 0 ? '-' : '';
  const absolute = Math.abs(delta);
  return `${sign}${Math.floor(absolute / 1000)}.${String(absolute % 1000).padStart(3, '0')}000`;
}

function fail(code, message = code) { const error = new Error(message); error.code = code; throw error; }

function receiptCurrencyResolution(value) {
  if (!value || value.modelVersion !== FNS_RECEIPT_CURRENCY_MODEL_VERSION
    || value.status !== FNS_RECEIPT_CURRENCY_STATUSES.RESOLVED
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)
    || value.sourceFamily !== 'FNS_FISCAL_RECEIPT'
    || !['EXPLICIT_PAYLOAD', 'FNS_SOURCE_CONTRACT'].includes(value.basis)
    || typeof value.reasonCode !== 'string') fail('MATCH_CONTRACT_INVALID', 'receipt currency resolution is invalid');
  return {
    modelVersion: value.modelVersion,
    sourceFamily: value.sourceFamily,
    status: value.status,
    currency: value.currency,
    basis: value.basis,
    reasonCode: value.reasonCode,
  };
}

function matchFields(match) {
  requiredHash(match.matchKey, 'matchKey');
  requiredMoney(match.amount);
  if (!/^[A-Z]{3}$/.test(match.currency)) fail('MATCH_CONTRACT_INVALID', 'currency is invalid');
  const currencyProvenance = receiptCurrencyResolution(match.receiptCurrencyResolution);
  if (currencyProvenance.currency !== match.currency) fail('MATCH_CONTRACT_INVALID', 'receipt currency does not match match currency');
  return {
    matchKey: match.matchKey.toLowerCase(), bankLedgerKey: match.bank.ledgerKey.toLowerCase(),
    bankCandidateKey: match.bank.candidateKey.toLowerCase(), bankJournalKey: match.bank.journalKey.toLowerCase(),
    bankTransactionId: Number(match.bank.bankTransactionId), financialAccountId: Number(match.bank.financialAccountId),
    receiptCandidateKey: match.receipt.receiptCandidateKey.toLowerCase(), receiptId: Number(match.receipt.receiptId),
    receiptNormalizationVersion: match.receipt.normalizationVersion,
    receiptNormalizedContentSha256: match.receipt.normalizedContentSha256.toLowerCase(),
    amount: match.amount, currency: match.currency, bankOccurredAt: new Date(match.bank.occurredAt).toISOString(),
    receiptDateTime: new Date(match.receipt.dateTime).toISOString(), timeDeltaSeconds: deltaSeconds(match.bank.occurredAt, match.receipt.dateTime),
    reasonCode: match.reasonCode ?? 'MATCHED_PURCHASE_RECEIPT_EVIDENCE',
    ownershipProvenance: match.bankAccountOwnershipProvenance ?? [],
    receiptCurrencyResolution: currencyProvenance,
  };
}

async function lockedScope(client, scopeKey) {
  const result = await client.query('SELECT id,scope_key FROM accounting_scopes WHERE scope_key=$1 FOR UPDATE', [scopeKey]);
  if (!result.rowCount) fail('SCOPE_NOT_FOUND');
  return result.rows[0];
}

async function assertAutomaticSourceProviderBinding(client, scope, fields, options) {
  if (!options.automaticPolicy) return;
  if (options.automaticPolicy !== MATCHED_PURCHASE_AUTO_POLICY
    || options.assignmentPolicy !== BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.NEAREST_DETERMINISTIC
    || options.requireSourceProviderBinding !== true
    || typeof options.bankIngestedAfter !== 'string'
    || !Number.isFinite(Date.parse(options.bankIngestedAfter))) fail('AUTO_POLICY_INVALID');
  const observation = (await client.query(`SELECT eo.bank_source_id,eo.created_at,eo.ingestion_metadata->>'provider' AS provider
    FROM bank_event_observations eo
    JOIN bank_sources bs ON bs.id=eo.bank_source_id
    WHERE eo.id=$1
    FOR UPDATE OF bs`, [fields.observationId])).rows[0];
  if (!observation || !observation.provider || new Date(observation.created_at) < new Date(options.bankIngestedAfter)) fail('AUTO_BANK_EVENT_OUTSIDE_COHORT');
  const sourceScopes = (await client.query(`SELECT DISTINCT p.scope_id
    FROM bank_source_person sp JOIN persons p ON p.id=sp.person_id
    WHERE sp.bank_source_id=$1 AND sp.relation_type='OWNER'
    ORDER BY p.scope_id`, [observation.bank_source_id])).rows;
  if (sourceScopes.length !== 1 || Number(sourceScopes[0].scope_id) !== Number(scope.id)) fail('AUTO_BANK_SCOPE_CHANGED');
  const resolution = (await client.query(`SELECT r.financial_account_id,r.resolution_state,r.provenance,
      a.scope_id AS account_scope_id,a.currency AS account_currency
    FROM bank_transaction_account_resolution r
    JOIN financial_accounts a ON a.id=r.financial_account_id
    WHERE r.bank_transaction_id=$1
    FOR UPDATE OF r,a`, [fields.bankTransactionId])).rows[0];
  if (!resolution || Number(resolution.financial_account_id) !== fields.financialAccountId
    || Number(resolution.account_scope_id) !== Number(scope.id) || resolution.account_currency !== fields.currency
    || !(resolution.resolution_state === 'EXACT' && resolution.provenance === 'OBSERVED_PROVIDER_REFERENCE')
      && !(resolution.resolution_state === 'MANUAL' && resolution.provenance === SOURCE_PROVIDER_BINDING_PROVENANCE)) {
    fail('AUTO_ACCOUNT_RESOLUTION_CHANGED');
  }
  const bindings = (await client.query(`SELECT financial_account_id,provenance
    FROM bank_source_provider_account_bindings
    WHERE bank_source_id=$1 AND provider=$2 AND active
    FOR UPDATE`, [observation.bank_source_id, observation.provider])).rows;
  if (bindings.length !== 1 || Number(bindings[0].financial_account_id) !== fields.financialAccountId
    || bindings[0].provenance !== SOURCE_PROVIDER_BINDING_PROVENANCE) fail('AUTO_SOURCE_PROVIDER_BINDING_CHANGED');
}

async function lockInputs(client, scope, fields, options = {}) {
  const tx = await client.query('SELECT id,observation_id,occurred_at,amount,currency FROM bank_transactions WHERE id=$1 FOR UPDATE', [fields.bankTransactionId]);
  const receipt = await client.query('SELECT id,date_time,total_sum,currency FROM receipts WHERE id=$1 FOR UPDATE', [fields.receiptId]);
  if (!tx.rowCount || !receipt.rowCount) fail('AUTHORITATIVE_INPUT_MISSING');
  const account = await client.query('SELECT id,scope_id,currency FROM financial_accounts WHERE id=$1 FOR UPDATE', [fields.financialAccountId]);
  if (!account.rowCount || Number(account.rows[0].scope_id) !== Number(scope.id) || account.rows[0].currency !== fields.currency) fail('ACCOUNT_SCOPE_OR_CURRENCY_CONFLICT');
  const fnsSource = await client.query(`SELECT EXISTS (
    SELECT 1
    FROM receipt_source_observations rso
    JOIN fns_sources fs ON fs.id=rso.fns_source_id
    WHERE rso.receipt_id=$1
  ) AS proven`, [fields.receiptId]);
  const currencyProvenance = resolveFnsReceiptCurrency({
    explicitCurrency: receipt.rows[0].currency,
    fnsSourceProven: fnsSource.rows[0].proven === true,
  });
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${scope.id}:bank-receipt-match:${fields.matchKey}`]);
  const lockedTransaction = { ...tx.rows[0], observationId: Number(tx.rows[0].observation_id) };
  await assertAutomaticSourceProviderBinding(client, scope, { ...fields, observationId: lockedTransaction.observationId }, options);
  return { transaction: lockedTransaction, receipt: receipt.rows[0], account: account.rows[0], receiptCurrencyResolution: currencyProvenance };
}

function assertAuthoritative(fields, locked) {
  const tx = locked.transaction; const receipt = locked.receipt;
  if (tx.currency !== fields.currency || tx.amount === null || String(tx.amount) !== fields.amount || (tx.occurred_at && new Date(tx.occurred_at).toISOString() !== fields.bankOccurredAt)) fail('AUTHORITATIVE_INPUT_CHANGED');
  if (String(receipt.total_sum) !== fields.amount || new Date(receipt.date_time).toISOString() !== fields.receiptDateTime
    || !same(locked.receiptCurrencyResolution, fields.receiptCurrencyResolution)
    || locked.receiptCurrencyResolution.currency !== fields.currency) fail('AUTHORITATIVE_INPUT_CHANGED');
}

async function persistMatch(client, scope, fields) {
  const select = async (where, params) => (await client.query(`SELECT * FROM bank_receipt_matches WHERE ${where} FOR UPDATE`, params)).rows;
  const existing = await select('match_key=$1 OR bank_transaction_id=$2 OR receipt_id=$3', [fields.matchKey, fields.bankTransactionId, fields.receiptId]);
  const expected = { scope_id: Number(scope.id), bank_transaction_id: fields.bankTransactionId, receipt_id: fields.receiptId, financial_account_id: fields.financialAccountId, matcher_version: 'bank-receipt-matching-v1', match_key: fields.matchKey, bank_ledger_key: fields.bankLedgerKey, bank_candidate_key: fields.bankCandidateKey, bank_journal_key: fields.bankJournalKey, receipt_candidate_key: fields.receiptCandidateKey, receipt_normalization_version: fields.receiptNormalizationVersion, receipt_normalized_content_sha256: fields.receiptNormalizedContentSha256, amount: fields.amount, currency: fields.currency, bank_occurred_at: fields.bankOccurredAt, receipt_date_time: fields.receiptDateTime, time_delta_seconds: fields.timeDeltaSeconds, relationship_type: 'MATCHED_PURCHASE', reason_code: fields.reasonCode, ownership_provenance: fields.ownershipProvenance };
  if (existing.length) {
    const row = existing[0];
    const normalized = { ...row, scope_id: Number(row.scope_id), bank_transaction_id: Number(row.bank_transaction_id), receipt_id: Number(row.receipt_id), financial_account_id: Number(row.financial_account_id), amount: String(row.amount), bank_occurred_at: new Date(row.bank_occurred_at).toISOString(), receipt_date_time: new Date(row.receipt_date_time).toISOString(), time_delta_seconds: String(row.time_delta_seconds), id: undefined, created_at: undefined };
    if (existing.length !== 1 || !same(normalized, { ...expected, id: undefined, created_at: undefined })) fail('MATCH_PERSISTENCE_CONFLICT');
    return existing[0];
  }
  const values = [expected.scope_id, expected.bank_transaction_id, expected.receipt_id, expected.financial_account_id, expected.matcher_version, expected.match_key, expected.bank_ledger_key, expected.bank_candidate_key, expected.bank_journal_key, expected.receipt_candidate_key, expected.receipt_normalization_version, expected.receipt_normalized_content_sha256, expected.amount, expected.currency, expected.bank_occurred_at, expected.receipt_date_time, expected.time_delta_seconds, expected.relationship_type, expected.reason_code, JSON.stringify(expected.ownership_provenance)];
  const result = await client.query(`INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,receipt_normalization_version,receipt_normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code,ownership_provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`, values);
  return result.rows[0];
}

async function persistPurchase(client, scope, fields, enrichment) {
  if (enrichment.purchaseIdentity.disposition === 'REUSE_EXISTING_PURCHASE') {
    const existing = (await client.query('SELECT * FROM business_events WHERE id=$1 AND scope_id=$2 FOR UPDATE', [enrichment.purchaseIdentity.eventId, scope.id])).rows[0];
    if (!existing || existing.event_type !== 'PURCHASE' || existing.resolution_status !== 'CONFIRMED'
      || existing.origin !== SYSTEM_DERIVED || existing.graph_model_version !== GRAPH_MODEL_VERSION
      || existing.rule_code !== STANDALONE_PURCHASE_RULE || existing.rule_version !== STANDALONE_PURCHASE_VERSION
      || String(existing.amount) !== fields.amount || existing.currency !== fields.currency) fail('PURCHASE_PERSISTENCE_CONFLICT');
    const evidence = (await client.query(`SELECT id,receipt_id,normalization_version,origin,graph_model_version,rule_code,rule_version,evidence_role,semantic_key
      FROM business_event_evidence
      WHERE event_id=$1 AND receipt_id=$2 AND normalization_version=$3
        AND evidence_role='PURCHASE_EVIDENCE' AND origin=$4
        AND graph_model_version=$5 AND rule_code=$6 AND rule_version=$7
      ORDER BY id`, [existing.id, fields.receiptId, fields.receiptNormalizationVersion, SYSTEM_DERIVED, GRAPH_MODEL_VERSION, STANDALONE_PURCHASE_RULE, STANDALONE_PURCHASE_VERSION])).rows;
    const expectedEvidenceKey = businessEventEvidenceSemanticKey({ scopeKey: scope.scope_key, eventId: Number(existing.id), receiptId: fields.receiptId, normalizationVersion: fields.receiptNormalizationVersion, evidenceRole: 'PURCHASE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: STANDALONE_PURCHASE_RULE, ruleVersion: STANDALONE_PURCHASE_VERSION, resolutionStatus: 'CONFIRMED', currency: fields.currency });
    if (evidence.length !== 1 || evidence[0].semantic_key !== expectedEvidenceKey) fail('PURCHASE_PERSISTENCE_CONFLICT');
    return { event: existing, evidenceId: Number(evidence[0].id) };
  }
  const identity = enrichment.purchaseIdentity.identityKey;
  await client.query(`INSERT INTO business_graph_rules(rule_code,rule_version,description)
    VALUES($1,$2,'Matched bank purchase') ON CONFLICT DO NOTHING`, [STANDALONE_PURCHASE_RULE, STANDALONE_PURCHASE_VERSION]);
  const eventResult = await client.query(`INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
    VALUES($1,'PURCHASE','CONFIRMED',$5,$6,$7,$8,$2,$3,$4,'Matched purchase funded by bank movement')
    ON CONFLICT(scope_id,semantic_key,graph_model_version,rule_code,rule_version,origin) DO UPDATE SET description=business_events.description
    RETURNING *`, [scope.id, identity, fields.amount, fields.currency, SYSTEM_DERIVED, GRAPH_MODEL_VERSION, STANDALONE_PURCHASE_RULE, STANDALONE_PURCHASE_VERSION]);
  const event = eventResult.rows[0];
  if (!event || event.event_type !== 'PURCHASE' || event.resolution_status !== 'CONFIRMED'
    || event.origin !== SYSTEM_DERIVED || event.graph_model_version !== GRAPH_MODEL_VERSION
    || event.rule_code !== STANDALONE_PURCHASE_RULE || event.rule_version !== STANDALONE_PURCHASE_VERSION
    || event.semantic_key !== identity || String(event.amount) !== fields.amount || event.currency !== fields.currency) fail('PURCHASE_PERSISTENCE_CONFLICT');
  const evidenceKey = businessEventEvidenceSemanticKey({ scopeKey: scope.scope_key, eventId: Number(event.id), receiptId: fields.receiptId, normalizationVersion: fields.receiptNormalizationVersion, evidenceRole: 'PURCHASE_EVIDENCE', origin: SYSTEM_DERIVED, graphModelVersion: GRAPH_MODEL_VERSION, ruleCode: STANDALONE_PURCHASE_RULE, ruleVersion: STANDALONE_PURCHASE_VERSION, resolutionStatus: 'CONFIRMED', currency: fields.currency });
  const evidence = await client.query(`INSERT INTO business_event_evidence(event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key) VALUES($1,$2,$3,'PURCHASE_EVIDENCE',$5,$6,$7,$8,$4) ON CONFLICT(semantic_key) DO UPDATE SET semantic_key=EXCLUDED.semantic_key RETURNING *`, [event.id, fields.receiptId, fields.receiptNormalizationVersion, evidenceKey, SYSTEM_DERIVED, GRAPH_MODEL_VERSION, STANDALONE_PURCHASE_RULE, STANDALONE_PURCHASE_VERSION]);
  const evidenceRow = evidence.rows[0];
  if (!evidenceRow || Number(evidenceRow.event_id) !== Number(event.id) || Number(evidenceRow.receipt_id) !== Number(fields.receiptId)
    || evidenceRow.normalization_version !== fields.receiptNormalizationVersion || evidenceRow.evidence_role !== 'PURCHASE_EVIDENCE'
    || evidenceRow.origin !== SYSTEM_DERIVED || evidenceRow.graph_model_version !== GRAPH_MODEL_VERSION
    || evidenceRow.rule_code !== STANDALONE_PURCHASE_RULE || evidenceRow.rule_version !== STANDALONE_PURCHASE_VERSION
    || evidenceRow.semantic_key !== evidenceKey) fail('PURCHASE_PERSISTENCE_CONFLICT');
  return { event, evidenceId: Number(evidenceRow.id) };
}

async function persistBankEvidence(client, scope, fields, enrichment, eventId, matchId) {
  const enrichmentKey = requiredHash(enrichment.enrichmentKey, 'enrichmentKey');
  const semanticKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, scopeId: Number(scope.id), eventId, matchId });
  const result = await client.query(`INSERT INTO business_event_bank_evidence(scope_id,business_event_id,bank_receipt_match_id,enrichment_key,evidence_role,rule_version,semantic_key) VALUES($1,$2,$3,$4,'BANK_PURCHASE_MATCH',$5,$6) ON CONFLICT(scope_id,bank_receipt_match_id) DO NOTHING RETURNING id`, [scope.id, eventId, matchId, enrichmentKey, MATCHED_PURCHASE_ENRICHMENT_VERSION, semanticKey]);
  if (result.rowCount) return Number(result.rows[0].id);
  const existing = (await client.query('SELECT id,scope_id,business_event_id,bank_receipt_match_id,enrichment_key,evidence_role,rule_version,semantic_key FROM business_event_bank_evidence WHERE scope_id=$1 AND bank_receipt_match_id=$2 FOR UPDATE', [scope.id, matchId])).rows[0];
  if (!existing || Number(existing.business_event_id) !== Number(eventId) || Number(existing.bank_receipt_match_id) !== Number(matchId) || existing.enrichment_key !== enrichmentKey || existing.evidence_role !== 'BANK_PURCHASE_MATCH' || existing.rule_version !== MATCHED_PURCHASE_ENRICHMENT_VERSION || existing.semantic_key !== semanticKey) fail('BANK_EVIDENCE_CONFLICT');
  return Number(existing.id);
}

async function mappedAccount(client, scope, fields) {
  const code = `FINANCIAL_ACCOUNT:${fields.financialAccountId}`;
  const rows = (await client.query('SELECT * FROM ledger_accounts WHERE scope_id=$1 AND (financial_account_id=$2 OR account_code=$3) FOR UPDATE', [scope.id, fields.financialAccountId, code])).rows;
  if (rows.length > 1) fail('LEDGER_ACCOUNT_MAPPING_CONFLICT');
  let row = rows[0];
  if (!row) row = (await client.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,$2,'ASSET','Mapped financial account',$3,$4) RETURNING *`, [scope.id, code, fields.financialAccountId, fields.currency])).rows[0];
  if (row.account_code !== code || row.account_type !== 'ASSET' || Number(row.financial_account_id) !== fields.financialAccountId || row.account_currency !== fields.currency || Number(row.scope_id) !== Number(scope.id)) fail('LEDGER_ACCOUNT_MAPPING_CONFLICT');
  return row;
}

async function catalogAccount(client, scope, code) {
  let row = (await client.query('SELECT * FROM ledger_accounts WHERE scope_id=$1 AND account_code=$2 FOR UPDATE', [scope.id, code])).rows[0];
  if (!row) row = (await client.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description) VALUES($1,$2,'CONTROL',$3) RETURNING *`, [scope.id, code, code])).rows[0];
  if (row.account_code !== code || row.account_type !== 'CONTROL' || Number(row.scope_id) !== Number(scope.id)
    || row.financial_account_id !== null || row.account_currency !== null) fail('LEDGER_CONTROL_ACCOUNT_CONFLICT');
  return row;
}

async function persistLedger(client, scope, fields, enrichment, eventId, evidenceId, matchId, mapped) {
  const debit = await catalogAccount(client, scope, 'UNCLASSIFIED_ACQUISITION');
  const semanticKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, eventId, matchKey: fields.matchKey, bankTransactionId: fields.bankTransactionId, financialAccountId: fields.financialAccountId, amount: fields.amount, currency: fields.currency });
  const existingEntries = (await client.query(`SELECT * FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2 AND derivation_rule=$3 AND origin=$4 FOR UPDATE`, [scope.id, eventId, MATCHED_PURCHASE_BANK_LEDGER_RULE, SYSTEM_DERIVED])).rows;
  if (existingEntries.some((candidate) => candidate.semantic_key !== semanticKey)) fail('LEDGER_CONFLICT');
  if (existingEntries.length > 1) fail('LEDGER_CONFLICT');
  let entry = existingEntries[0];
  if (!entry) entry = (await client.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description) VALUES($1,$2,$3,$4,$5,$6,'v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED','MATCHED_PURCHASE_BANK_FUNDING','Bank-funded matched purchase') RETURNING *`, [scope.id, eventId, fields.currency, fields.bankOccurredAt, semanticKey, MATCHED_PURCHASE_BANK_LEDGER_RULE])).rows[0];
  if (Number(entry.scope_id) !== Number(scope.id) || Number(entry.source_event_id) !== Number(eventId) || entry.currency !== fields.currency
    || entry.semantic_key !== semanticKey || entry.derivation_rule !== MATCHED_PURCHASE_BANK_LEDGER_RULE || entry.derivation_version !== 'v1'
    || entry.derivation_status !== 'READY' || entry.certification_status !== 'FUNDING_UNRECONCILED' || entry.origin !== SYSTEM_DERIVED
    || entry.reason_code !== 'MATCHED_PURCHASE_BANK_FUNDING' || new Date(entry.event_at).toISOString() !== fields.bankOccurredAt) fail('LEDGER_CONFLICT');
  const existingPostings = (await client.query('SELECT p.*,a.account_code,a.scope_id AS account_scope_id FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.ledger_entry_id=$1 ORDER BY p.id', [entry.id])).rows;
  if (!existingPostings.length) {
    await client.query('INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit,source_receipt_id) VALUES($1,$2,$3,$4,0,$5),($1,$6,$3,0,$4,$5)', [entry.id, debit.id, fields.currency, fields.amount, fields.receiptId, mapped.id]);
  } else {
    const actual = existingPostings.map((p) => ({ accountId: Number(p.account_id), accountCode: p.account_code, accountScopeId: Number(p.account_scope_id), currency: p.currency, debit: String(p.debit), credit: String(p.credit), sourceReceiptId: Number(p.source_receipt_id) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const expected = [{ accountId: Number(mapped.id), accountCode: `FINANCIAL_ACCOUNT:${fields.financialAccountId}`, accountScopeId: Number(scope.id), currency: fields.currency, debit: '0.00', credit: fields.amount, sourceReceiptId: Number(fields.receiptId) }, { accountId: Number(debit.id), accountCode: 'UNCLASSIFIED_ACQUISITION', accountScopeId: Number(scope.id), currency: fields.currency, debit: fields.amount, credit: '0.00', sourceReceiptId: Number(fields.receiptId) }].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (existingPostings.length !== expected.length || !same(actual, expected)) fail('LEDGER_CONFLICT');
  }
  const linkKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, entryId: Number(entry.id), matchId, bankTransactionId: fields.bankTransactionId, eventId, evidenceId, receiptId: fields.receiptId });
  const relatedLinks = (await client.query("SELECT * FROM ledger_source_links WHERE ledger_entry_id=$1 AND link_role='MATCHED_PURCHASE_BANK_FUNDING' FOR UPDATE", [entry.id])).rows;
  if (relatedLinks.length > 1 || (relatedLinks.length === 1 && (Number(relatedLinks[0].business_event_id) !== Number(eventId)
    || Number(relatedLinks[0].graph_evidence_id) !== Number(evidenceId) || Number(relatedLinks[0].receipt_id) !== Number(fields.receiptId)
    || relatedLinks[0].normalization_version !== fields.receiptNormalizationVersion || Number(relatedLinks[0].bank_receipt_match_id) !== Number(matchId)
    || Number(relatedLinks[0].bank_transaction_id) !== Number(fields.bankTransactionId) || relatedLinks[0].semantic_key !== linkKey))) fail('LEDGER_SOURCE_LINK_CONFLICT');
  const linkResult = await client.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,receipt_id,normalization_version,link_role,semantic_key,bank_receipt_match_id,bank_transaction_id) VALUES($1,$2,$3,$4,$5,'MATCHED_PURCHASE_BANK_FUNDING',$6,$7,$8) ON CONFLICT(semantic_key) DO NOTHING RETURNING id`, [entry.id, eventId, evidenceId, fields.receiptId, fields.receiptNormalizationVersion, linkKey, matchId, fields.bankTransactionId]);
  if (!linkResult.rowCount) {
    const link = (await client.query('SELECT * FROM ledger_source_links WHERE semantic_key=$1 FOR UPDATE', [linkKey])).rows[0];
    if (!link || Number(link.ledger_entry_id) !== Number(entry.id) || Number(link.business_event_id) !== Number(eventId)
      || Number(link.graph_evidence_id) !== Number(evidenceId) || Number(link.receipt_id) !== Number(fields.receiptId)
      || link.normalization_version !== fields.receiptNormalizationVersion || link.link_role !== 'MATCHED_PURCHASE_BANK_FUNDING'
      || Number(link.bank_receipt_match_id) !== Number(matchId) || Number(link.bank_transaction_id) !== Number(fields.bankTransactionId)) fail('LEDGER_SOURCE_LINK_CONFLICT');
  }
  return { entry };
}

async function appendSupersession(client, scope, oldEntryId, replacementEntryId, eventId, enrichmentKey) {
  if (!oldEntryId || !replacementEntryId || Number(oldEntryId) === Number(replacementEntryId)) fail('LEDGER_SUPERSESSION_CONFLICT');
  const existingOldRows = (await client.query('SELECT * FROM ledger_entry_supersessions WHERE scope_id=$1 AND superseded_ledger_entry_id=$2 FOR UPDATE', [scope.id, oldEntryId])).rows;
  const existingReplacementRows = (await client.query('SELECT * FROM ledger_entry_supersessions WHERE scope_id=$1 AND replacement_ledger_entry_id=$2 FOR UPDATE', [scope.id, replacementEntryId])).rows;
  const existingOld = existingOldRows[0];
  const existingReplacement = existingReplacementRows[0];
  const semanticKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, scopeId: Number(scope.id), oldEntryId: Number(oldEntryId), replacementEntryId: Number(replacementEntryId), eventId, enrichmentKey });
  const entries = (await client.query('SELECT id,scope_id,source_event_id FROM ledger_entries WHERE id=ANY($1::bigint[]) FOR UPDATE', [[oldEntryId, replacementEntryId]])).rows;
  if (entries.length !== 2 || entries.some((entry) => Number(entry.scope_id) !== Number(scope.id) || Number(entry.source_event_id) !== Number(eventId))) fail('LEDGER_SUPERSESSION_CONFLICT');
  if (existingOld || existingReplacement || existingOldRows.length || existingReplacementRows.length) {
    if (existingOldRows.length !== 1 || existingReplacementRows.length !== 1 || !existingOld || !existingReplacement
      || Number(existingOld.id) !== Number(existingReplacement.id)
      || Number(existingOld.scope_id) !== Number(scope.id) || Number(existingOld.superseded_ledger_entry_id) !== Number(oldEntryId)
      || Number(existingOld.replacement_ledger_entry_id) !== Number(replacementEntryId)
      || Number(existingOld.business_event_id) !== Number(eventId) || existingOld.enrichment_key !== enrichmentKey
      || existingOld.semantic_key !== semanticKey || existingOld.reason_code !== 'MATCHED_PURCHASE_REFINEMENT') fail('LEDGER_SUPERSESSION_CONFLICT');
    return existingOld;
  }
  const cycle = await client.query(`WITH RECURSIVE chain(id) AS (SELECT $2::bigint UNION SELECT s.replacement_ledger_entry_id FROM ledger_entry_supersessions s JOIN chain c ON c.id=s.superseded_ledger_entry_id WHERE s.scope_id=$1) SELECT 1 FROM chain WHERE id=$3`, [scope.id, replacementEntryId, oldEntryId]);
  if (cycle.rowCount) fail('LEDGER_SUPERSESSION_CONFLICT');
  return (await client.query(`INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code) VALUES($1,$2,$3,$4,$5,$6,'MATCHED_PURCHASE_REFINEMENT') RETURNING *`, [scope.id, oldEntryId, replacementEntryId, eventId, enrichmentKey, semanticKey])).rows[0];
}

async function validateExistingSupersessions(client, scope, eventId, enrichmentKey) {
  const rows = (await client.query(`SELECT s.*, old_entry.scope_id AS old_scope_id, old_entry.source_event_id AS old_event_id,
      replacement_entry.scope_id AS replacement_scope_id, replacement_entry.source_event_id AS replacement_event_id
    FROM ledger_entry_supersessions s
    JOIN ledger_entries old_entry ON old_entry.id=s.superseded_ledger_entry_id
    JOIN ledger_entries replacement_entry ON replacement_entry.id=s.replacement_ledger_entry_id
    WHERE s.scope_id=$1 AND (s.business_event_id=$2 OR old_entry.source_event_id=$2 OR replacement_entry.source_event_id=$2) FOR UPDATE`, [scope.id, eventId])).rows;
  for (const row of rows) {
    const semanticKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, scopeId: Number(scope.id), oldEntryId: Number(row.superseded_ledger_entry_id), replacementEntryId: Number(row.replacement_ledger_entry_id), eventId, enrichmentKey });
    if (Number(row.scope_id) !== Number(scope.id)
      || Number(row.old_scope_id) !== Number(scope.id) || Number(row.replacement_scope_id) !== Number(scope.id)
      || Number(row.old_event_id) !== Number(eventId) || Number(row.replacement_event_id) !== Number(eventId)
      || Number(row.business_event_id) !== Number(eventId) || row.enrichment_key !== enrichmentKey
      || row.semantic_key !== semanticKey || row.reason_code !== 'MATCHED_PURCHASE_REFINEMENT') fail('LEDGER_SUPERSESSION_CONFLICT');
  }
}

async function persistMatchedPurchaseInternal(pool, options = {}, matchingLoader = loadBankReceiptMatching) {
  if (options.automaticPolicy && (options.automaticPolicy !== MATCHED_PURCHASE_AUTO_POLICY
    || options.assignmentPolicy !== BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.NEAREST_DETERMINISTIC
    || options.requireSourceProviderBinding !== true
    || !options.bankIngestedAfter
    || options.approvedMatchKey
    || options.internalTransferMaxTimeDeltaMs !== APPROVED_INTERNAL_TRANSFER_WINDOW_MS
    || options.receiptMaxTimeDeltaMs !== APPROVED_RECEIPT_WINDOW_MS)) fail('AUTO_POLICY_INVALID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const initial = await matchingLoader(client, options);
    const initialMatches = initial?.matches ?? [];
    const selected = options.matchKey ? initialMatches.find((item) => item.matchKey === options.matchKey) : initialMatches.length === 1 ? initialMatches[0] : null;
    if (!selected) fail(initialMatches.length ? 'MATCH_SELECTION_REQUIRED' : 'MATCH_NOT_FOUND');
    if (options.automaticPolicy && (selected.assignmentPolicy !== BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.NEAREST_DETERMINISTIC
      || selected.bank?.sourceProviderBindingVerified !== true)) fail('AUTO_MATCH_POLICY_PROOF_MISSING');
    const fields = matchFields(selected);
    const scope = await lockedScope(client, selected.scopeKey);
    const locked = await lockInputs(client, scope, fields, options);
    assertAuthoritative(fields, locked);
    const current = await matchingLoader(client, options);
    const currentMatch = (current?.matches ?? []).find((item) => item.matchKey === fields.matchKey);
    if (!currentMatch || !same(matchFields(currentMatch), fields)) fail('AUTHORITATIVE_MATCH_CHANGED');
    const enrichment = await loadMatchedPurchaseEnrichment(client, { ...options, matchKey: fields.matchKey, matchingLoader: async () => ({ matches: [currentMatch] }) });
    if (enrichment.projectionStatus !== MATCHED_PURCHASE_ENRICHMENT_STATUSES.PROJECTED) fail(enrichment.reasonCode ?? 'ENRICHMENT_BLOCKED');
    const outcome = enrichment.ledgerDisposition === LEDGER_DISPOSITIONS.REUSE_EXISTING_BANK_FUNDING ? 'REUSED' : 'PERSISTED';
    const matchRow = await persistMatch(client, scope, fields);
    if (options.failAfter === 'match') fail('INJECTED_WRITER_FAILURE');
    const purchase = await persistPurchase(client, scope, fields, enrichment);
    if (options.failAfter === 'purchase') fail('INJECTED_WRITER_FAILURE');
    await validateExistingSupersessions(client, scope, Number(purchase.event.id), enrichment.enrichmentKey);
    const bankEvidenceId = await persistBankEvidence(client, scope, fields, enrichment, Number(purchase.event.id), Number(matchRow.id));
    const mapped = await mappedAccount(client, scope, fields);
    const ledger = await persistLedger(client, scope, fields, enrichment, Number(purchase.event.id), purchase.evidenceId, Number(matchRow.id), mapped);
    if (options.failAfter === 'ledger') fail('INJECTED_WRITER_FAILURE');
    if (enrichment.ledgerDisposition === LEDGER_DISPOSITIONS.REFINE_EXISTING_FISCAL_FUNDING) {
      const old = (await client.query(`SELECT e.id FROM ledger_entries e WHERE e.scope_id=$1 AND e.source_event_id=$2 AND e.derivation_rule='LEDGER_STANDALONE_PURCHASE_V1' AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id) FOR UPDATE`, [scope.id, Number(purchase.event.id)])).rows;
      if (old.length !== 1) fail('LEDGER_CONFLICT');
      await appendSupersession(client, scope, Number(old[0].id), Number(ledger.entry.id), Number(purchase.event.id), enrichment.enrichmentKey);
    }
    const certification = await refreshCertificationForEvents(client, { scopeKey: selected.scopeKey, eventIds: [Number(purchase.event.id)], client });
    if (options.failAfter === 'certification') fail('INJECTED_WRITER_FAILURE');
    const active = (await client.query(`SELECT count(*)::int AS count FROM ledger_entries e WHERE e.scope_id=$1 AND e.source_event_id=$2 AND e.origin=$3 AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)`, [scope.id, Number(purchase.event.id), SYSTEM_DERIVED])).rows[0].count;
    if (Number(active) !== 1) fail('LEDGER_CONFLICT');
    await client.query('COMMIT');
    return { modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, outcome, matchId: Number(matchRow.id), eventId: Number(purchase.event.id), bankEvidenceId, ledgerEntryId: Number(ledger.entry.id), certification, enrichmentKey: enrichment.enrichmentKey };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}

export async function persistMatchedPurchase(pool, options = {}) {
  return persistMatchedPurchaseInternal(pool, options, loadBankReceiptMatching);
}

export async function persistMatchedPurchaseForTest(pool, options = {}) {
  if (typeof options.matchingLoader !== 'function') fail('TEST_MATCHING_LOADER_REQUIRED');
  return persistMatchedPurchaseInternal(pool, options, options.matchingLoader);
}

export const persistMatchedPurchaseAtomic = persistMatchedPurchase;

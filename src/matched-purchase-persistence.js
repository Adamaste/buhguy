import crypto from 'node:crypto';
import { loadBankReceiptMatching } from './bank-receipt-matching.js';
import { loadMatchedPurchaseEnrichment, MATCHED_PURCHASE_ENRICHMENT_VERSION, LEDGER_DISPOSITIONS, MATCHED_PURCHASE_ENRICHMENT_STATUSES } from './matched-purchase-enrichment-projection.js';
import { refreshCertificationForEvents } from './certification.js';

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

function matchFields(match) {
  requiredHash(match.matchKey, 'matchKey');
  requiredMoney(match.amount);
  if (!/^[A-Z]{3}$/.test(match.currency)) fail('MATCH_CONTRACT_INVALID', 'currency is invalid');
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
  };
}

async function lockedScope(client, scopeKey) {
  const result = await client.query('SELECT id,scope_key FROM accounting_scopes WHERE scope_key=$1 FOR UPDATE', [scopeKey]);
  if (!result.rowCount) fail('SCOPE_NOT_FOUND');
  return result.rows[0];
}

async function lockInputs(client, scope, fields) {
  const tx = await client.query('SELECT id,observation_id,occurred_at,amount,currency FROM bank_transactions WHERE id=$1 FOR UPDATE', [fields.bankTransactionId]);
  const receipt = await client.query('SELECT id,date_time,total_sum,currency FROM receipts WHERE id=$1 FOR UPDATE', [fields.receiptId]);
  if (!tx.rowCount || !receipt.rowCount) fail('AUTHORITATIVE_INPUT_MISSING');
  const account = await client.query('SELECT id,scope_id,currency FROM financial_accounts WHERE id=$1 FOR UPDATE', [fields.financialAccountId]);
  if (!account.rowCount || Number(account.rows[0].scope_id) !== Number(scope.id) || account.rows[0].currency !== fields.currency) fail('ACCOUNT_SCOPE_OR_CURRENCY_CONFLICT');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${scope.id}:bank-receipt-match:${fields.matchKey}`]);
  return { transaction: tx.rows[0], receipt: receipt.rows[0], account: account.rows[0] };
}

function assertAuthoritative(fields, locked) {
  const tx = locked.transaction; const receipt = locked.receipt;
  if (tx.currency !== fields.currency || tx.amount === null || String(tx.amount) !== fields.amount || (tx.occurred_at && new Date(tx.occurred_at).toISOString() !== fields.bankOccurredAt)) fail('AUTHORITATIVE_INPUT_CHANGED');
  if (receipt.currency !== fields.currency || String(receipt.total_sum) !== fields.amount || new Date(receipt.date_time).toISOString() !== fields.receiptDateTime) fail('AUTHORITATIVE_INPUT_CHANGED');
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
    if (!existing || existing.event_type !== 'PURCHASE' || existing.resolution_status !== 'CONFIRMED' || String(existing.amount) !== fields.amount || existing.currency !== fields.currency) fail('PURCHASE_PERSISTENCE_CONFLICT');
    const evidence = (await client.query(`SELECT id FROM business_event_evidence WHERE event_id=$1 AND receipt_id=$2 AND normalization_version=$3 FOR UPDATE`, [existing.id, fields.receiptId, fields.receiptNormalizationVersion])).rows[0];
    if (!evidence) fail('PURCHASE_RECEIPT_EVIDENCE_MISSING');
    return { event: existing, evidenceId: Number(evidence.id) };
  }
  const identity = enrichment.purchaseIdentity.identityKey;
  await client.query(`INSERT INTO business_graph_rules(rule_code,rule_version,description)
    VALUES('STANDALONE_PURCHASE_V1','standalone-purchase-v1','Matched bank purchase') ON CONFLICT DO NOTHING`);
  const eventResult = await client.query(`INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
    VALUES($1,'PURCHASE','CONFIRMED','SYSTEM_DERIVED','business-event-graph-v1','STANDALONE_PURCHASE_V1','standalone-purchase-v1',$2,$3,$4,'Matched purchase funded by bank movement')
    ON CONFLICT(scope_id,semantic_key,graph_model_version,rule_code,rule_version,origin) DO UPDATE SET description=business_events.description
    RETURNING *`, [scope.id, identity, fields.amount, fields.currency]);
  const event = eventResult.rows[0];
  if (!event) fail('PURCHASE_PERSISTENCE_CONFLICT');
  const evidenceKey = hash({ eventId: Number(event.id), receiptId: fields.receiptId, normalizationVersion: fields.receiptNormalizationVersion, role: 'PURCHASE_EVIDENCE' });
  const evidence = await client.query(`INSERT INTO business_event_evidence(event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key) VALUES($1,$2,$3,'PURCHASE_EVIDENCE','SYSTEM_DERIVED','business-event-graph-v1','STANDALONE_PURCHASE_V1','standalone-purchase-v1',$4) ON CONFLICT(semantic_key) DO UPDATE SET semantic_key=EXCLUDED.semantic_key RETURNING id`, [event.id, fields.receiptId, fields.receiptNormalizationVersion, evidenceKey]);
  return { event, evidenceId: Number(evidence.rows[0].id) };
}

async function persistBankEvidence(client, scope, fields, enrichment, eventId, matchId) {
  const enrichmentKey = requiredHash(enrichment.enrichmentKey, 'enrichmentKey');
  const semanticKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, scopeId: Number(scope.id), eventId, matchId });
  const result = await client.query(`INSERT INTO business_event_bank_evidence(scope_id,business_event_id,bank_receipt_match_id,enrichment_key,evidence_role,rule_version,semantic_key) VALUES($1,$2,$3,$4,'BANK_PURCHASE_MATCH',$5,$6) ON CONFLICT(scope_id,bank_receipt_match_id) DO NOTHING RETURNING id`, [scope.id, eventId, matchId, enrichmentKey, MATCHED_PURCHASE_ENRICHMENT_VERSION, semanticKey]);
  if (result.rowCount) return Number(result.rows[0].id);
  const existing = (await client.query('SELECT id,scope_id,business_event_id,bank_receipt_match_id,enrichment_key,evidence_role,rule_version,semantic_key FROM business_event_bank_evidence WHERE scope_id=$1 AND bank_receipt_match_id=$2 FOR UPDATE', [scope.id, matchId])).rows[0];
  if (!existing || Number(existing.business_event_id) !== Number(eventId) || Number(existing.bank_receipt_match_id) !== Number(matchId) || existing.evidence_role !== 'BANK_PURCHASE_MATCH' || existing.rule_version !== MATCHED_PURCHASE_ENRICHMENT_VERSION || existing.semantic_key !== semanticKey) fail('BANK_EVIDENCE_CONFLICT');
  return Number(existing.id);
}

async function mappedAccount(client, scope, fields) {
  const code = `FINANCIAL_ACCOUNT:${fields.financialAccountId}`;
  let row = (await client.query('SELECT * FROM ledger_accounts WHERE scope_id=$1 AND (financial_account_id=$2 OR account_code=$3) FOR UPDATE', [scope.id, fields.financialAccountId, code])).rows[0];
  if (!row) row = (await client.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency) VALUES($1,$2,'ASSET','Mapped financial account',$3,$4) RETURNING *`, [scope.id, code, fields.financialAccountId, fields.currency])).rows[0];
  if (row.account_code !== code || row.account_type !== 'ASSET' || Number(row.financial_account_id) !== fields.financialAccountId || row.account_currency !== fields.currency || Number(row.scope_id) !== Number(scope.id)) fail('LEDGER_ACCOUNT_MAPPING_CONFLICT');
  return row;
}

async function catalogAccount(client, scope, code) {
  let row = (await client.query('SELECT * FROM ledger_accounts WHERE scope_id=$1 AND account_code=$2 FOR UPDATE', [scope.id, code])).rows[0];
  if (!row) row = (await client.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description) VALUES($1,$2,'CONTROL',$3) RETURNING *`, [scope.id, code, code])).rows[0];
  return row;
}

async function persistLedger(client, scope, fields, enrichment, eventId, evidenceId, matchId, mapped) {
  const debit = await catalogAccount(client, scope, 'UNCLASSIFIED_ACQUISITION');
  const semanticKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, eventId, matchKey: fields.matchKey, bankTransactionId: fields.bankTransactionId, financialAccountId: fields.financialAccountId, amount: fields.amount, currency: fields.currency });
  let entry = (await client.query(`SELECT * FROM ledger_entries WHERE scope_id=$1 AND semantic_key=$2 AND derivation_rule=$3 AND derivation_version='v1' AND origin='SYSTEM_DERIVED' FOR UPDATE`, [scope.id, semanticKey, MATCHED_PURCHASE_BANK_LEDGER_RULE])).rows[0];
  if (!entry) entry = (await client.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description) VALUES($1,$2,$3,$4,$5,$6,'v1','READY','FUNDING_UNRECONCILED','SYSTEM_DERIVED','MATCHED_PURCHASE_BANK_FUNDING','Bank-funded matched purchase') RETURNING *`, [scope.id, eventId, fields.currency, fields.bankOccurredAt, semanticKey, MATCHED_PURCHASE_BANK_LEDGER_RULE])).rows[0];
  if (Number(entry.scope_id) !== Number(scope.id) || Number(entry.source_event_id) !== Number(eventId) || entry.currency !== fields.currency || new Date(entry.event_at).toISOString() !== fields.bankOccurredAt) fail('LEDGER_CONFLICT');
  const existingPostings = (await client.query('SELECT p.*,a.account_code FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.ledger_entry_id=$1 ORDER BY p.id', [entry.id])).rows;
  if (!existingPostings.length) {
    await client.query('INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit,source_receipt_id) VALUES($1,$2,$3,$4,0,$5),($1,$6,$3,0,$4,$5)', [entry.id, debit.id, fields.currency, fields.amount, fields.receiptId, mapped.id]);
  } else if (!same(existingPostings.map((p) => [p.account_code, String(p.debit), String(p.credit), p.currency]).sort(), [['FINANCIAL_ACCOUNT:' + fields.financialAccountId, '0.00', fields.amount, fields.currency], ['UNCLASSIFIED_ACQUISITION', fields.amount, '0.00', fields.currency]].sort())) fail('LEDGER_CONFLICT');
  const linkKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, entryId: Number(entry.id), matchId, bankTransactionId: fields.bankTransactionId, eventId, evidenceId, receiptId: fields.receiptId });
  const linkResult = await client.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,receipt_id,normalization_version,link_role,semantic_key,bank_receipt_match_id,bank_transaction_id) VALUES($1,$2,$3,$4,$5,'MATCHED_PURCHASE_BANK_FUNDING',$6,$7,$8) ON CONFLICT(semantic_key) DO NOTHING RETURNING id`, [entry.id, eventId, evidenceId, fields.receiptId, fields.receiptNormalizationVersion, linkKey, matchId, fields.bankTransactionId]);
  if (!linkResult.rowCount) {
    const link = (await client.query('SELECT * FROM ledger_source_links WHERE semantic_key=$1 FOR UPDATE', [linkKey])).rows[0];
    if (!link || Number(link.ledger_entry_id) !== Number(entry.id) || Number(link.bank_receipt_match_id) !== Number(matchId)) fail('LEDGER_SOURCE_LINK_CONFLICT');
  }
  return { entry };
}

async function appendSupersession(client, scope, oldEntryId, replacementEntryId, eventId, enrichmentKey) {
  if (!oldEntryId || !replacementEntryId || Number(oldEntryId) === Number(replacementEntryId)) fail('LEDGER_SUPERSESSION_CONFLICT');
  const existingOld = (await client.query('SELECT * FROM ledger_entry_supersessions WHERE scope_id=$1 AND superseded_ledger_entry_id=$2 FOR UPDATE', [scope.id, oldEntryId])).rows[0];
  const existingReplacement = (await client.query('SELECT * FROM ledger_entry_supersessions WHERE scope_id=$1 AND replacement_ledger_entry_id=$2 FOR UPDATE', [scope.id, replacementEntryId])).rows[0];
  const semanticKey = hash({ modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, scopeId: Number(scope.id), oldEntryId: Number(oldEntryId), replacementEntryId: Number(replacementEntryId), eventId, enrichmentKey });
  if (existingOld || existingReplacement) {
    if (!existingOld || !existingReplacement || Number(existingOld.id) !== Number(existingReplacement.id) || existingOld.semantic_key !== semanticKey) fail('LEDGER_SUPERSESSION_CONFLICT');
    return existingOld;
  }
  const cycle = await client.query(`WITH RECURSIVE chain(id) AS (SELECT $2::bigint UNION SELECT s.replacement_ledger_entry_id FROM ledger_entry_supersessions s JOIN chain c ON c.id=s.superseded_ledger_entry_id WHERE s.scope_id=$1) SELECT 1 FROM chain WHERE id=$3`, [scope.id, replacementEntryId, oldEntryId]);
  if (cycle.rowCount) fail('LEDGER_SUPERSESSION_CONFLICT');
  return (await client.query(`INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code) VALUES($1,$2,$3,$4,$5,$6,'MATCHED_PURCHASE_REFINEMENT') RETURNING *`, [scope.id, oldEntryId, replacementEntryId, eventId, enrichmentKey, semanticKey])).rows[0];
}

export async function persistMatchedPurchase(pool, options = {}) {
  const matchingLoader = options.matchingLoader ?? loadBankReceiptMatching;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const initial = await matchingLoader(client, options);
    const initialMatches = initial?.matches ?? [];
    const selected = options.matchKey ? initialMatches.find((item) => item.matchKey === options.matchKey) : initialMatches.length === 1 ? initialMatches[0] : null;
    if (!selected) fail(initialMatches.length ? 'MATCH_SELECTION_REQUIRED' : 'MATCH_NOT_FOUND');
    const fields = matchFields(selected);
    const scope = await lockedScope(client, selected.scopeKey);
    const locked = await lockInputs(client, scope, fields);
    assertAuthoritative(fields, locked);
    const current = await matchingLoader(client, options);
    const currentMatch = (current?.matches ?? []).find((item) => item.matchKey === fields.matchKey);
    if (!currentMatch || !same(matchFields(currentMatch), fields)) fail('AUTHORITATIVE_MATCH_CHANGED');
    const enrichment = await loadMatchedPurchaseEnrichment(client, { ...options, matchKey: fields.matchKey, matchingLoader: async () => ({ matches: [currentMatch] }) });
    if (enrichment.projectionStatus !== MATCHED_PURCHASE_ENRICHMENT_STATUSES.PROJECTED) fail(enrichment.reasonCode ?? 'ENRICHMENT_BLOCKED');
    const matchRow = await persistMatch(client, scope, fields);
    if (options.failAfter === 'match') fail('INJECTED_WRITER_FAILURE');
    const purchase = await persistPurchase(client, scope, fields, enrichment);
    if (options.failAfter === 'purchase') fail('INJECTED_WRITER_FAILURE');
    const bankEvidenceId = await persistBankEvidence(client, scope, fields, enrichment, Number(purchase.event.id), Number(matchRow.id));
    const mapped = await mappedAccount(client, scope, fields);
    const ledger = await persistLedger(client, scope, fields, enrichment, Number(purchase.event.id), bankEvidenceId, Number(matchRow.id), mapped);
    if (options.failAfter === 'ledger') fail('INJECTED_WRITER_FAILURE');
    if (enrichment.ledgerDisposition === LEDGER_DISPOSITIONS.REFINE_EXISTING_FISCAL_FUNDING) {
      const old = (await client.query(`SELECT e.id FROM ledger_entries e WHERE e.scope_id=$1 AND e.source_event_id=$2 AND e.derivation_rule='LEDGER_STANDALONE_PURCHASE_V1' AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id) FOR UPDATE`, [scope.id, Number(purchase.event.id)])).rows;
      if (old.length !== 1) fail('LEDGER_CONFLICT');
      await appendSupersession(client, scope, Number(old[0].id), Number(ledger.entry.id), Number(purchase.event.id), enrichment.enrichmentKey);
    }
    const certification = await refreshCertificationForEvents(client, { scopeKey: selected.scopeKey, eventIds: [Number(purchase.event.id)], client });
    if (options.failAfter === 'certification') fail('INJECTED_WRITER_FAILURE');
    await client.query('COMMIT');
    return { modelVersion: MATCHED_PURCHASE_PERSISTENCE_VERSION, matchId: Number(matchRow.id), eventId: Number(purchase.event.id), bankEvidenceId, ledgerEntryId: Number(ledger.entry.id), certification, enrichmentKey: enrichment.enrichmentKey };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}

export const persistMatchedPurchaseAtomic = persistMatchedPurchase;

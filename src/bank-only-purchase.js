import crypto from 'node:crypto';
import { loadBankLedgerProjection } from './bank-ledger-projection.js';
import { BANK_RECEIPT_MATCHING_STATUSES, loadBankReceiptMatching } from './bank-receipt-matching.js';
import { loadBankInternalTransferOwnershipSnapshot } from './bank-internal-transfer-matching.js';
import { hasAutomaticMatchedPurchaseAccountProof, TBANK_ANDROID_PROVIDER } from './matched-purchase-account-proof.js';
import { lockMatchedPurchaseBankTransaction, lockMatchedPurchaseScope, lockMatchedPurchaseScopeTransaction, lockMatchedPurchaseSourceProvider } from './matched-purchase-locks.js';
import { rebuildLedger } from './ledger.js';
import { refreshCertificationForEvents } from './certification.js';
import {
  BANK_ONLY_PURCHASE_EVIDENCE_ROLE,
  BANK_ONLY_PURCHASE_EVENT_RULE,
  BANK_ONLY_PURCHASE_LEDGER_RULE,
  BANK_ONLY_PURCHASE_VERSION,
  bankOnlyEvidenceSemanticKey,
  bankOnlyEvidenceSha256,
  isValidBankOnlyPurchaseEvidence,
} from './bank-only-purchase-contract.js';

export const BANK_ONLY_PURCHASE_LEDGER_ENABLED_ENV = 'BANK_ONLY_PURCHASE_LEDGER_ENABLED';
export const BANK_ONLY_PURCHASE_LEDGER_SCOPE_ENV = 'BANK_ONLY_PURCHASE_LEDGER_SCOPE';
export const BANK_ONLY_PURCHASE_LEDGER_START_AT_ENV = 'BANK_ONLY_PURCHASE_LEDGER_START_AT';
export const BANK_ONLY_PURCHASE_ALFA_START_AT_ENV = 'BANK_ONLY_PURCHASE_ALFA_START_AT';
export const BANK_ONLY_PURCHASE_LEDGER_MAX_WRITES = 25;
export const BANK_ONLY_PURCHASE_LEDGER_MAX_CANDIDATES = BANK_ONLY_PURCHASE_LEDGER_MAX_WRITES * 10;
const INTERNAL_TRANSFER_MAX_TIME_DELTA_MS = 300000;
const ALFA_ANDROID_PROVIDER = 'ru.alfabank.mobile.android';
const OPAQUE_NOTIFICATION_LIFECYCLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SHA256 = /^[0-9a-f]{64}$/i;
const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const ACCOUNT_CODE = (id) => `FINANCIAL_ACCOUNT:${id}`;
const safeScope = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value.trim()) ? value.trim() : null;
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
const RECEIPT_MATCH_DIAGNOSTIC_STATUSES = new Set([
  ...Object.values(BANK_RECEIPT_MATCHING_STATUSES), 'NOT_EVALUATED',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function iso(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function readBankOnlyPurchaseLedgerOptIn(env = process.env) {
  if (env[BANK_ONLY_PURCHASE_LEDGER_ENABLED_ENV] !== 'true') return { enabled: false, reasonCode: 'DISABLED' };
  const scopeKey = safeScope(env[BANK_ONLY_PURCHASE_LEDGER_SCOPE_ENV]);
  const startAt = iso(env[BANK_ONLY_PURCHASE_LEDGER_START_AT_ENV]);
  const alfaStartAt = iso(env[BANK_ONLY_PURCHASE_ALFA_START_AT_ENV]);
  if (!scopeKey || !startAt) return { enabled: false, reasonCode: 'CONFIG_INVALID' };
  return { enabled: true, scopeKey, startAt, alfaStartAt, maxWrites: BANK_ONLY_PURCHASE_LEDGER_MAX_WRITES };
}

function blocked(reasonCode) { return { status: 'BLOCKED', reasonCode }; }

function receiptMatchDiagnosticCode(status) {
  if (status === BANK_RECEIPT_MATCHING_STATUSES.AMBIGUOUS) return 'AMBIGUOUS_RECEIPT_CANDIDATE_AT_WRITE';
  if (status === BANK_RECEIPT_MATCHING_STATUSES.MATCHED) return 'UNIQUE_RECEIPT_CANDIDATE_PENDING';
  if (status === 'NOT_EVALUATED') return 'RECEIPT_MATCH_DIAGNOSTIC_UNAVAILABLE';
  return null;
}

async function inspectReceiptMatchStatus(client, { scopeKey, occurredAt, bankTransactionId }) {
  await client.query('SAVEPOINT bank_only_receipt_match_diagnostic');
  try {
    const result = await loadBankReceiptMatching(client, {
      scopeKey,
      from: new Date(occurredAt - INTERNAL_TRANSFER_MAX_TIME_DELTA_MS).toISOString(),
      to: new Date(occurredAt + INTERNAL_TRANSFER_MAX_TIME_DELTA_MS + 1).toISOString(),
      internalTransferMaxTimeDeltaMs: INTERNAL_TRANSFER_MAX_TIME_DELTA_MS,
      receiptMaxTimeDeltaMs: INTERNAL_TRANSFER_MAX_TIME_DELTA_MS,
    });
    const status = result.bankStatuses.find((item) => Number(item.bankTransactionId) === bankTransactionId)?.status;
    await client.query('RELEASE SAVEPOINT bank_only_receipt_match_diagnostic');
    return RECEIPT_MATCH_DIAGNOSTIC_STATUSES.has(status) ? status : 'NOT_EVALUATED';
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT bank_only_receipt_match_diagnostic');
    await client.query('RELEASE SAVEPOINT bank_only_receipt_match_diagnostic');
    return 'NOT_EVALUATED';
  }
}

async function eventSourceRow(client, bankTransactionId) {
  return (await client.query(`SELECT bt.id AS "bankTransactionId",bt.observation_id AS "observationId",
      bt.occurred_at AS "occurredAt",bt.amount::text AS amount,bt.currency,
      bt.merchant,bt.account_reference AS "accountReference",bt.account_reference_kind AS "accountReferenceKind",
      eo.bank_source_id AS "bankSourceId",eo.created_at AS "observedAt",
      eo.ingestion_metadata->>'provider' AS provider,
      eo.ingestion_metadata->>'notificationLifecycleId' AS "notificationLifecycleId"
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id=bt.observation_id
    WHERE bt.id=$1`, [bankTransactionId])).rows[0] ?? null;
}

async function existingAlfaLifecycleState(client, { source, purchase, scopeId, bankTransactionId }) {
  if (source.provider !== ALFA_ANDROID_PROVIDER) return null;
  if (!OPAQUE_NOTIFICATION_LIFECYCLE_ID.test(source.notificationLifecycleId ?? '')) {
    return { status: 'BLOCKED', reasonCode: 'ALFA_LIFECYCLE_ID_REQUIRED' };
  }
  const siblings = (await client.query(`SELECT bt.id,bt.amount::text AS amount,bt.currency,bt.event_type,bt.direction,
      bt.normalization_status,bt.evidence_quality,
      COALESCE(be.financial_account_id,resolution.financial_account_id) AS financial_account_id,
      EXISTS (SELECT 1 FROM bank_receipt_matches matched WHERE matched.bank_transaction_id=bt.id) AS matched
    FROM bank_event_observations observation
    JOIN bank_transactions bt ON bt.observation_id=observation.id
    LEFT JOIN business_event_bank_evidence be ON be.bank_transaction_id=bt.id
      AND be.evidence_role=$4
    LEFT JOIN bank_transaction_account_resolution resolution ON resolution.bank_transaction_id=bt.id
    WHERE observation.bank_source_id=$1
      AND observation.ingestion_metadata->>'provider'=$2
      AND observation.ingestion_metadata->>'notificationLifecycleId'=$3
      AND bt.id<>$5 AND (be.id IS NOT NULL OR EXISTS (
        SELECT 1 FROM bank_receipt_matches matched WHERE matched.bank_transaction_id=bt.id))
    ORDER BY bt.id`, [source.bankSourceId, ALFA_ANDROID_PROVIDER, source.notificationLifecycleId,
    BANK_ONLY_PURCHASE_EVIDENCE_ROLE, bankTransactionId])).rows;
  if (siblings.length === 0) return null;
  if (siblings.length !== 1) return { status: 'BLOCKED', reasonCode: 'ALFA_LIFECYCLE_ACCOUNTING_CONFLICT' };
  const sibling = siblings[0];
  if (sibling.event_type !== 'PURCHASE' || sibling.direction !== 'DEBIT'
    || sibling.normalization_status !== 'READY' || sibling.evidence_quality !== 'EXACT'
    || String(sibling.amount) !== purchase.entry.amount || sibling.currency !== purchase.entry.currency
    || Number(sibling.financial_account_id) !== purchase.financialAccountId) {
    return { status: 'BLOCKED', reasonCode: 'ALFA_LIFECYCLE_ACCOUNTING_CONFLICT' };
  }
  const activeLedger = (await client.query(`SELECT DISTINCT entry.id,entry.source_event_id
    FROM ledger_source_links link JOIN ledger_entries entry ON entry.id=link.ledger_entry_id
    WHERE link.bank_transaction_id=$1
      AND entry.scope_id=$2
      AND entry.derivation_rule IN ('LEDGER_BANK_ONLY_PURCHASE_V1','LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1')
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions supersession
        WHERE supersession.scope_id=entry.scope_id AND supersession.superseded_ledger_entry_id=entry.id)
    ORDER BY entry.id`, [sibling.id, scopeId])).rows;
  if (activeLedger.length !== 1) return { status: 'BLOCKED', reasonCode: 'ALFA_LIFECYCLE_ACTIVE_LEDGER_CONFLICT' };
  return {
    status: 'REUSED',
    reasonCode: 'ALFA_NOTIFICATION_LIFECYCLE_ALREADY_ACCOUNTED',
    eventId: Number(activeLedger[0].source_event_id),
    ledgerEntryId: Number(activeLedger[0].id),
  };
}

async function existingState(client, scope, bankTransactionId) {
  const matches = (await client.query('SELECT id FROM bank_receipt_matches WHERE bank_transaction_id=$1', [bankTransactionId])).rows;
  if (matches.length > 1) throw Object.assign(new Error('BANK_MATCH_CONFLICT'), { code: 'BANK_MATCH_CONFLICT' });
  if (matches.length) return { matched: true };
  const evidence = (await client.query(`SELECT be.id,be.scope_id,be.business_event_id,be.bank_receipt_match_id,
      be.bank_transaction_id,be.financial_account_id,be.enrichment_key,be.evidence_role,be.rule_version,
      be.semantic_key,be.evidence_snapshot,be.evidence_sha256,e.id AS event_row_id,e.scope_id AS event_scope_id,
      e.event_type,e.resolution_status,e.origin,e.graph_model_version,e.rule_code,e.rule_version AS event_rule_version,
      e.amount::text AS event_amount,e.currency,s.scope_key
    FROM business_event_bank_evidence be
    JOIN business_events e ON e.id=be.business_event_id
    JOIN accounting_scopes s ON s.id=e.scope_id
    WHERE be.scope_id=$1 AND be.bank_transaction_id=$2 AND be.evidence_role=$3`, [scope.id, bankTransactionId, BANK_ONLY_PURCHASE_EVIDENCE_ROLE])).rows;
  if (evidence.length > 1) throw Object.assign(new Error('BANK_ONLY_EVIDENCE_CONFLICT'), { code: 'BANK_ONLY_EVIDENCE_CONFLICT' });
  if (!evidence.length) return { matched: false, existing: false };
  const row = evidence[0];
  const event = {
    id: Number(row.event_row_id), scope_id: Number(row.event_scope_id), scope_key: row.scope_key,
    event_type: row.event_type, resolution_status: row.resolution_status, origin: row.origin,
    graph_model_version: row.graph_model_version, rule_code: row.rule_code, rule_version: row.event_rule_version,
    amount: row.event_amount, currency: row.currency,
  };
  if (!isValidBankOnlyPurchaseEvidence(event, row)) throw Object.assign(new Error('BANK_ONLY_EVIDENCE_CONFLICT'), { code: 'BANK_ONLY_EVIDENCE_CONFLICT' });
  const active = (await client.query(`SELECT e.id,e.derivation_rule,l.id AS link_id,l.bank_transaction_id
    FROM ledger_entries e
    JOIN ledger_source_links l ON l.ledger_entry_id=e.id
    WHERE e.scope_id=$1 AND e.source_event_id=$2 AND e.derivation_rule=$3
      AND l.link_role=$4 AND l.bank_transaction_id=$5
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss
        WHERE ss.scope_id=e.scope_id AND ss.superseded_ledger_entry_id=e.id)
    ORDER BY e.id`, [scope.id, event.id, BANK_ONLY_PURCHASE_LEDGER_RULE, BANK_ONLY_PURCHASE_EVIDENCE_ROLE, bankTransactionId])).rows;
  if (active.length !== 1) throw Object.assign(new Error('BANK_ONLY_LEDGER_CONFLICT'), { code: 'BANK_ONLY_LEDGER_CONFLICT' });
  return { matched: false, existing: true, eventId: event.id, ledgerEntryId: Number(active[0].id) };
}

function projectedPurchase(projection, bankTransactionId, scopeKey) {
  const rows = (projection.entries ?? []).filter((entry) => Number(entry.sourceProvenance?.bankTransactionId) === bankTransactionId);
  if (rows.length !== 1) return null;
  const entry = rows[0];
  if (entry.economicKind !== 'PURCHASE' || entry.scopeKey !== scopeKey
    || !MONEY.test(entry.amount ?? '') || entry.amount === '0.00' || entry.currency !== 'RUB'
    || !SHA256.test(entry.ledgerKey ?? '') || !SHA256.test(entry.sourceProvenance?.candidateKey ?? '')
    || !SHA256.test(entry.sourceProvenance?.journalKey ?? '')) return null;
  const provenance = entry.sourceProvenance?.sourceProvenance;
  if (!provenance || provenance.sourceMovementType !== 'PURCHASE'
    || provenance.sourceProjectionStatus !== 'PROJECTED'
    || !hasAutomaticMatchedPurchaseAccountProof({
      provider: provenance.provider,
      sourceProviderBindingVerified: provenance.sourceProviderBindingVerified,
      tbankCardSpecificAccountProofVerified: provenance.tbankCardSpecificAccountProofVerified,
    })) return null;
  const debit = entry.postings.find((posting) => posting.side === 'DEBIT');
  const credit = entry.postings.find((posting) => posting.side === 'CREDIT');
  if (entry.postings.length !== 2 || debit?.account?.type !== 'SYMBOLIC'
    || debit.account.code !== 'UNCLASSIFIED_PURCHASE'
    || credit?.account?.type !== 'FINANCIAL_ACCOUNT'
    || !positive(credit.account.financialAccountId)) return null;
  return { entry, provenance, financialAccountId: Number(credit.account.financialAccountId) };
}

async function tbankInstrumentProof(client, bankTransactionId, provider, financialAccountId) {
  if (provider !== TBANK_ANDROID_PROVIDER) return null;
  return (await client.query(`SELECT bt.account_reference_kind AS "accountReferenceKind",
      pir.payment_instrument_id AS "paymentInstrumentId",
      pir.resolution_state AS "paymentInstrumentResolutionState",
      pir.provenance AS "paymentInstrumentResolutionProvenance",
      (pi.financial_account_id=$3 AND pi.scope_id=expected_account.scope_id
        AND pi.provider=$2 AND pi.instrument_type='CARD' AND pi.active
        AND mapped_account.id IS NOT NULL AND mapped_account.active
        AND mapped_account.scope_id=pi.scope_id) AS "paymentInstrumentAccountMatchesResolvedAccount",
      EXISTS (SELECT 1 FROM bank_account_references ref
        WHERE ref.provider=$2 AND ref.reference_kind='MASKED_CARD'
          AND ref.reference_value=bt.account_reference
          AND ref.payment_instrument_id=pir.payment_instrument_id
          AND pi.financial_account_id=$3) AS "referenceTargetsResolvedInstrument",
      (SELECT count(DISTINCT candidate_instrument.id)::int
        FROM bank_account_references candidate_reference
        JOIN payment_instruments candidate_instrument ON candidate_instrument.id=candidate_reference.payment_instrument_id
        JOIN financial_accounts candidate_account ON candidate_account.id=candidate_instrument.financial_account_id
        WHERE candidate_reference.provider=$2 AND candidate_reference.reference_kind='MASKED_CARD'
          AND candidate_reference.reference_value=bt.account_reference
          AND candidate_instrument.provider=$2 AND candidate_instrument.instrument_type='CARD'
          AND candidate_instrument.active AND candidate_instrument.scope_id=candidate_account.scope_id
          AND candidate_account.active AND candidate_instrument.scope_id=expected_account.scope_id) AS "uniqueCardReferenceInstrumentCount"
    FROM bank_transactions bt
    LEFT JOIN bank_transaction_payment_instrument_resolution pir ON pir.bank_transaction_id=bt.id
    LEFT JOIN payment_instruments pi ON pi.id=pir.payment_instrument_id
    LEFT JOIN financial_accounts mapped_account ON mapped_account.id=pi.financial_account_id
    JOIN financial_accounts expected_account ON expected_account.id=$3
    WHERE bt.id=$1`, [bankTransactionId, provider, financialAccountId])).rows[0] ?? null;
}

async function persistEntryAtomic(client, { scopeKey, scope, source, purchase, ownerRelations, receiptMatchStatusAtWrite, failAfter }) {
  const eventSemanticKey = hash({ modelVersion: BANK_ONLY_PURCHASE_VERSION, scopeId: Number(scope.id), bankTransactionId: Number(source.bankTransactionId) });
  await client.query(`INSERT INTO business_graph_rules(rule_code,rule_version,description)
    VALUES($1,$2,'Proof-qualified bank-only purchase') ON CONFLICT DO NOTHING`, [BANK_ONLY_PURCHASE_EVENT_RULE, BANK_ONLY_PURCHASE_VERSION]);
  const createdEvent = await client.query(`INSERT INTO business_events(scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
    VALUES($1,'PURCHASE','CONFIRMED','SYSTEM_DERIVED','business-graph-v1',$2,$3,$4,$5,$6,'Proof-qualified bank purchase')
    ON CONFLICT(scope_id,semantic_key,graph_model_version,rule_code,rule_version,origin) DO NOTHING RETURNING id`, [scope.id, BANK_ONLY_PURCHASE_EVENT_RULE, BANK_ONLY_PURCHASE_VERSION, eventSemanticKey, purchase.entry.amount, purchase.entry.currency]);
  const eventRows = (await client.query(`SELECT e.id,e.scope_id,e.event_type,e.resolution_status,e.origin,e.graph_model_version,e.rule_code,e.rule_version,e.semantic_key,e.amount::text AS amount,e.currency,s.scope_key
    FROM business_events e JOIN accounting_scopes s ON s.id=e.scope_id
    WHERE e.scope_id=$1 AND e.semantic_key=$2 AND e.graph_model_version='business-graph-v1'
      AND e.rule_code=$3 AND e.rule_version=$4 AND e.origin='SYSTEM_DERIVED'`, [scope.id, eventSemanticKey, BANK_ONLY_PURCHASE_EVENT_RULE, BANK_ONLY_PURCHASE_VERSION])).rows;
  if (eventRows.length !== 1) throw Object.assign(new Error('BANK_ONLY_EVENT_CONFLICT'), { code: 'BANK_ONLY_EVENT_CONFLICT' });
  const event = eventRows[0];
  const eventId = Number(event.id);
  const tbank = await tbankInstrumentProof(client, source.bankTransactionId, source.provider, purchase.financialAccountId);
  const proof = purchase.provenance;
  const accountProofMethod = source.provider === TBANK_ANDROID_PROVIDER ? 'TBANK_CARD_SPECIFIC' : 'SOURCE_PROVIDER_BINDING';
  const snapshot = {
    modelVersion: BANK_ONLY_PURCHASE_VERSION,
    bankTransactionId: Number(source.bankTransactionId),
    observationId: Number(source.observationId),
    provider: source.provider,
    eventType: 'PURCHASE', direction: 'DEBIT', normalizationStatus: 'READY', evidenceQuality: 'EXACT',
    amount: purchase.entry.amount, currency: purchase.entry.currency, occurredAt: purchase.entry.occurredAt,
    merchant: source.merchant ?? null,
    accountReference: source.accountReference ?? null,
    accountReferenceKind: tbank?.accountReferenceKind ?? source.accountReferenceKind ?? null,
    notificationLifecycleId: source.notificationLifecycleId ?? null,
    receiptMatchStatusAtWrite,
    scopeKey, financialAccountId: purchase.financialAccountId,
    accountResolutionState: proof.accountResolutionState,
    accountResolutionProvenance: proof.accountResolutionProvenance,
    accountProofMethod,
    sourceProviderBindingVerified: proof.sourceProviderBindingVerified === true,
    tbankCardSpecificAccountProofVerified: proof.tbankCardSpecificAccountProofVerified === true,
    paymentInstrumentId: tbank?.paymentInstrumentId == null ? null : Number(tbank.paymentInstrumentId),
    paymentInstrumentResolutionState: tbank?.paymentInstrumentResolutionState ?? null,
    paymentInstrumentResolutionProvenance: tbank?.paymentInstrumentResolutionProvenance ?? null,
    paymentInstrumentAccountMatchesResolvedAccount: tbank?.paymentInstrumentAccountMatchesResolvedAccount === true,
    referenceTargetsResolvedInstrument: tbank?.referenceTargetsResolvedInstrument === true,
    uniqueCardReferenceInstrumentCount: Number(tbank?.uniqueCardReferenceInstrumentCount ?? 0),
    candidateKey: purchase.entry.sourceProvenance.candidateKey,
    journalKey: purchase.entry.sourceProvenance.journalKey,
    ownerRelations,
  };
  const evidenceSha256 = bankOnlyEvidenceSha256(snapshot);
  const evidenceSemanticKey = bankOnlyEvidenceSemanticKey({ scopeId: Number(scope.id), eventId, bankTransactionId: Number(source.bankTransactionId), evidenceSha256 });
  const evidence = (await client.query(`INSERT INTO business_event_bank_evidence(scope_id,business_event_id,bank_transaction_id,financial_account_id,enrichment_key,evidence_role,rule_version,semantic_key,evidence_snapshot,evidence_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`, [scope.id, eventId, source.bankTransactionId, purchase.financialAccountId, evidenceSha256, BANK_ONLY_PURCHASE_EVIDENCE_ROLE, BANK_ONLY_PURCHASE_VERSION, evidenceSemanticKey, JSON.stringify(snapshot), evidenceSha256])).rows[0];
  if (failAfter === 'evidence') throw Object.assign(new Error('INJECTED_BANK_ONLY_WRITER_FAILURE'), { code: 'INJECTED_BANK_ONLY_WRITER_FAILURE' });
  await rebuildLedger(client, { scopeKey, eventIds: [eventId], client });
  if (failAfter === 'ledger') throw Object.assign(new Error('INJECTED_BANK_ONLY_WRITER_FAILURE'), { code: 'INJECTED_BANK_ONLY_WRITER_FAILURE' });
  const ledger = (await client.query(`SELECT e.id FROM ledger_entries e
    JOIN ledger_source_links l ON l.ledger_entry_id=e.id
    WHERE e.scope_id=$1 AND e.source_event_id=$2 AND e.derivation_rule=$3
      AND l.bank_transaction_id=$4 AND l.link_role=$5
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss
        WHERE ss.scope_id=e.scope_id AND ss.superseded_ledger_entry_id=e.id)`, [scope.id, eventId, BANK_ONLY_PURCHASE_LEDGER_RULE, source.bankTransactionId, BANK_ONLY_PURCHASE_EVIDENCE_ROLE])).rows;
  if (ledger.length !== 1) throw Object.assign(new Error('BANK_ONLY_LEDGER_CONFLICT'), { code: 'BANK_ONLY_LEDGER_CONFLICT' });
  const certification = await refreshCertificationForEvents(client, { scopeKey, eventIds: [eventId], client });
  if (failAfter === 'certification') throw Object.assign(new Error('INJECTED_BANK_ONLY_WRITER_FAILURE'), { code: 'INJECTED_BANK_ONLY_WRITER_FAILURE' });
  return { eventId, evidenceId: Number(evidence.id), ledgerEntryId: Number(ledger[0].id), certification };
}

export async function writeBankOnlyPurchase(pool, { bankTransactionId, optIn = readBankOnlyPurchaseLedgerOptIn(), now = new Date(), failAfter = null } = {}) {
  const txId = Number(bankTransactionId);
  if (optIn?.enabled !== true) return { status: 'DISABLED', reasonCode: optIn?.reasonCode ?? 'DISABLED' };
  if (!positive(txId) || !safeScope(optIn.scopeKey) || iso(optIn.startAt) !== optIn.startAt) return blocked('REQUEST_INVALID');
  const scopeKey = safeScope(optIn.scopeKey);
  const cutoff = optIn.startAt;
  const client = await pool.connect();
  let releaseScopeLock = null;
  try {
    releaseScopeLock = await lockMatchedPurchaseScope(client, scopeKey);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await lockMatchedPurchaseScopeTransaction(client, scopeKey);
    await lockMatchedPurchaseBankTransaction(client, txId);
    const scope = (await client.query('SELECT id,scope_key FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
    if (!scope) return await rollbackResult(client, 'SCOPE_NOT_FOUND');
    let source = await eventSourceRow(client, txId);
    if (!source) return await rollbackResult(client, 'BANK_TRANSACTION_NOT_FOUND');
    await lockMatchedPurchaseSourceProvider(client, Number(source.bankSourceId), source.provider);
    source = await eventSourceRow(client, txId);
    if (!source || !source.provider) return await rollbackResult(client, 'BANK_SOURCE_INVALID');
    const alfaStartAt = iso(optIn.alfaStartAt);
    if (source.provider === ALFA_ANDROID_PROVIDER
      && (!alfaStartAt || alfaStartAt !== optIn.alfaStartAt
        || !OPAQUE_NOTIFICATION_LIFECYCLE_ID.test(source.notificationLifecycleId ?? ''))) {
      return await rollbackResult(client, !alfaStartAt ? 'ALFA_PURCHASE_CUTOFF_REQUIRED' : 'ALFA_LIFECYCLE_ID_REQUIRED');
    }
    const observedAt = Date.parse(source.observedAt);
    const occurredAt = Date.parse(source.occurredAt);
    const nowMs = new Date(now).getTime();
    const providerCutoff = source.provider === ALFA_ANDROID_PROVIDER ? Date.parse(alfaStartAt) : Date.parse(cutoff);
    const tooEarly = !Number.isFinite(observedAt) || observedAt < Date.parse(cutoff) || observedAt < providerCutoff;
    if (tooEarly || !Number.isFinite(occurredAt) || !Number.isFinite(nowMs)
      || observedAt > nowMs || occurredAt > nowMs) return await rollbackResult(client, 'OUTSIDE_COHORT');
    const linkedMatch = (await client.query('SELECT id FROM bank_receipt_matches WHERE bank_transaction_id=$1', [txId])).rows;
    if (linkedMatch.length > 1) throw Object.assign(new Error('BANK_MATCH_CONFLICT'), { code: 'BANK_MATCH_CONFLICT' });
    if (linkedMatch.length) return await rollbackResult(client, 'ALREADY_MATCHED');
    const prior = await existingState(client, scope, txId);
    if (prior.existing) {
      await client.query('COMMIT');
      return { status: 'REUSED', reasonCode: 'BANK_ONLY_PURCHASE_ALREADY_ACCOUNTED', eventId: prior.eventId, ledgerEntryId: prior.ledgerEntryId };
    }
    const projection = await loadBankLedgerProjection(client, {
      scopeKey, bankTransactionIds: [txId], maxTimeDeltaMs: INTERNAL_TRANSFER_MAX_TIME_DELTA_MS,
    });
    const purchase = projectedPurchase(projection, txId, scopeKey);
    if (!purchase) return await rollbackResult(client, 'PURCHASE_PROOF_INCOMPLETE');
    const lifecycleState = await existingAlfaLifecycleState(client, { source, purchase, scopeId: Number(scope.id), bankTransactionId: txId });
    if (lifecycleState?.status === 'BLOCKED') return await rollbackResult(client, lifecycleState.reasonCode);
    if (lifecycleState?.status === 'REUSED') {
      await client.query('COMMIT');
      return lifecycleState;
    }
    const receiptMatchStatusAtWrite = await inspectReceiptMatchStatus(client, {
      scopeKey, occurredAt, bankTransactionId: txId,
    });
    const accountId = purchase.financialAccountId;
    const account = (await client.query(`SELECT a.id,a.currency,a.active,s.scope_key
      FROM financial_accounts a JOIN accounting_scopes s ON s.id=a.scope_id WHERE a.id=$1`, [accountId])).rows[0];
    if (!account || Number(account.id) !== accountId || account.currency !== purchase.entry.currency || account.active !== true || account.scope_key !== scopeKey) return await rollbackResult(client, 'ACCOUNT_SCOPE_OR_STATUS_INVALID');
    const owners = await loadBankInternalTransferOwnershipSnapshot(client, [accountId]);
    const ownerAccount = owners.accounts.find((item) => item.financialAccountId === accountId);
    if (!ownerAccount || ownerAccount.accountScopeKey !== scopeKey || !ownerAccount.owners.length
      || ownerAccount.owners.some((owner) => owner.accountScopeKey !== scopeKey || owner.personScopeKey !== scopeKey || owner.relationType !== 'OWNER')) return await rollbackResult(client, 'ACCOUNT_OWNER_PROOF_MISSING');
    const ownerRelations = ownerAccount.owners.map((owner) => ({
      personId: Number(owner.personId), personScopeKey: owner.personScopeKey,
      relationType: owner.relationType, provenance: owner.provenance,
    }));
    const rowCount = (await client.query(`SELECT count(*)::int AS count FROM ledger_source_links
      WHERE bank_transaction_id=$1`, [txId])).rows[0].count;
    if (Number(rowCount) !== 0) return await rollbackResult(client, 'BANK_TRANSACTION_ALREADY_LINKED');
    const persisted = await persistEntryAtomic(client, {
      scopeKey, scope, source, purchase, ownerRelations, receiptMatchStatusAtWrite, failAfter,
    });
    await client.query('COMMIT');
    return {
      status: 'PERSISTED', reasonCode: 'EXACT_BANK_PURCHASE_ACCOUNTED',
      diagnosticCode: receiptMatchDiagnosticCode(receiptMatchStatusAtWrite), ...persisted,
    };
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

async function rollbackResult(client, reasonCode) {
  await client.query('ROLLBACK');
  return blocked(reasonCode);
}

export async function runBankOnlyPurchaseCatchup(pool, { scopeKey = null, optIn = readBankOnlyPurchaseLedgerOptIn(), now = new Date(), logger = console } = {}) {
  if (optIn?.enabled !== true) return { status: 'DISABLED', reasonCode: optIn?.reasonCode ?? 'DISABLED', examined: 0, persisted: 0, reused: 0, blocked: 0 };
  if (scopeKey != null && scopeKey !== optIn.scopeKey) return { status: 'BLOCKED', reasonCode: 'SCOPE_MISMATCH', examined: 0, persisted: 0, reused: 0, blocked: 0 };
  const candidates = (await pool.query(`SELECT bt.id
    FROM bank_transactions bt
    JOIN bank_event_observations eo ON eo.id=bt.observation_id
    WHERE eo.created_at >= $1::timestamptz
      AND eo.created_at <= $2::timestamptz AND bt.occurred_at <= $2::timestamptz
      AND bt.event_type='PURCHASE' AND bt.direction='DEBIT'
      AND bt.normalization_status='READY' AND bt.evidence_quality='EXACT'
      AND bt.amount > 0 AND bt.currency='RUB'
      AND (SELECT count(DISTINCT p.scope_id)
        FROM bank_source_person sp JOIN persons p ON p.id=sp.person_id
        WHERE sp.bank_source_id=eo.bank_source_id)=1
      AND EXISTS (SELECT 1 FROM bank_source_person sp JOIN persons p ON p.id=sp.person_id
        JOIN accounting_scopes s ON s.id=p.scope_id WHERE sp.bank_source_id=eo.bank_source_id
          AND s.scope_key=$3)
      AND NOT EXISTS (SELECT 1 FROM bank_receipt_matches m WHERE m.bank_transaction_id=bt.id)
      AND NOT EXISTS (SELECT 1 FROM business_event_bank_evidence be
        WHERE be.bank_transaction_id=bt.id AND be.evidence_role=$4)
      AND NOT EXISTS (SELECT 1 FROM ledger_source_links l WHERE l.bank_transaction_id=bt.id)
      AND (eo.ingestion_metadata->>'provider' IS DISTINCT FROM $6::text
        OR ($7::timestamptz IS NOT NULL AND eo.created_at >= $7::timestamptz
          AND nullif(eo.ingestion_metadata->>'notificationLifecycleId','') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM bank_event_observations prior_observation
            JOIN bank_transactions prior_transaction ON prior_transaction.observation_id=prior_observation.id
            WHERE prior_observation.bank_source_id=eo.bank_source_id
              AND prior_observation.ingestion_metadata->>'provider'=$6::text
              AND prior_observation.ingestion_metadata->>'notificationLifecycleId'=eo.ingestion_metadata->>'notificationLifecycleId'
              AND prior_transaction.event_type='PURCHASE' AND prior_transaction.direction='DEBIT'
              AND prior_transaction.normalization_status='READY' AND prior_transaction.evidence_quality='EXACT'
              AND (prior_observation.created_at<eo.created_at
                OR (prior_observation.created_at=eo.created_at AND prior_transaction.id<bt.id))
          )))
    ORDER BY eo.created_at,bt.id LIMIT $5`, [optIn.startAt, new Date(now).toISOString(), optIn.scopeKey,
    BANK_ONLY_PURCHASE_EVIDENCE_ROLE, BANK_ONLY_PURCHASE_LEDGER_MAX_CANDIDATES,
    ALFA_ANDROID_PROVIDER, optIn.alfaStartAt ?? null])).rows;
  const result = { status: 'COMPLETED', reasonCode: null, examined: candidates.length, persisted: 0, reused: 0, blocked: 0, errors: 0 };
  for (const row of candidates) {
    if (result.persisted + result.reused >= BANK_ONLY_PURCHASE_LEDGER_MAX_WRITES) break;
    try {
      const outcome = await writeBankOnlyPurchase(pool, { bankTransactionId: Number(row.id), optIn, now });
      if (outcome.status === 'PERSISTED') result.persisted += 1;
      else if (outcome.status === 'REUSED') result.reused += 1;
      else if (outcome.status === 'BLOCKED') result.blocked += 1;
    } catch (error) {
      result.errors += 1;
      result.reasonCode ??= /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'BANK_ONLY_WRITE_FAILED';
    }
  }
  if (result.errors) result.status = 'ERROR';
  logger.info?.('bank_only_purchase_catchup_completed', {
    scopeKey: optIn.scopeKey, status: result.status, examined: result.examined,
    persisted: result.persisted, reused: result.reused, blocked: result.blocked,
    errors: result.errors, reasonCode: result.reasonCode,
  });
  return result;
}

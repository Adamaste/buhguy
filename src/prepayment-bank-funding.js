import { fiscalContentFingerprint } from './fiscal-evidence.js';
import { resolveFnsReceiptCurrency } from './fns-receipt-currency.js';
import { loadBankLedgerProjection } from './bank-ledger-projection.js';
import { loadBankInternalTransferOwnershipSnapshot } from './bank-internal-transfer-matching.js';
import { hasAutomaticMatchedPurchaseAccountProof, TBANK_ANDROID_PROVIDER } from './matched-purchase-account-proof.js';
import { lockMatchedPurchaseBankTransaction, lockMatchedPurchaseScope, lockMatchedPurchaseScopeTransaction, lockMatchedPurchaseSourceProvider } from './matched-purchase-locks.js';
import { isValidBankOnlyPurchaseEvidence, BANK_ONLY_PURCHASE_EVIDENCE_ROLE, BANK_ONLY_PURCHASE_LEDGER_RULE } from './bank-only-purchase-contract.js';
import {
  isValidPrepaymentBankFundingEvidence,
  PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE,
  PREPAYMENT_BANK_FUNDING_LINK_ROLE,
  PREPAYMENT_BANK_FUNDING_SUPERSESSION_REASON,
  PREPAYMENT_BANK_FUNDING_VERSION,
  prepaymentBankFundingSemanticKey,
  prepaymentBankFundingSha256,
} from './prepayment-bank-funding-contract.js';

const PREPAYMENT_RULE = 'PREPAYMENT_SETTLEMENT_V1';
const MATCHER_VERSION = 'prepayment-settlement-matcher-v2';
const GRAPH_VERSION = 'business-graph-v1';
const LEDGER_PREPAYMENT_RULE = 'LEDGER_PREPAYMENT_V1';
const MAX_DELTA_MS = 5 * 60 * 1000;
const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const ISO = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

function cents(value) {
  if (value == null) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

function validStartAt(value) {
  if (value == null || value === '') return null;
  if (!ISO(value)) {
    const error = new Error('PREPAYMENT_SETTLEMENT_START_AT must be a canonical UTC timestamp');
    error.code = 'PREPAYMENT_SETTLEMENT_START_AT_INVALID';
    throw error;
  }
  return value;
}

function blocked(reasonCode) { return { status: 'BLOCKED', reasonCode, examined: 0, persisted: 0, reused: 0, ambiguous: 0 }; }
async function loadLifecycleCandidates(client, scopeKey, startAt) {
  return (await client.query(`SELECT pre.id AS "prepaymentEventId",pre.scope_id AS "scopeId",
      pre.amount::text AS "eventAmount",pre.currency AS "eventCurrency",pre.created_at AS "eventCreatedAt",
      pre_ev.receipt_id AS "receiptId",receipt.date_time AS "receiptAt",
      (SELECT min(observation.observed_at) FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        WHERE observation.receipt_id=receipt.id AND source.scope_id=pre.scope_id) AS "prepaymentReceiptObservedAt",
      receipt.total_sum::text AS "receiptAmount",receipt.currency AS "receiptCurrency",
      pre_fact.fiscal_operation_type AS "operationType",
      settle_fact.fiscal_operation_type AS "settlementOperationType",
      pre_fact.normalization_status AS "normalizationStatus",
      pre_fact.payment_components_status AS "paymentComponentsStatus",
      pre_fact.payment_stage AS "paymentStage",pre_fact.cash_total_sum::text AS "cashTotalSum",
      pre_fact.ecash_total_sum::text AS "ecashTotalSum",pre_fact.prepaid_sum::text AS "prepaidSum",
      pre_fact.credit_sum::text AS "creditSum",pre_fact.provision_sum::text AS "provisionSum",
      EXISTS (SELECT 1 FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        WHERE observation.receipt_id=receipt.id AND source.scope_id=pre.scope_id) AS "fnsSourceProven",
      purchase.id AS "purchaseEventId",fulfillment.id AS "fulfillmentEventId",
      settle_ev.receipt_id AS "settlementReceiptId",settlement.date_time AS "settlementAt",
      (SELECT min(observation.observed_at) FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        WHERE observation.receipt_id=settlement.id AND source.scope_id=pre.scope_id) AS "settlementReceiptObservedAt",
      settlement.total_sum::text AS "settlementAmount",
      settlement.currency AS "settlementCurrency",settle_fact.normalization_status AS "settlementNormalizationStatus",
      settle_fact.payment_components_status AS "settlementComponentsStatus",
      settle_fact.payment_stage AS "settlementPaymentStage",settle_fact.prepaid_sum::text AS "settlementPrepaidSum",
      settle_fact.cash_total_sum::text AS "settlementCashTotalSum",settle_fact.ecash_total_sum::text AS "settlementEcashTotalSum",
      settle_fact.credit_sum::text AS "settlementCreditSum",settle_fact.provision_sum::text AS "settlementProvisionSum",
      EXISTS (SELECT 1 FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        WHERE observation.receipt_id=settlement.id AND source.scope_id=pre.scope_id) AS "settlementFnsSourceProven",
      (SELECT count(*)::int FROM business_event_edges edge
        WHERE edge.scope_id=pre.scope_id AND edge.source_event_id=pre.id
          AND edge.target_event_id=purchase.id AND edge.relation_type='PREPAYMENT_FOR'
          AND edge.resolution_status='CONFIRMED') AS "prepaymentEdgeCount",
      (SELECT count(*)::int FROM business_event_edges edge
        WHERE edge.scope_id=pre.scope_id AND edge.source_event_id=fulfillment.id
          AND edge.target_event_id=purchase.id AND edge.relation_type='FULFILLS'
          AND edge.resolution_status='CONFIRMED') AS "fulfillmentEdgeCount"
    FROM business_events pre
    JOIN business_event_edges pre_edge ON pre_edge.scope_id=pre.scope_id
      AND pre_edge.source_event_id=pre.id AND pre_edge.relation_type='PREPAYMENT_FOR'
      AND pre_edge.resolution_status='CONFIRMED'
    JOIN business_events purchase ON purchase.id=pre_edge.target_event_id
      AND purchase.scope_id=pre.scope_id AND purchase.event_type='PURCHASE'
      AND purchase.resolution_status='CONFIRMED' AND purchase.origin='SYSTEM_DERIVED'
      AND purchase.graph_model_version=$3 AND purchase.rule_code=$4 AND purchase.rule_version=$5
    JOIN business_event_edges settle_edge ON settle_edge.scope_id=pre.scope_id
      AND settle_edge.target_event_id=purchase.id AND settle_edge.relation_type='FULFILLS'
      AND settle_edge.resolution_status='CONFIRMED'
    JOIN business_events fulfillment ON fulfillment.id=settle_edge.source_event_id
      AND fulfillment.scope_id=pre.scope_id AND fulfillment.event_type='FULFILLMENT'
      AND fulfillment.resolution_status='CONFIRMED' AND fulfillment.origin='SYSTEM_DERIVED'
      AND fulfillment.graph_model_version=$3 AND fulfillment.rule_code=$4 AND fulfillment.rule_version=$5
    JOIN business_event_evidence pre_ev ON pre_ev.event_id=pre.id AND pre_ev.evidence_role='PREPAYMENT_EVIDENCE'
    JOIN receipts receipt ON receipt.id=pre_ev.receipt_id
    JOIN receipt_fiscal_facts pre_fact ON pre_fact.receipt_id=receipt.id
      AND pre_fact.normalization_version=pre_ev.normalization_version
    JOIN business_event_evidence settle_ev ON settle_ev.event_id=fulfillment.id
      AND settle_ev.evidence_role='FULFILLMENT_EVIDENCE'
    JOIN receipts settlement ON settlement.id=settle_ev.receipt_id
    JOIN receipt_fiscal_facts settle_fact ON settle_fact.receipt_id=settlement.id
      AND settle_fact.normalization_version=settle_ev.normalization_version
    WHERE pre.scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$1)
      AND pre.event_type='PREPAYMENT' AND pre.resolution_status='CONFIRMED'
      AND pre.origin='SYSTEM_DERIVED' AND pre.graph_model_version=$3
      AND pre.rule_code=$4 AND pre.rule_version=$5
      AND pre.created_at >= $2::timestamptz
      AND (SELECT min(observation.observed_at) FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        WHERE observation.receipt_id=receipt.id AND source.scope_id=pre.scope_id) >= $2::timestamptz
      AND (SELECT min(observation.observed_at) FROM receipt_source_observations observation
        JOIN fns_sources source ON source.id=observation.fns_source_id
        WHERE observation.receipt_id=settlement.id AND source.scope_id=pre.scope_id) >= $2::timestamptz
    ORDER BY receipt.date_time,pre.id`, [scopeKey, startAt, GRAPH_VERSION, PREPAYMENT_RULE, MATCHER_VERSION])).rows;
}

function confirmedLifecycle(row, scopeKey, startAt) {
  if (!row.fnsSourceProven || !row.settlementFnsSourceProven
    || Number(row.operationType) !== 1 || Number(row.settlementOperationType) !== 1
    || row.normalizationStatus !== 'READY' || row.paymentComponentsStatus !== 'RECONCILED'
    || !['PREPAYMENT_ONLY', 'ADVANCE_ONLY'].includes(row.paymentStage)
    || row.settlementNormalizationStatus !== 'READY' || row.settlementComponentsStatus !== 'RECONCILED'
    || row.settlementPaymentStage !== 'SETTLEMENT_ONLY'
    || Number(row.prepaymentEdgeCount) !== 1 || Number(row.fulfillmentEdgeCount) !== 1
    || Date.parse(row.receiptAt) >= Date.parse(row.settlementAt)
    || !row.prepaymentReceiptObservedAt || !row.settlementReceiptObservedAt
    || Date.parse(row.prepaymentReceiptObservedAt) < Date.parse(startAt)
    || Date.parse(row.settlementReceiptObservedAt) < Date.parse(startAt)) return null;
  const currency = resolveFnsReceiptCurrency({ explicitCurrency: row.receiptCurrency, fnsSourceProven: true });
  const settlementCurrency = resolveFnsReceiptCurrency({ explicitCurrency: row.settlementCurrency, fnsSourceProven: true });
  const amountCents = cents(row.receiptAmount);
  const amount = amountCents === null ? null : `${amountCents / 100n}.${String(amountCents % 100n).padStart(2, '0')}`;
  const cashCents = cents(row.cashTotalSum);
  const electronicCents = cents(row.ecashTotalSum);
  const newMoneyCents = cashCents === null || electronicCents === null ? null : cashCents + electronicCents;
  if (currency.status !== 'RESOLVED' || settlementCurrency.status !== 'RESOLVED'
    || currency.currency !== 'RUB' || settlementCurrency.currency !== currency.currency
    || !MONEY.test(amount) || amount === '0.00'
    || cents(row.eventAmount) !== amountCents
    || cents(row.settlementAmount) !== amountCents
    || row.eventCurrency && row.eventCurrency !== currency.currency
    || newMoneyCents !== amountCents
    || cents(row.settlementPrepaidSum) !== amountCents
    || cents(row.settlementCashTotalSum) !== 0n || cents(row.settlementEcashTotalSum) !== 0n
    || cents(row.creditSum) !== 0n || cents(row.provisionSum) !== 0n
    || cents(row.settlementCreditSum) !== 0n || cents(row.settlementProvisionSum) !== 0n) return null;
  return {
    ...row, scopeKey, startAt, currency: currency.currency,
    currencyBasis: currency.basis, amount,
  };
}

async function bankCandidatesForLifecycle(client, lifecycle, scopeId, startAt) {
  return (await client.query(`SELECT bt.id AS "bankTransactionId",bt.occurred_at AS "occurredAt",
      bt.amount::text AS amount,bt.currency,bt.event_type AS "eventType",bt.direction,
      bt.normalization_status AS "normalizationStatus",bt.evidence_quality AS "evidenceQuality",
      eo.id AS "observationId",eo.created_at AS "observedAt",eo.bank_source_id AS "bankSourceId",
      eo.ingestion_metadata->>'provider' AS provider,
      (SELECT count(DISTINCT p.scope_id)::int FROM bank_source_person sp
        JOIN persons p ON p.id=sp.person_id WHERE sp.bank_source_id=eo.bank_source_id
          AND sp.relation_type='OWNER') AS "sourceScopeCount",
      EXISTS (SELECT 1 FROM bank_source_person sp JOIN persons p ON p.id=sp.person_id
        WHERE sp.bank_source_id=eo.bank_source_id AND sp.relation_type='OWNER' AND p.scope_id=$4) AS "sourceInScope",
      EXISTS (SELECT 1 FROM bank_receipt_matches m WHERE m.bank_transaction_id=bt.id) AS matched,
      (SELECT count(*)::int FROM ledger_source_links l WHERE l.bank_transaction_id=bt.id
        AND l.link_role NOT IN ($5,$7)) AS "conflictingLedgerLinks"
    FROM bank_transactions bt JOIN bank_event_observations eo ON eo.id=bt.observation_id
    WHERE bt.amount=$1::numeric AND bt.currency=$2 AND bt.event_type='PURCHASE'
      AND bt.direction='DEBIT' AND bt.normalization_status='READY' AND bt.evidence_quality='EXACT'
      AND bt.occurred_at BETWEEN $3::timestamptz - interval '5 minutes'
        AND $3::timestamptz + interval '5 minutes'
      AND eo.created_at >= $6::timestamptz
      AND EXISTS (SELECT 1 FROM bank_source_person sp JOIN persons p ON p.id=sp.person_id
        WHERE sp.bank_source_id=eo.bank_source_id AND sp.relation_type='OWNER' AND p.scope_id=$4)
    ORDER BY bt.occurred_at,bt.id`, [lifecycle.amount, lifecycle.currency, lifecycle.receiptAt, scopeId,
    PREPAYMENT_BANK_FUNDING_LINK_ROLE, startAt, BANK_ONLY_PURCHASE_EVIDENCE_ROLE])).rows;
}

function purchaseProjection(projection, bankTransactionId, scopeKey) {
  const entries = (projection.entries ?? []).filter((entry) =>
    Number(entry.sourceProvenance?.bankTransactionId) === Number(bankTransactionId));
  if (entries.length !== 1) return null;
  const entry = entries[0];
  const provenance = entry.sourceProvenance?.sourceProvenance;
  if (entry.economicKind !== 'PURCHASE' || entry.scopeKey !== scopeKey
    || !MONEY.test(entry.amount ?? '') || entry.amount === '0.00' || entry.currency !== 'RUB'
    || !SHA256.test(entry.ledgerKey ?? '') || !SHA256.test(entry.sourceProvenance?.candidateKey ?? '')
    || !SHA256.test(entry.sourceProvenance?.journalKey ?? '')
    || !provenance || provenance.sourceMovementType !== 'PURCHASE'
    || provenance.sourceProjectionStatus !== 'PROJECTED'
    || !hasAutomaticMatchedPurchaseAccountProof({
      provider: provenance.provider,
      sourceProviderBindingVerified: provenance.sourceProviderBindingVerified,
      tbankCardSpecificAccountProofVerified: provenance.tbankCardSpecificAccountProofVerified,
    })) return null;
  if (provenance.provider === 'ru.alfabank.mobile.android'
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(provenance.notificationLifecycleId ?? '')) return null;
  const debit = entry.postings.find((posting) => posting.side === 'DEBIT');
  const credit = entry.postings.find((posting) => posting.side === 'CREDIT');
  if (entry.postings.length !== 2 || debit?.account?.type !== 'SYMBOLIC'
    || debit.account.code !== 'UNCLASSIFIED_PURCHASE'
    || credit?.account?.type !== 'FINANCIAL_ACCOUNT'
    || !Number.isSafeInteger(Number(credit.account.financialAccountId))) return null;
  return { entry, provenance, financialAccountId: Number(credit.account.financialAccountId) };
}

async function validatedOwnerProof(client, financialAccountId, scopeKey) {
  const account = (await client.query(`SELECT a.id,a.scope_id,a.currency,a.active,s.scope_key
    FROM financial_accounts a JOIN accounting_scopes s ON s.id=a.scope_id WHERE a.id=$1`, [financialAccountId])).rows[0];
  if (!account || account.active !== true || account.currency !== 'RUB' || account.scope_key !== scopeKey) return null;
  const snapshot = await loadBankInternalTransferOwnershipSnapshot(client, [financialAccountId]);
  const ownerAccount = snapshot.accounts.find((item) => item.financialAccountId === Number(financialAccountId));
  if (!ownerAccount || ownerAccount.accountScopeKey !== scopeKey || ownerAccount.owners.length === 0
    || ownerAccount.owners.some((owner) => owner.accountScopeKey !== scopeKey
      || owner.personScopeKey !== scopeKey || owner.relationType !== 'OWNER')) return null;
  return { status: 'PROVEN', ownerRelationCount: ownerAccount.owners.length };
}

async function eventAndEvidence(client, scopeId, eventId, bankTransactionId) {
  return (await client.query(`SELECT e.id,e.scope_id,e.event_type,e.resolution_status,e.origin,
      e.graph_model_version,e.rule_code,e.rule_version,e.amount::text AS amount,e.currency,
      s.scope_key,be.id AS evidence_id,be.bank_transaction_id,be.financial_account_id,
      be.evidence_role,be.rule_version AS evidence_rule_version,be.semantic_key,
      be.evidence_snapshot,be.evidence_sha256
    FROM business_events e JOIN accounting_scopes s ON s.id=e.scope_id
    LEFT JOIN business_event_bank_evidence be ON be.scope_id=e.scope_id
      AND be.business_event_id=e.id AND be.bank_transaction_id=$3
      AND be.evidence_role=$4
    WHERE e.scope_id=$1 AND e.id=$2`, [scopeId, eventId, bankTransactionId,
    PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE])).rows[0] ?? null;
}

function validateFundingRow(row) {
  if (!row?.evidence_id) return false;
  return isValidPrepaymentBankFundingEvidence(row, {
    evidence_role: row.evidence_role,
    rule_version: row.evidence_rule_version,
    business_event_id: row.id,
    scope_id: row.scope_id,
    bank_transaction_id: row.bank_transaction_id,
    financial_account_id: row.financial_account_id,
    semantic_key: row.semantic_key,
    evidence_snapshot: row.evidence_snapshot,
    evidence_sha256: row.evidence_sha256,
    bank_receipt_match_id: null,
  });
}

async function persistFundingEvidence(client, scopeId, lifecycle, bankRow, purchase, ownerProof) {
  const sameLifecycle = (await client.query(`SELECT id,scope_id,business_event_id,bank_transaction_id,
      financial_account_id,evidence_role,rule_version,semantic_key,evidence_snapshot,evidence_sha256,bank_receipt_match_id
    FROM business_event_bank_evidence
    WHERE scope_id=$1 AND evidence_role=$2 AND (business_event_id=$3 OR bank_transaction_id=$4)
    ORDER BY id`, [scopeId, PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE, lifecycle.prepaymentEventId,
    bankRow.bankTransactionId])).rows;
  if (sameLifecycle.length) {
    if (sameLifecycle.length !== 1 || Number(sameLifecycle[0].business_event_id) !== Number(lifecycle.prepaymentEventId)
      || Number(sameLifecycle[0].bank_transaction_id) !== Number(bankRow.bankTransactionId)) {
      throw Object.assign(new Error('PREPAYMENT_BANK_FUNDING_CONFLICT'), { code: 'PREPAYMENT_BANK_FUNDING_CONFLICT' });
    }
    const event = await eventAndEvidence(client, scopeId, lifecycle.prepaymentEventId, bankRow.bankTransactionId);
    if (!validateFundingRow(event)) throw Object.assign(new Error('PREPAYMENT_BANK_FUNDING_EVIDENCE_INVALID'), { code: 'PREPAYMENT_BANK_FUNDING_EVIDENCE_INVALID' });
    return { row: event, created: false };
  }

  const ownerScopeProof = await validatedOwnerProof(client, purchase.financialAccountId, lifecycle.scopeKey);
  if (!ownerScopeProof) return { blocked: 'ACCOUNT_OWNER_PROOF_MISSING' };
  const provenance = purchase.provenance;
  const accountProofMethod = provenance.provider === TBANK_ANDROID_PROVIDER ? 'TBANK_CARD_SPECIFIC' : 'SOURCE_PROVIDER_BINDING';
  const snapshot = {
    modelVersion: PREPAYMENT_BANK_FUNDING_VERSION,
    scopeKey: lifecycle.scopeKey,
    prepaymentEventId: Number(lifecycle.prepaymentEventId),
    receiptId: Number(lifecycle.receiptId),
    bankTransactionId: Number(bankRow.bankTransactionId),
    observationId: Number(bankRow.observationId),
    provider: provenance.provider,
    eventType: 'PURCHASE', direction: 'DEBIT', normalizationStatus: 'READY',
    paymentComponentsStatus: 'RECONCILED', paymentStage: lifecycle.paymentStage,
    amount: lifecycle.amount, currency: lifecycle.currency, occurredAt: new Date(bankRow.occurredAt).toISOString(),
    observedAt: new Date(bankRow.observedAt).toISOString(),
    prepaymentEventCreatedAt: new Date(lifecycle.eventCreatedAt).toISOString(),
    prepaymentSourceObservedAt: new Date(lifecycle.prepaymentReceiptObservedAt).toISOString(),
    settlementSourceObservedAt: new Date(lifecycle.settlementReceiptObservedAt).toISOString(),
    prepaymentReceiptAt: new Date(lifecycle.receiptAt).toISOString(),
    cohortStartAt: lifecycle.startAt,
    timeDeltaMs: Date.parse(bankRow.occurredAt) - Date.parse(lifecycle.receiptAt),
    financialAccountId: purchase.financialAccountId,
    accountResolutionState: provenance.accountResolutionState,
    accountResolutionProvenance: provenance.accountResolutionProvenance,
    evidenceQuality: bankRow.evidenceQuality,
    accountProofMethod,
    sourceProviderBindingVerified: provenance.sourceProviderBindingVerified === true,
    tbankCardSpecificAccountProofVerified: provenance.tbankCardSpecificAccountProofVerified === true,
    notificationLifecycleIdVerified: provenance.provider === 'ru.alfabank.mobile.android'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(provenance.notificationLifecycleId ?? ''),
    accountOwnerScopeProof: ownerScopeProof,
    fnsSourceProven: true,
    fnsCurrencyBasis: lifecycle.currencyBasis,
    fiscalOperationType: 1,
    settlementPaymentStage: 'SETTLEMENT_ONLY',
    candidateKey: purchase.entry.sourceProvenance.candidateKey,
    journalKey: purchase.entry.sourceProvenance.journalKey,
  };
  const evidenceSha256 = prepaymentBankFundingSha256(snapshot);
  const semanticKey = prepaymentBankFundingSemanticKey({ scopeId, eventId: lifecycle.prepaymentEventId,
    bankTransactionId: bankRow.bankTransactionId, evidenceSha256 });
  const result = await client.query(`INSERT INTO business_event_bank_evidence(scope_id,business_event_id,
      bank_transaction_id,financial_account_id,enrichment_key,evidence_role,rule_version,semantic_key,evidence_snapshot,evidence_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`, [scopeId,
    lifecycle.prepaymentEventId, bankRow.bankTransactionId, purchase.financialAccountId,
    evidenceSha256, PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE, PREPAYMENT_BANK_FUNDING_VERSION,
    semanticKey, JSON.stringify(snapshot), evidenceSha256]);
  const row = await eventAndEvidence(client, scopeId, lifecycle.prepaymentEventId, bankRow.bankTransactionId);
  if (!validateFundingRow(row)) throw Object.assign(new Error('PREPAYMENT_BANK_FUNDING_EVIDENCE_INVALID'), { code: 'PREPAYMENT_BANK_FUNDING_EVIDENCE_INVALID' });
  return { row, created: result.rowCount === 1 };
}

async function ensurePrepaymentLedgerLink(client, scopeId, lifecycle, bankRow, evidence) {
  const entries = (await client.query(`SELECT e.id,e.source_event_id,e.scope_id,e.derivation_rule,e.derivation_status,
      e.currency,e.semantic_key,e.origin
    FROM ledger_entries e WHERE e.scope_id=$1 AND e.source_event_id=$2
      AND e.derivation_rule=$3 AND e.origin='SYSTEM_DERIVED'
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s
        WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)
    ORDER BY e.id`, [scopeId, lifecycle.prepaymentEventId, LEDGER_PREPAYMENT_RULE])).rows;
  if (entries.length !== 1 || entries[0].derivation_status !== 'READY' || entries[0].currency !== lifecycle.currency) {
    throw Object.assign(new Error('PREPAYMENT_LEDGER_ENTRY_NOT_UNIQUE'), { code: 'PREPAYMENT_LEDGER_ENTRY_NOT_UNIQUE' });
  }
  const entry = entries[0];
  const postings = (await client.query(`SELECT a.account_code,p.currency,p.debit::text,p.credit::text
    FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
    WHERE p.ledger_entry_id=$1 ORDER BY a.account_code`, [entry.id])).rows;
  const expectedAmount = lifecycle.amount;
  if (postings.length !== 2 || !postings.some((p) => p.account_code === 'MERCHANT_ADVANCE'
      && p.currency === lifecycle.currency && p.debit === expectedAmount && p.credit === '0.00')
    || !postings.some((p) => p.account_code === 'FISCAL_PAYMENT_CLEARING'
      && p.currency === lifecycle.currency && p.debit === '0.00' && p.credit === expectedAmount)) {
    throw Object.assign(new Error('PREPAYMENT_LEDGER_POSTINGS_CONFLICT'), { code: 'PREPAYMENT_LEDGER_POSTINGS_CONFLICT' });
  }
  const fulfillmentEntries = (await client.query(`SELECT e.id,e.currency,e.derivation_status
    FROM ledger_entries e WHERE e.scope_id=$1 AND e.source_event_id=$2
      AND e.derivation_rule='LEDGER_FULFILLMENT_V1' AND e.origin='SYSTEM_DERIVED'
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s
        WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)
    ORDER BY e.id`, [scopeId, lifecycle.fulfillmentEventId])).rows;
  if (fulfillmentEntries.length !== 1 || fulfillmentEntries[0].currency !== lifecycle.currency
    || fulfillmentEntries[0].derivation_status !== 'READY') {
    throw Object.assign(new Error('PREPAYMENT_FULFILLMENT_LEDGER_ENTRY_NOT_UNIQUE'), { code: 'PREPAYMENT_FULFILLMENT_LEDGER_ENTRY_NOT_UNIQUE' });
  }
  const fulfillmentPostings = (await client.query(`SELECT a.account_code,p.currency,p.debit::text,p.credit::text
    FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
    WHERE p.ledger_entry_id=$1 ORDER BY a.account_code`, [fulfillmentEntries[0].id])).rows;
  if (fulfillmentPostings.length !== 2 || !fulfillmentPostings.some((p) => p.account_code === 'UNCLASSIFIED_ACQUISITION'
      && p.currency === lifecycle.currency && p.debit === expectedAmount && p.credit === '0.00')
    || !fulfillmentPostings.some((p) => p.account_code === 'MERCHANT_ADVANCE'
      && p.currency === lifecycle.currency && p.debit === '0.00' && p.credit === expectedAmount)) {
    throw Object.assign(new Error('PREPAYMENT_FULFILLMENT_LEDGER_POSTINGS_CONFLICT'), { code: 'PREPAYMENT_FULFILLMENT_LEDGER_POSTINGS_CONFLICT' });
  }
  const fiscalEvidence = (await client.query(`SELECT id FROM business_event_evidence
    WHERE event_id=$1 AND receipt_id=$2 AND evidence_role='PREPAYMENT_EVIDENCE'
    ORDER BY id`, [lifecycle.prepaymentEventId, lifecycle.receiptId])).rows;
  if (fiscalEvidence.length !== 1) throw Object.assign(new Error('PREPAYMENT_FISCAL_EVIDENCE_NOT_UNIQUE'), { code: 'PREPAYMENT_FISCAL_EVIDENCE_NOT_UNIQUE' });
  const material = {
    ledgerEntryId: Number(entry.id), businessEventId: Number(lifecycle.prepaymentEventId),
    graphEvidenceId: Number(fiscalEvidence[0].id), graphAllocationId: null,
    receiptId: Number(lifecycle.receiptId), role: PREPAYMENT_BANK_FUNDING_LINK_ROLE,
    bankTransactionId: Number(bankRow.bankTransactionId),
  };
  const semanticKey = fiscalContentFingerprint(material);
  const prior = (await client.query(`SELECT id,ledger_entry_id,business_event_id,graph_evidence_id,
      graph_allocation_id,receipt_id,normalization_version,link_role,semantic_key,bank_transaction_id
    FROM ledger_source_links WHERE (bank_transaction_id=$1 AND link_role=$3) OR semantic_key=$2 ORDER BY id`,
  [bankRow.bankTransactionId, semanticKey, PREPAYMENT_BANK_FUNDING_LINK_ROLE])).rows;
  if (prior.length) {
    const exact = prior.length === 1 && Number(prior[0].ledger_entry_id) === Number(entry.id)
      && Number(prior[0].business_event_id) === Number(lifecycle.prepaymentEventId)
      && Number(prior[0].graph_evidence_id) === Number(fiscalEvidence[0].id)
      && prior[0].graph_allocation_id == null && Number(prior[0].receipt_id) === Number(lifecycle.receiptId)
      && prior[0].link_role === PREPAYMENT_BANK_FUNDING_LINK_ROLE
      && prior[0].semantic_key === semanticKey && Number(prior[0].bank_transaction_id) === Number(bankRow.bankTransactionId);
    if (!exact) throw Object.assign(new Error('PREPAYMENT_BANK_LEDGER_LINK_CONFLICT'), { code: 'PREPAYMENT_BANK_LEDGER_LINK_CONFLICT' });
    return { entryId: Number(entry.id), created: false };
  }
  await client.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,
      graph_allocation_id,receipt_id,normalization_version,link_role,semantic_key,bank_transaction_id)
    VALUES($1,$2,$3,NULL,$4,'fiscal-normalizer-v1',$5,$6,$7)`, [entry.id,
    lifecycle.prepaymentEventId, fiscalEvidence[0].id, lifecycle.receiptId,
    PREPAYMENT_BANK_FUNDING_LINK_ROLE, semanticKey, bankRow.bankTransactionId]);
  return { entryId: Number(entry.id), created: true };
}

async function bankOnlyLedger(client, scopeId, lifecycle, bankRow, purchase) {
  const evidenceRows = (await client.query(`SELECT be.id,be.scope_id,be.business_event_id,be.bank_transaction_id,
      be.financial_account_id,be.evidence_role,be.rule_version,be.semantic_key,be.evidence_snapshot,
      be.evidence_sha256,be.bank_receipt_match_id,e.id AS event_id,e.event_type,e.resolution_status,e.origin,
      e.graph_model_version,e.rule_code,e.rule_version AS event_rule_version,e.amount::text AS event_amount,
      e.currency,s.scope_key
    FROM business_event_bank_evidence be JOIN business_events e ON e.id=be.business_event_id
    JOIN accounting_scopes s ON s.id=e.scope_id
    WHERE be.scope_id=$1 AND be.bank_transaction_id=$2 AND be.evidence_role=$3`,
  [scopeId, bankRow.bankTransactionId, BANK_ONLY_PURCHASE_EVIDENCE_ROLE])).rows;
  if (evidenceRows.length > 1) throw Object.assign(new Error('BANK_ONLY_EVIDENCE_CONFLICT'), { code: 'BANK_ONLY_EVIDENCE_CONFLICT' });
  if (!evidenceRows.length) return null;
  const row = evidenceRows[0];
  const event = { id: Number(row.event_id), scope_id: Number(row.scope_id), scope_key: row.scope_key,
    event_type: row.event_type, resolution_status: row.resolution_status, origin: row.origin,
    graph_model_version: row.graph_model_version, rule_code: row.rule_code, rule_version: row.event_rule_version,
    amount: row.event_amount, currency: row.currency };
  if (!isValidBankOnlyPurchaseEvidence(event, row)
    || Number(row.financial_account_id) !== Number(purchase.financialAccountId)
    || String(row.evidence_snapshot?.amount) !== lifecycle.amount
    || row.evidence_snapshot?.currency !== lifecycle.currency) {
    throw Object.assign(new Error('BANK_ONLY_PREPAYMENT_REFINEMENT_EVIDENCE_INVALID'), { code: 'BANK_ONLY_PREPAYMENT_REFINEMENT_EVIDENCE_INVALID' });
  }
  const entries = (await client.query(`SELECT DISTINCT entry.id,entry.source_event_id,entry.currency,
      entry.derivation_rule,entry.derivation_status
    FROM ledger_entries entry JOIN ledger_source_links link ON link.ledger_entry_id=entry.id
    WHERE entry.scope_id=$1 AND entry.source_event_id=$2 AND entry.derivation_rule=$3
      AND link.bank_transaction_id=$4 AND link.link_role=$5
    ORDER BY entry.id`, [scopeId, row.business_event_id, BANK_ONLY_PURCHASE_LEDGER_RULE,
    bankRow.bankTransactionId, BANK_ONLY_PURCHASE_EVIDENCE_ROLE])).rows;
  if (entries.length !== 1 || entries[0].currency !== lifecycle.currency || entries[0].derivation_status !== 'READY') {
    throw Object.assign(new Error('BANK_ONLY_PREPAYMENT_REFINEMENT_LEDGER_INVALID'), { code: 'BANK_ONLY_PREPAYMENT_REFINEMENT_LEDGER_INVALID' });
  }
  const oldEntry = entries[0];
  const postings = (await client.query(`SELECT a.account_code,p.currency,p.debit::text,p.credit::text
    FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
    WHERE p.ledger_entry_id=$1 ORDER BY a.account_code`, [oldEntry.id])).rows;
  if (postings.length !== 2 || !postings.some((p) => p.account_code === 'UNCLASSIFIED_ACQUISITION'
      && p.currency === lifecycle.currency && p.debit === lifecycle.amount && p.credit === '0.00')
    || !postings.some((p) => p.account_code === `FINANCIAL_ACCOUNT:${purchase.financialAccountId}`
      && p.currency === lifecycle.currency && p.debit === '0.00' && p.credit === lifecycle.amount)) {
    throw Object.assign(new Error('BANK_ONLY_PREPAYMENT_REFINEMENT_POSTINGS_INVALID'), { code: 'BANK_ONLY_PREPAYMENT_REFINEMENT_POSTINGS_INVALID' });
  }
  return { oldEntryId: Number(oldEntry.id), oldEventId: Number(row.business_event_id) };
}

async function persistSupersession(client, scopeId, bankRow, lifecycle, fundingEvidence, replacementEntryId, oldEntry) {
  if (!oldEntry) return { created: false };
  if (Number(oldEntry.oldEventId) === Number(lifecycle.prepaymentEventId)
    || Number(oldEntry.oldEntryId) === Number(replacementEntryId)) {
    throw Object.assign(new Error('BANK_ONLY_PREPAYMENT_SUPERSESSION_CONFLICT'), { code: 'BANK_ONLY_PREPAYMENT_SUPERSESSION_CONFLICT' });
  }
  const enrichmentKey = prepaymentBankFundingSha256({
    modelVersion: PREPAYMENT_BANK_FUNDING_VERSION,
    bankTransactionId: Number(bankRow.bankTransactionId),
    prepaymentEventId: Number(lifecycle.prepaymentEventId),
    bankOnlyEventId: Number(oldEntry.oldEventId),
    fundingEvidenceSha256: String(fundingEvidence.evidence_sha256).trim().toLowerCase(),
  });
  const semanticKey = fiscalContentFingerprint({
    modelVersion: PREPAYMENT_BANK_FUNDING_VERSION, scopeId: Number(scopeId),
    supersededLedgerEntryId: Number(oldEntry.oldEntryId),
    replacementLedgerEntryId: Number(replacementEntryId),
    businessEventId: Number(lifecycle.prepaymentEventId), enrichmentKey,
  });
  const prior = (await client.query(`SELECT id,scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,
      business_event_id,enrichment_key,semantic_key,reason_code
    FROM ledger_entry_supersessions
    WHERE scope_id=$1 AND (superseded_ledger_entry_id=$2 OR replacement_ledger_entry_id=$3)
    ORDER BY id`, [scopeId, oldEntry.oldEntryId, replacementEntryId])).rows;
  if (prior.length) {
    if (prior.length !== 1 || Number(prior[0].superseded_ledger_entry_id) !== Number(oldEntry.oldEntryId)
      || Number(prior[0].replacement_ledger_entry_id) !== Number(replacementEntryId)
      || Number(prior[0].business_event_id) !== Number(lifecycle.prepaymentEventId)
      || prior[0].enrichment_key !== enrichmentKey || prior[0].semantic_key !== semanticKey
      || prior[0].reason_code !== PREPAYMENT_BANK_FUNDING_SUPERSESSION_REASON) {
      throw Object.assign(new Error('BANK_ONLY_PREPAYMENT_SUPERSESSION_CONFLICT'), { code: 'BANK_ONLY_PREPAYMENT_SUPERSESSION_CONFLICT' });
    }
    return { created: false };
  }
  const cycle = await client.query(`WITH RECURSIVE chain(id) AS (
      SELECT $2::bigint UNION
      SELECT s.replacement_ledger_entry_id FROM ledger_entry_supersessions s
      JOIN chain c ON c.id=s.superseded_ledger_entry_id WHERE s.scope_id=$1
    ) SELECT 1 FROM chain WHERE id=$3`, [scopeId, replacementEntryId, oldEntry.oldEntryId]);
  if (cycle.rowCount) throw Object.assign(new Error('BANK_ONLY_PREPAYMENT_SUPERSESSION_CYCLE'), { code: 'BANK_ONLY_PREPAYMENT_SUPERSESSION_CYCLE' });
  await client.query(`INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,
      replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [scopeId, oldEntry.oldEntryId, replacementEntryId,
    lifecycle.prepaymentEventId, enrichmentKey, semanticKey, PREPAYMENT_BANK_FUNDING_SUPERSESSION_REASON]);
  return { created: true };
}

async function persistUniquePair(client, scopeId, lifecycle, bankRow, purchase) {
  await lockMatchedPurchaseBankTransaction(client, Number(bankRow.bankTransactionId));
  await lockMatchedPurchaseSourceProvider(client, Number(bankRow.bankSourceId), bankRow.provider);
  const ownerProof = await validatedOwnerProof(client, purchase.financialAccountId, lifecycle.scopeKey);
  if (!ownerProof) return { blocked: 'ACCOUNT_OWNER_PROOF_MISSING' };
  const funding = await persistFundingEvidence(client, scopeId, lifecycle, bankRow, purchase, ownerProof);
  if (funding.blocked) return funding;
  const ledgerLink = await ensurePrepaymentLedgerLink(client, scopeId, lifecycle, bankRow, funding.row);
  const oldEntry = await bankOnlyLedger(client, scopeId, lifecycle, bankRow, purchase);
  const supersession = await persistSupersession(client, scopeId, bankRow, lifecycle, funding.row,
    ledgerLink.entryId, oldEntry);
  if (oldEntry) {
    const activeOldEntry = await client.query(`SELECT 1 FROM ledger_entries entry
      JOIN ledger_source_links link ON link.ledger_entry_id=entry.id
      WHERE entry.id=$1 AND link.bank_transaction_id=$2
        AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss
          WHERE ss.scope_id=entry.scope_id AND ss.superseded_ledger_entry_id=entry.id)`,
    [oldEntry.oldEntryId, bankRow.bankTransactionId]);
    if (activeOldEntry.rowCount !== 0) throw Object.assign(new Error('BANK_ONLY_PREPAYMENT_SUPERSESSION_NOT_ACTIVE'), { code: 'BANK_ONLY_PREPAYMENT_SUPERSESSION_NOT_ACTIVE' });
  }
  return { created: funding.created, linkCreated: ledgerLink.created, superseded: supersession.created };
}

export async function reconcilePrepaymentBankFunding(pool, { scopeKey = 'default', startAt = null, targets = null } = {}) {
  if (targets !== null && (!Array.isArray(targets) || targets.length === 0
      || targets.some(target => !target || ['prepaymentReceiptId', 'settlementReceiptId', 'bankTransactionId']
        .some(key => !Number.isSafeInteger(target[key]) || target[key] <= 0))
      || ['prepaymentReceiptId', 'settlementReceiptId', 'bankTransactionId']
        .some(key => new Set(targets.map(target => target[key])).size !== targets.length))) {
    throw Object.assign(new Error('Explicit funding targets must contain unique positive safe integer IDs'),
      { code: 'PREPAYMENT_FUNDING_TARGETS_INVALID' });
  }
  const cutoff = validStartAt(startAt);
  if (!cutoff) return { status: 'DISABLED', reasonCode: 'PREPAYMENT_SETTLEMENT_START_AT_UNSET', examined: 0, persisted: 0, reused: 0, ambiguous: 0, blocked: 0 };
  const client = await pool.connect();
  let releaseScopeLock = null;
  try {
    releaseScopeLock = await lockMatchedPurchaseScope(client, scopeKey);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await lockMatchedPurchaseScopeTransaction(client, scopeKey);
    const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
    if (!scope) { await client.query('ROLLBACK'); return blocked('ACCOUNTING_SCOPE_NOT_FOUND'); }
    const rows = await loadLifecycleCandidates(client, scopeKey, cutoff);
    const lifecycles = rows.map((row) => confirmedLifecycle(row, scopeKey, cutoff)).filter(Boolean);
    const adjacency = new Map();
    const bankRows = new Map();
    for (const lifecycle of lifecycles) {
      const candidates = await bankCandidatesForLifecycle(client, lifecycle, Number(scope.id), cutoff);
      adjacency.set(Number(lifecycle.prepaymentEventId), []);
      for (const candidate of candidates) {
        const transactionId = Number(candidate.bankTransactionId);
        bankRows.set(transactionId, candidate);
        adjacency.get(Number(lifecycle.prepaymentEventId)).push(transactionId);
      }
    }
    const projection = bankRows.size
      ? await loadBankLedgerProjection(client, { scopeKey, bankTransactionIds: [...bankRows.keys()], maxTimeDeltaMs: MAX_DELTA_MS })
      : { entries: [] };
    const transactionToLifecycleIds = new Map();
    for (const [eventId, ids] of adjacency) for (const id of ids) {
      transactionToLifecycleIds.set(id, [...(transactionToLifecycleIds.get(id) ?? []), eventId]);
    }
    const result = { status: 'COMPLETED', reasonCode: null, examined: 0, persisted: 0, reused: 0, ambiguous: 0, blocked: 0, superseded: 0 };
    for (const lifecycle of lifecycles) {
      const eventId = Number(lifecycle.prepaymentEventId);
      const target = targets?.find(item => item.prepaymentReceiptId === Number(lifecycle.receiptId)
        && item.settlementReceiptId === Number(lifecycle.settlementReceiptId));
      if (targets !== null && !target) continue;
      const ids = adjacency.get(eventId) ?? [];
      if (!ids.length) continue;
      result.examined += ids.length;
      if (ids.length !== 1 || transactionToLifecycleIds.get(ids[0])?.length !== 1) {
        result.ambiguous += 1;
        continue;
      }
      // Select writes only after building and checking the full competition graph.
      // An allowlist must never hide an alternative bank or lifecycle candidate.
      if (target && ids[0] !== target.bankTransactionId) {
        result.blocked += 1;
        continue;
      }
      const bankRow = bankRows.get(ids[0]);
      const purchase = purchaseProjection(projection, ids[0], scopeKey);
      if (!purchase || bankRow.sourceScopeCount !== 1 || bankRow.sourceInScope !== true
        || bankRow.matched === true || Number(bankRow.conflictingLedgerLinks) > 0
        || String(bankRow.amount) !== lifecycle.amount || bankRow.currency !== lifecycle.currency
        || Math.abs(Date.parse(bankRow.occurredAt) - Date.parse(lifecycle.receiptAt)) > MAX_DELTA_MS
        || Date.parse(bankRow.observedAt) < Date.parse(cutoff)
        || !ISO(new Date(bankRow.observedAt).toISOString())
        || Number(purchase.financialAccountId) <= 0) {
        result.blocked += 1;
        continue;
      }
      const outcome = await persistUniquePair(client, Number(scope.id), lifecycle, bankRow, purchase);
      if (outcome.blocked) result.blocked += 1;
      else if (outcome.created) result.persisted += 1;
      else result.reused += 1;
      if (outcome.superseded) result.superseded += 1;
    }
    await client.query('COMMIT');
    return result;
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

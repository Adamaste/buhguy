import { fiscalContentFingerprint } from './fiscal-evidence.js';
import { refreshCertificationForEvents } from './certification.js';
import { lockMatchedPurchaseScope, lockMatchedPurchaseScopeTransaction } from './matched-purchase-locks.js';
import { BANK_ONLY_PURCHASE_EVIDENCE_ROLE, BANK_ONLY_PURCHASE_EVENT_RULE, BANK_ONLY_PURCHASE_LEDGER_RULE, isValidBankOnlyPurchaseEvidence } from './bank-only-purchase-contract.js';

export const LEDGER_MODEL_VERSION = 'ledger-v1';
export const LEDGER_ORIGIN = 'SYSTEM_DERIVED';
export const LEDGER_CURRENCY = 'RUB';

export const LEDGER_RULES = Object.freeze({
  PREPAYMENT: 'LEDGER_PREPAYMENT_V1',
  FULFILLMENT: 'LEDGER_FULFILLMENT_V1',
  STANDALONE_PURCHASE: 'LEDGER_STANDALONE_PURCHASE_V1',
  RETURN: 'LEDGER_RETURN_V1',
  REFUND: 'LEDGER_REFUND_V1',
  BANK_ONLY_PURCHASE: BANK_ONLY_PURCHASE_LEDGER_RULE,
  UNSUPPORTED: 'LEDGER_UNSUPPORTED_V1',
});

export const LEDGER_ACCOUNTS = Object.freeze({
  MERCHANT_ADVANCE: { type: 'ASSET', description: 'Value prepaid to a merchant before fulfillment' },
  FISCAL_PAYMENT_CLEARING: { type: 'CONTROL', description: 'Fiscal new-money evidence pending bank/cash reconciliation' },
  UNCLASSIFIED_ACQUISITION: { type: 'CONTROL', description: 'Confirmed acquisition pending final expense/asset classification' },
  MERCHANT_REFUND_RECEIVABLE: { type: 'RECEIVABLE', description: 'Merchant refund receivable before monetary refund is proven' },
});

const amount = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : null;
};
const numeric = (value) => Number(value ?? 0);
const sum = (values) => values.reduce((total, value) => total + numeric(value), 0).toFixed(2);

function evidenceByEvent(evidence) {
  const result = new Map();
  for (const row of evidence) result.set(Number(row.event_id), [...(result.get(Number(row.event_id)) ?? []), row]);
  return result;
}

function factsForEvidence(row) {
  return {
    receiptId: row.receipt_id === null ? null : Number(row.receipt_id),
    evidenceId: Number(row.evidence_id),
    dateTime: row.date_time,
    normalizationVersion: row.normalization_version,
    status: row.normalization_status,
    cash: row.cash_total_sum,
    ecash: row.ecash_total_sum,
    prepaid: row.prepaid_sum,
    credit: row.credit_sum,
    provision: row.provision_sum,
    componentStatus: row.payment_components_status,
  };
}

export function deriveLedgerEntries({ events, evidence, allocations, edges, bankEvidence = [] }) {
  const evidenceMap = evidenceByEvent(evidence);
  const bankEvidenceMap = new Map();
  for (const row of bankEvidence) bankEvidenceMap.set(Number(row.business_event_id), [...(bankEvidenceMap.get(Number(row.business_event_id)) ?? []), row]);
  const incoming = new Map();
  for (const edge of edges) incoming.set(Number(edge.target_event_id), [...(incoming.get(Number(edge.target_event_id)) ?? []), edge]);
  const outgoing = new Map();
  for (const edge of edges) outgoing.set(Number(edge.source_event_id), [...(outgoing.get(Number(edge.source_event_id)) ?? []), edge]);
  const allocationsMap = new Map();
  for (const allocation of allocations) allocationsMap.set(Number(allocation.target_event_id), [...(allocationsMap.get(Number(allocation.target_event_id)) ?? []), allocation]);
  const entries = [];
  const confirmed = events.filter((event) => event.resolution_status === 'CONFIRMED' && event.origin !== 'MANUAL' && event.origin !== 'EXTERNAL_CONFIRMED');
  const readyPurchaseIds = new Set();
  for (const event of confirmed.filter((item) => item.event_type === 'PURCHASE')) {
    const hasPrepaymentLifecycle = (incoming.get(Number(event.id)) ?? []).some((edge) => ['PREPAYMENT_FOR', 'FULFILLS'].includes(edge.relation_type));
    if (hasPrepaymentLifecycle) continue;
    const facts = (evidenceMap.get(Number(event.id)) ?? []).map(factsForEvidence)[0];
    if (['RETURN_REFUND_V1', 'STANDALONE_PURCHASE_V1'].includes(event.rule_code) && facts?.status === 'READY' && facts.componentStatus === 'RECONCILED' && Number(sum([facts.cash, facts.ecash])) > 0) readyPurchaseIds.add(Number(event.id));
  }
  for (const event of confirmed.filter((item) => item.event_type === 'FULFILLMENT' && item.rule_code === 'PREPAYMENT_SETTLEMENT_V1')) {
    for (const edge of outgoing.get(Number(event.id)) ?? []) if (edge.relation_type === 'FULFILLS' && Number(event.amount) > 0) readyPurchaseIds.add(Number(edge.target_event_id));
  }

  for (const event of confirmed) {
    const eventEvidence = (evidenceMap.get(Number(event.id)) ?? []).map(factsForEvidence);
    const firstEvidence = eventEvidence[0] ?? null;
    const bankProofRows = bankEvidenceMap.get(Number(event.id)) ?? [];
    const bankProof = bankProofRows.length === 1 ? bankProofRows[0] : null;
    const eventAt = event.rule_code === BANK_ONLY_PURCHASE_EVENT_RULE
      ? (bankProof?.evidence_snapshot?.occurredAt ?? event.created_at)
      : firstEvidence?.dateTime ?? event.created_at;
    const currency = event.currency || LEDGER_CURRENCY;
    let rule;
    let description;
    let postings;
    let reasonCode = null;
    let status = 'READY';
    let links = eventEvidence.map((item) => ({ evidenceId: item.evidenceId, receiptId: item.receiptId, normalizationVersion: item.normalizationVersion, role: 'FISCAL_EVIDENCE' }));

    if (event.event_type === 'PURCHASE' && event.rule_code === BANK_ONLY_PURCHASE_EVENT_RULE) {
      rule = LEDGER_RULES.BANK_ONLY_PURCHASE;
      description = 'Proof-qualified bank-only purchase';
      if (!isValidBankOnlyPurchaseEvidence({ ...event, scope_key: event.scope_key }, bankProof)) {
        status = 'BLOCKED';
        reasonCode = 'BANK_ONLY_PURCHASE_EVIDENCE_INVALID';
        postings = [];
      } else {
        const snapshot = bankProof.evidence_snapshot;
        reasonCode = 'PROOF_QUALIFIED_BANK_PURCHASE';
        postings = [
          { account: 'UNCLASSIFIED_ACQUISITION', debit: snapshot.amount, credit: '0.00' },
          { account: `FINANCIAL_ACCOUNT:${Number(bankProof.financial_account_id)}`, debit: '0.00', credit: snapshot.amount },
        ];
        links = [{ role: BANK_ONLY_PURCHASE_EVIDENCE_ROLE, bankTransactionId: Number(bankProof.bank_transaction_id) }];
      }
    } else if (event.event_type === 'PREPAYMENT' && event.rule_code === 'PREPAYMENT_SETTLEMENT_V1') {
      rule = LEDGER_RULES.PREPAYMENT;
      description = 'Prepayment new-money evidence creates merchant advance';
      postings = [{ account: 'MERCHANT_ADVANCE', debit: amount(event.amount), credit: '0.00' }, { account: 'FISCAL_PAYMENT_CLEARING', debit: '0.00', credit: amount(event.amount) }];
    } else if (event.event_type === 'FULFILLMENT' && event.rule_code === 'PREPAYMENT_SETTLEMENT_V1') {
      rule = LEDGER_RULES.FULFILLMENT;
      description = 'Fulfillment consumes merchant advance without a second cash outflow';
      postings = [{ account: 'UNCLASSIFIED_ACQUISITION', debit: amount(event.amount), credit: '0.00' }, { account: 'MERCHANT_ADVANCE', debit: '0.00', credit: amount(event.amount) }];
    } else if (event.event_type === 'PURCHASE' && ['RETURN_REFUND_V1', 'STANDALONE_PURCHASE_V1'].includes(event.rule_code) && !(incoming.get(Number(event.id)) ?? []).some((edge) => ['PREPAYMENT_FOR', 'FULFILLS'].includes(edge.relation_type))) {
      rule = LEDGER_RULES.STANDALONE_PURCHASE;
      description = 'Standalone confirmed purchase from normalized new-money components';
      const facts = eventEvidence[0];
      const componentReady = facts?.status === 'READY' && facts.componentStatus === 'RECONCILED';
      const newMoney = sum([facts?.cash, facts?.ecash]);
      if (!componentReady || newMoney === null) {
        status = 'BLOCKED';
        reasonCode = 'NORMALIZED_COMPONENTS_NOT_READY';
        postings = [];
      } else if (Number(newMoney) > 0) {
        postings = [{ account: 'UNCLASSIFIED_ACQUISITION', debit: newMoney, credit: '0.00' }, { account: 'FISCAL_PAYMENT_CLEARING', debit: '0.00', credit: newMoney }];
      } else {
        status = 'BLOCKED';
        reasonCode = 'NO_SUPPORTED_NEW_MONEY_COMPONENT';
        postings = [];
      }
    } else if (event.event_type === 'RETURN' && event.rule_code === 'RETURN_REFUND_V1') {
      rule = LEDGER_RULES.RETURN;
      description = 'Confirmed return reverses acquisition into merchant refund receivable';
      const confirmedAllocations = (allocationsMap.get(Number(event.id)) ?? []).filter((item) => item.resolution_status === 'CONFIRMED');
      const returnedAmount = sum(confirmedAllocations.map((item) => item.allocated_amount));
      const targetPurchase = (outgoing.get(Number(event.id)) ?? []).find((edge) => edge.relation_type === 'RETURNS');
      if (!confirmedAllocations.length || Number(returnedAmount) <= 0) {
        status = 'BLOCKED';
        reasonCode = 'RETURN_ALLOCATION_MISSING';
        postings = [];
      } else if (!targetPurchase || !readyPurchaseIds.has(Number(targetPurchase.target_event_id))) {
        status = 'BLOCKED';
        reasonCode = 'PURCHASE_LEDGER_NOT_READY';
        postings = [];
      } else {
        postings = [{ account: 'MERCHANT_REFUND_RECEIVABLE', debit: returnedAmount, credit: '0.00' }, { account: 'UNCLASSIFIED_ACQUISITION', debit: '0.00', credit: returnedAmount }];
        links = [...links, ...confirmedAllocations.map((item) => ({ allocationId: Number(item.id), receiptId: item.source_receipt_id === null ? null : Number(item.source_receipt_id), role: 'RETURN_ALLOCATION' }))];
      }
    } else if (event.event_type === 'REFUND' && event.rule_code === 'RETURN_REFUND_V1') {
      rule = LEDGER_RULES.REFUND;
      description = 'Proven monetary refund reduces merchant refund receivable';
      postings = [{ account: 'FISCAL_PAYMENT_CLEARING', debit: amount(event.amount), credit: '0.00' }, { account: 'MERCHANT_REFUND_RECEIVABLE', debit: '0.00', credit: amount(event.amount) }];
    } else {
      rule = LEDGER_RULES.UNSUPPORTED;
      description = 'Confirmed business event has no safe Ledger V1 posting rule';
      status = 'BLOCKED';
      reasonCode = 'UNSUPPORTED_BUSINESS_EVENT_TYPE';
      postings = [];
    }

    const entry = {
      scopeKey: event.scope_key,
      sourceEventId: Number(event.id),
      currency,
      eventAt,
      semanticKey: fiscalContentFingerprint({ model: LEDGER_MODEL_VERSION, rule, sourceEventId: Number(event.id), currency, amount: event.amount, postings, reasonCode }),
      derivationRule: rule,
      derivationVersion: LEDGER_MODEL_VERSION,
      derivationStatus: status,
      certificationStatus: status === 'READY' ? 'FUNDING_UNRECONCILED' : 'BLOCKED',
      origin: LEDGER_ORIGIN,
      reasonCode,
      description,
      postings,
      links,
    };
    entries.push(entry);
  }
  return entries;
}

export async function loadLedgerProjection(pool, scopeKey = 'default', eventIds = null) {
  const eventFilter = eventIds?.length ? ' AND e.id = ANY($2::bigint[])' : '';
  const eventParams = eventIds?.length ? [scopeKey, eventIds] : [scopeKey];
  const events = (await pool.query(`SELECT e.id,e.scope_id,e.event_type,e.resolution_status,e.origin,e.graph_model_version,
      e.rule_code,e.rule_version,e.semantic_key,e.amount,e.currency,e.created_at,s.scope_key
    FROM business_events e JOIN accounting_scopes s ON s.id=e.scope_id
    WHERE s.scope_key=$1${eventFilter}
      AND NOT EXISTS (SELECT 1 FROM manual_troika_topup_expenses m
        WHERE m.scope_id=e.scope_id AND m.business_event_id=e.id)
      AND NOT EXISTS (SELECT 1
        FROM business_event_bank_evidence be
        JOIN ledger_entries bank_entry ON bank_entry.scope_id=be.scope_id
          AND bank_entry.source_event_id=be.business_event_id
          AND bank_entry.derivation_rule='LEDGER_BANK_ONLY_PURCHASE_V1'
        JOIN ledger_entry_supersessions supersession ON supersession.scope_id=bank_entry.scope_id
          AND supersession.superseded_ledger_entry_id=bank_entry.id
        WHERE be.scope_id=e.scope_id AND be.business_event_id=e.id
          AND be.evidence_role='BANK_ONLY_PURCHASE')
    ORDER BY e.id`, eventParams)).rows;
  const ids = events.map((event) => event.id);
  if (!ids.length) return { events: [], evidence: [], allocations: [], edges: [], entries: [] };
  const evidence = (await pool.query(`SELECT ev.id AS evidence_id,ev.event_id,ev.receipt_id,ev.normalization_version,r.date_time,f.normalization_status,f.cash_total_sum,f.ecash_total_sum,f.prepaid_sum,f.credit_sum,f.provision_sum,f.payment_components_status FROM business_event_evidence ev LEFT JOIN receipts r ON r.id=ev.receipt_id LEFT JOIN receipt_fiscal_facts f ON f.receipt_id=ev.receipt_id AND f.normalization_version=ev.normalization_version WHERE ev.event_id = ANY($1::bigint[]) ORDER BY ev.id`, [ids])).rows;
  const bankEvidence = (await pool.query(`SELECT id,scope_id,business_event_id,bank_receipt_match_id,bank_transaction_id,
      financial_account_id,enrichment_key,evidence_role,rule_version,semantic_key,evidence_snapshot,evidence_sha256
    FROM business_event_bank_evidence
    WHERE scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$1)
      AND business_event_id=ANY($2::bigint[]) AND evidence_role=$3
    ORDER BY id`, [scopeKey, ids, BANK_ONLY_PURCHASE_EVIDENCE_ROLE])).rows;
  const allocations = (await pool.query(`SELECT a.id,a.scope_id,a.target_event_id,a.source_receipt_id,a.allocated_amount,a.resolution_status
    FROM business_event_allocations a JOIN accounting_scopes s ON s.id=a.scope_id WHERE s.scope_key=$1`, [scopeKey])).rows;
  const edges = (await pool.query(`SELECT e.scope_id,e.source_event_id,e.target_event_id,e.relation_type
    FROM business_event_edges e JOIN accounting_scopes s ON s.id=e.scope_id WHERE s.scope_key=$1`, [scopeKey])).rows;
  return { events, evidence, allocations, edges, bankEvidence, entries: deriveLedgerEntries({ events, evidence, allocations, edges, bankEvidence }) };
}

async function ensureAccounts(tx, scopeKey, entries = []) {
  const scope = (await tx.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
  if (!scope) throw new Error(`Accounting scope not found: ${scopeKey}`);
  const accounts = new Map();
  for (const [code, definition] of Object.entries(LEDGER_ACCOUNTS)) {
    await tx.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description)
      VALUES($1,$2,$3,$4) ON CONFLICT(scope_id,account_code) DO NOTHING`, [scope.id, code, definition.type, definition.description]);
    const row = (await tx.query('SELECT id,account_code,account_type FROM ledger_accounts WHERE scope_id=$1 AND account_code=$2', [scope.id, code])).rows[0];
    if (!row || row.account_type !== definition.type) {
      const error = new Error(`Ledger account catalog conflict: ${code}`);
      error.code = 'LEDGER_ACCOUNT_CATALOG_CONFLICT';
      throw error;
    }
    accounts.set(code, Number(row.id));
  }
  const financialMappings = new Map();
  for (const entry of entries) {
    for (const posting of entry.postings ?? []) {
      const match = /^FINANCIAL_ACCOUNT:(\d+)$/.exec(posting.account ?? '');
      if (!match) continue;
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Ledger financial account mapping is invalid');
      const prior = financialMappings.get(id);
      if (prior && prior !== entry.currency) throw new Error('Ledger financial account currency conflict');
      financialMappings.set(id, entry.currency);
    }
  }
  for (const [financialAccountId, currency] of financialMappings) {
    const code = `FINANCIAL_ACCOUNT:${financialAccountId}`;
    await tx.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency)
      VALUES($1,$2,'ASSET','Mapped financial account',$3,$4) ON CONFLICT(scope_id,account_code) DO NOTHING`, [scope.id, code, financialAccountId, currency]);
    const row = (await tx.query('SELECT id,scope_id,account_code,account_type,financial_account_id,account_currency FROM ledger_accounts WHERE scope_id=$1 AND account_code=$2', [scope.id, code])).rows[0];
    if (!row || Number(row.scope_id) !== Number(scope.id) || row.account_type !== 'ASSET'
      || Number(row.financial_account_id) !== financialAccountId || row.account_currency !== currency) {
      throw new Error(`Ledger account catalog conflict: ${code}`);
    }
    accounts.set(code, Number(row.id));
  }
  return accounts;
}

async function loadPersistedLedgerState(pool, scopeKey, eventIds = null) {
  const scope = (await pool.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
  if (!scope) {
    const error = new Error(`Accounting scope not found: ${scopeKey}`);
    error.code = 'ACCOUNTING_SCOPE_NOT_FOUND';
    throw error;
  }
  const filter = eventIds?.length ? ' AND e.source_event_id = ANY($2::bigint[])' : '';
  const params = eventIds?.length ? [scope.id, eventIds] : [scope.id];
  const supersessions = (await pool.query(`SELECT scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,enrichment_key,semantic_key,reason_code
    FROM ledger_entry_supersessions WHERE scope_id=$1${eventIds?.length ? ' AND business_event_id = ANY($2::bigint[])' : ''} ORDER BY id`, params)).rows;
  const entries = (await pool.query(`SELECT e.id,e.source_event_id,e.currency,e.event_at,e.semantic_key,e.derivation_rule,e.derivation_version,e.derivation_status,e.certification_status,e.reason_code,e.description
    FROM ledger_entries e
    WHERE e.scope_id=$1 AND e.origin='SYSTEM_DERIVED'
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)${filter}
    ORDER BY e.id`, params)).rows;
  const entryIds = entries.map((entry) => Number(entry.id));
  if (!entryIds.length) return { scopeId: Number(scope.id), entries, postings: [], links: [], supersessions };
  const postings = (await pool.query(`SELECT p.ledger_entry_id,a.account_code,p.currency,p.debit,p.credit,p.source_allocation_id,p.source_receipt_id
    FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
    WHERE p.ledger_entry_id=ANY($1::bigint[]) ORDER BY p.ledger_entry_id,p.id`, [entryIds])).rows;
  const links = (await pool.query(`SELECT l.ledger_entry_id,l.business_event_id,l.graph_evidence_id,l.graph_allocation_id,l.receipt_id,l.normalization_version,l.link_role,l.semantic_key,l.bank_receipt_match_id,l.bank_transaction_id,
      m.scope_id AS match_scope_id,m.bank_transaction_id AS match_bank_transaction_id
    FROM ledger_source_links l
    LEFT JOIN bank_receipt_matches m ON m.id=l.bank_receipt_match_id
    WHERE l.ledger_entry_id=ANY($1::bigint[]) ORDER BY l.ledger_entry_id,l.id`, [entryIds])).rows;
  return { scopeId: Number(scope.id), entries, postings, links, supersessions };
}

function assessLedgerProjection(projection, persisted, requestedEventIds = null) {
  const existingByEvent = new Map(persisted.entries.map((entry) => [String(entry.source_event_id), entry]));
  const persistedEntryById = new Map(persisted.entries.map((entry) => [Number(entry.id), entry]));
  const projectionByEvent = new Map(projection.entries.map((entry) => [String(entry.sourceEventId), entry]));
  if (projectionByEvent.size !== projection.entries.length) return { kind: 'conflict', reason: 'duplicate projected source event' };
  const existingProjectionEntries = projection.entries.filter((entry) => existingByEvent.has(String(entry.sourceEventId)));
  const newEntries = projection.entries.filter((entry) => !existingByEvent.has(String(entry.sourceEventId)));
  const stableRows = (rows) => rows
    .map((row) => row.map((value) => value === null || value === undefined ? null : String(value)))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const protectedLinks = persisted.links.filter((link) => link.bank_receipt_match_id !== null || link.bank_transaction_id !== null);
  const protectedEntryIds = new Set(protectedLinks.map((link) => Number(link.ledger_entry_id)));
  const protectedEventIds = new Set([...protectedEntryIds]
    .map((entryId) => persistedEntryById.get(entryId)?.source_event_id)
    .filter((eventId) => eventId !== undefined)
    .map(String));
  if (requestedEventIds?.some((eventId) => protectedEventIds.has(String(eventId)))) {
    return { kind: 'conflict', reason: 'explicit rebuild targets protected ledger event' };
  }
  const comparableProjectionEntries = existingProjectionEntries
    .filter((entry) => !protectedEventIds.has(String(entry.sourceEventId)));
  const comparablePersistedEntries = persisted.entries
    .filter((entry) => !protectedEntryIds.has(Number(entry.id)));
  const ordinaryPersistedLinks = persisted.links
    .filter((link) => link.bank_receipt_match_id === null && link.bank_transaction_id === null
      && !protectedEntryIds.has(Number(link.ledger_entry_id)))
    .map((link) => [persistedEntryById.get(Number(link.ledger_entry_id))?.source_event_id, link.business_event_id, link.graph_evidence_id, link.graph_allocation_id, link.receipt_id, link.normalization_version, link.link_role, link.semantic_key, null, null]);
  const projectedPostings = comparableProjectionEntries.flatMap((entry) => entry.postings.map((posting) => [entry.sourceEventId, posting.account, entry.currency, posting.debit, posting.credit, posting.allocationId ?? null, posting.receiptId ?? null]));
  const persistedPostings = persisted.postings
    .filter((posting) => !protectedEntryIds.has(Number(posting.ledger_entry_id)))
    .map((posting) => [persistedEntryById.get(Number(posting.ledger_entry_id))?.source_event_id, posting.account_code, posting.currency, posting.debit, posting.credit, posting.source_allocation_id, posting.source_receipt_id]);
  const projectedLinks = comparableProjectionEntries.flatMap((entry) => {
    const current = existingByEvent.get(String(entry.sourceEventId));
    return entry.links.map((link) => [entry.sourceEventId, entry.sourceEventId, link.evidenceId ?? null, link.allocationId ?? null, link.receiptId ?? null, link.normalizationVersion ?? null, link.role,
      current ? fiscalContentFingerprint({ ledgerEntryId: Number(current.id), businessEventId: entry.sourceEventId, graphEvidenceId: link.evidenceId ?? null, graphAllocationId: link.allocationId ?? null, receiptId: link.receiptId ?? null, role: link.role }) : null,
      null, null]);
  });
  const projectedEntries = comparableProjectionEntries.map((entry) => [entry.sourceEventId, entry.currency, entry.eventAt, entry.semanticKey, entry.derivationRule, entry.derivationVersion, entry.derivationStatus, entry.certificationStatus, entry.reasonCode ?? null, entry.description ?? null]);
  const persistedEntryRows = comparablePersistedEntries.map((entry) => [entry.source_event_id, entry.currency, entry.event_at, entry.semantic_key, entry.derivation_rule, entry.derivation_version, entry.derivation_status, entry.certification_status, entry.reason_code, entry.description]);
  const protectedEntriesValid = [...protectedEntryIds].every((entryId) => {
    const entry = persistedEntryById.get(entryId);
    return entry
      && projectionByEvent.has(String(entry.source_event_id))
      && /^[0-9a-f]{64}$/.test(String(entry.semantic_key ?? ''))
      && String(entry.derivation_rule ?? '').trim().length > 0
      && String(entry.derivation_version ?? '').trim().length > 0
      && String(entry.derivation_status ?? '').trim().length > 0
      && String(entry.certification_status ?? '').trim().length > 0;
  });
  const protectedValid = protectedLinks.every((link) => {
    const entry = persistedEntryById.get(Number(link.ledger_entry_id));
    const hasMatch = link.bank_receipt_match_id !== null;
    return entry
      && Number(link.business_event_id) === Number(entry.source_event_id)
      && Number(link.bank_transaction_id) > 0
      && (!hasMatch || (Number(link.bank_receipt_match_id) > 0
        && Number(link.match_scope_id) === Number(persisted.scopeId)
        && Number(link.match_bank_transaction_id) === Number(link.bank_transaction_id)))
      && /^[0-9a-f]{64}$/.test(String(link.semantic_key ?? ''));
  });
  const supersededIds = new Set(persisted.supersessions.map((row) => Number(row.superseded_ledger_entry_id)));
  const replacementBySupersededId = new Map(persisted.supersessions.map((row) => [
    Number(row.superseded_ledger_entry_id), Number(row.replacement_ledger_entry_id),
  ]));
  const activeEntryForEvent = new Set(persisted.entries.map((entry) => String(entry.source_event_id)));
  const reachesActiveReplacement = (replacementId, businessEventId) => {
    const visited = new Set();
    let currentId = Number(replacementId);
    while (supersededIds.has(currentId)) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      const nextId = replacementBySupersededId.get(currentId);
      if (!nextId || nextId === currentId) return false;
      currentId = nextId;
    }
    const activeReplacement = persistedEntryById.get(currentId);
    return Boolean(activeReplacement)
      && Number(activeReplacement.source_event_id) === Number(businessEventId)
      && activeEntryForEvent.has(String(businessEventId));
  };
  const supersessionsValid = persisted.supersessions.every((row) => {
    const replacementId = Number(row.replacement_ledger_entry_id);
    const replacement = persistedEntryById.get(replacementId);
    return Number(row.scope_id) === Number(persisted.scopeId)
      && Number(row.superseded_ledger_entry_id) > 0
      && replacementId > 0
      && (replacement || supersededIds.has(replacementId))
      && (!replacement || Number(replacement.source_event_id) === Number(row.business_event_id))
      && projectionByEvent.has(String(row.business_event_id))
      && reachesActiveReplacement(replacementId, row.business_event_id)
      && /^[0-9a-f]{64}$/.test(String(row.enrichment_key ?? ''))
      && /^[0-9a-f]{64}$/.test(String(row.semantic_key ?? ''))
      && String(row.reason_code ?? '').trim().length > 0;
  });
  const existingIdentitiesMatch = comparablePersistedEntries.every((entry) => {
    const projected = projectionByEvent.get(String(entry.source_event_id));
    return projected
      && entry.semantic_key === projected.semanticKey
      && entry.derivation_rule === projected.derivationRule
      && entry.derivation_version === projected.derivationVersion
      && entry.derivation_status === projected.derivationStatus
      && entry.certification_status === projected.certificationStatus
      && entry.reason_code === (projected.reasonCode ?? null)
      && entry.description === (projected.description ?? null);
  });
  if (!protectedValid || !protectedEntriesValid || !supersessionsValid || !existingIdentitiesMatch
    || JSON.stringify(stableRows(persistedEntryRows)) !== JSON.stringify(stableRows(projectedEntries))
    || JSON.stringify(stableRows(persistedPostings)) !== JSON.stringify(stableRows(projectedPostings))
    || JSON.stringify(stableRows(ordinaryPersistedLinks)) !== JSON.stringify(stableRows(projectedLinks))) {
    return { kind: 'conflict', reason: 'persisted ledger identity or overlay drift' };
  }
  return { kind: newEntries.length ? 'append' : 'match', newEntries };
}

async function persistEntry(tx, entry, accounts) {
  const insertedEntry = (await tx.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description)
    VALUES((SELECT id FROM accounting_scopes WHERE scope_key=$1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(scope_id,semantic_key,derivation_rule,derivation_version,origin) DO NOTHING
    RETURNING id`, [entry.scopeKey, entry.sourceEventId, entry.currency, entry.eventAt, entry.semanticKey, entry.derivationRule, entry.derivationVersion, entry.derivationStatus, entry.certificationStatus, entry.origin, entry.reasonCode, entry.description])).rows[0];
  const existingEntry = insertedEntry ?? (await tx.query(`SELECT id FROM ledger_entries
    WHERE scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$1)
      AND semantic_key=$2 AND derivation_rule=$3 AND derivation_version=$4 AND origin=$5`,
  [entry.scopeKey, entry.semanticKey, entry.derivationRule, entry.derivationVersion, entry.origin])).rows[0];
  if (!existingEntry) throw Object.assign(new Error('LEDGER_ENTRY_IDEMPOTENCY_CONFLICT'), { code: 'LEDGER_ENTRY_IDEMPOTENCY_CONFLICT' });
  const entryId = Number(existingEntry.id);
  let postingCount = 0;
  if (entry.derivationStatus !== 'BLOCKED') {
    for (const posting of entry.postings) {
      const inserted = await tx.query(`INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit,source_receipt_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [entryId, accounts.get(posting.account), entry.currency, posting.debit, posting.credit, posting.receiptId ?? null]);
      postingCount += inserted.rowCount;
    }
  }
  let linkCount = 0;
  for (const link of entry.links) {
    const semanticMaterial = { ledgerEntryId: entryId, businessEventId: entry.sourceEventId, graphEvidenceId: link.evidenceId ?? null, graphAllocationId: link.allocationId ?? null, receiptId: link.receiptId ?? null, role: link.role,
      ...(link.bankTransactionId == null ? {} : { bankTransactionId: Number(link.bankTransactionId) }) };
    const semanticKey = fiscalContentFingerprint(semanticMaterial);
    const inserted = await tx.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,graph_allocation_id,receipt_id,normalization_version,link_role,semantic_key,bank_transaction_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(semantic_key) DO NOTHING RETURNING id`, [entryId, entry.sourceEventId, link.evidenceId ?? null, link.allocationId ?? null, link.receiptId ?? null, link.normalizationVersion ?? null, link.role, semanticKey, link.bankTransactionId ?? null]);
    linkCount += inserted.rowCount;
  }
  return { entryId, created: Boolean(insertedEntry), postings: postingCount, links: linkCount };
}

export async function rebuildLedger(pool, { scopeKey = 'default', dryRun = false, replace = false, failAfter = null, eventIds = null, projection: providedProjection = null, client: transactionClient = null } = {}) {
  let projection = providedProjection;
  let entriesToPersist = null;
  if (dryRun) return summarizeLedgerProjection(projection ?? await loadLedgerProjection(pool, scopeKey, eventIds));
  const client = transactionClient ?? await pool.connect();
  const ownsTransaction = !transactionClient;
  let releaseScopeLock = null;
  try {
    if (ownsTransaction) releaseScopeLock = await lockMatchedPurchaseScope(client, scopeKey);
    else await lockMatchedPurchaseScopeTransaction(client, scopeKey);
    // A no-op decision must not commit against a source snapshot that can be
    // invalidated by a concurrent writer after the projection is loaded.
    if (ownsTransaction) await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    if (ownsTransaction) await lockMatchedPurchaseScopeTransaction(client, scopeKey);
    if (!projection) projection = await loadLedgerProjection(client, scopeKey, eventIds);
    if (!replace && !transactionClient) {
      const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
      if (!scope) {
        const error = new Error(`Accounting scope not found: ${scopeKey}`);
        error.code = 'ACCOUNTING_SCOPE_NOT_FOUND';
        throw error;
      }
      const persisted = await loadPersistedLedgerState(client, scopeKey, eventIds);
      const assessment = assessLedgerProjection(projection, persisted, eventIds);
      if (assessment.kind === 'match') {
        await client.query('COMMIT');
        return { ...summarizeLedgerProjection(projection), changed: false, created: { entries: 0, postings: 0, links: 0, blocked: 0 }, balancedViolations: 0 };
      }
      if (assessment.kind === 'conflict') {
        const error = new Error(assessment.reason);
        error.code = 'LEDGER_PROTECTED_OVERLAY_CONFLICT';
        throw error;
      }
      entriesToPersist = assessment.newEntries;
    }
    if (replace) {
      await assertNoProtectedLedgerEntries(client, scopeKey, eventIds);
      if (!eventIds?.length) {
        const dependency = (await client.query(`SELECT count(*)::int AS count
          FROM certification_facts f
          JOIN ledger_entries e ON e.id=f.ledger_entry_id
          WHERE e.scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$1)
            AND e.origin='SYSTEM_DERIVED'`, [scopeKey])).rows[0];
        if (Number(dependency.count) > 0) {
          const error = new Error('Full ledger replace is forbidden while certification facts reference system-derived ledger entries; use the bounded incremental path or an explicitly coordinated disposable-clone rebuild.');
          error.code = 'LEDGER_REBUILD_CERTIFICATION_DEPENDENCY';
          throw error;
        }
      }
      const eventClause = eventIds?.length ? ' AND source_event_id = ANY($2::bigint[])' : '';
      const params = eventIds?.length ? [scopeKey, eventIds] : [scopeKey];
      await client.query(`DELETE FROM ledger_postings WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$1) AND origin='SYSTEM_DERIVED'${eventClause})`, params);
      await client.query(`DELETE FROM ledger_source_links WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$1) AND origin='SYSTEM_DERIVED'${eventClause})`, params);
      await client.query(`DELETE FROM ledger_entries WHERE scope_id=(SELECT id FROM accounting_scopes WHERE scope_key=$1) AND origin='SYSTEM_DERIVED'${eventClause}`, params);
    }
    const accounts = await ensureAccounts(client, scopeKey, entriesToPersist ?? projection.entries);
    const created = { entries: 0, postings: 0, links: 0, blocked: 0 };
    for (const entry of entriesToPersist ?? projection.entries) {
      const persisted = await persistEntry(client, entry, accounts);
      created.entries += Number(persisted.created); created.postings += persisted.postings; created.links += persisted.links;
      if (entry.derivationStatus === 'BLOCKED') created.blocked += 1;
      if (failAfter !== null && created.entries >= Number(failAfter)) throw new Error('injected ledger builder failure');
    }
    const unbalanced = (await client.query(`SELECT count(*)::int AS count FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING SUM(debit)<>SUM(credit)) q`)).rows[0].count;
    if (Number(unbalanced) !== 0) throw new Error(`Ledger is unbalanced: ${unbalanced}`);
    if (ownsTransaction) await client.query('COMMIT');
    return { ...summarizeLedgerProjection(projection), created, balancedViolations: Number(unbalanced) };
  } catch (error) { if (ownsTransaction) await client.query('ROLLBACK'); throw error; } finally {
    let releaseError;
    if (releaseScopeLock) {
      try { await releaseScopeLock(); } catch (error) { releaseError = error; }
    }
    if (ownsTransaction) client.release(releaseError);
  }
}

async function assertNoProtectedLedgerEntries(client, scopeKey, eventIds = null) {
  const eventClause = eventIds?.length ? ' AND e.source_event_id = ANY($2::bigint[])' : '';
  const params = eventIds?.length ? [scopeKey, eventIds] : [scopeKey];
  const protectedRows = (await client.query(`SELECT e.id
    FROM ledger_entries e
    JOIN accounting_scopes s ON s.id=e.scope_id
    WHERE s.scope_key=$1
      AND (EXISTS (SELECT 1 FROM ledger_entry_supersessions old_side
                   WHERE old_side.scope_id=e.scope_id
                     AND old_side.superseded_ledger_entry_id=e.id)
        OR EXISTS (SELECT 1 FROM ledger_entry_supersessions replacement_side
                   WHERE replacement_side.scope_id=e.scope_id
                     AND replacement_side.replacement_ledger_entry_id=e.id)
        OR EXISTS (SELECT 1 FROM ledger_source_links bank_link
                   WHERE bank_link.ledger_entry_id=e.id
                     AND (bank_link.bank_receipt_match_id IS NOT NULL OR bank_link.bank_transaction_id IS NOT NULL)))${eventClause}
    LIMIT 1`, params)).rows;
  if (protectedRows.length) {
    const error = new Error('Ledger refresh/rebuild cannot destructively replace protected supersession history');
    error.code = 'LEDGER_SUPERSESSION_PROTECTED';
    throw error;
  }
}

async function affectedEventIds(pool, scopeKey, receiptId) {
  const result = await pool.query(`WITH RECURSIVE component(id) AS (
    SELECT ev.event_id FROM business_event_evidence ev
    JOIN business_events e ON e.id=ev.event_id
    JOIN accounting_scopes s ON s.id=e.scope_id
    WHERE s.scope_key=$1 AND ev.receipt_id=$2
    UNION
    SELECT CASE WHEN edge.source_event_id=component.id THEN edge.target_event_id ELSE edge.source_event_id END
    FROM business_event_edges edge JOIN component
      ON edge.source_event_id=component.id OR edge.target_event_id=component.id
  ) SELECT DISTINCT id FROM component ORDER BY id`, [scopeKey, receiptId]);
  return result.rows.map((row) => Number(row.id));
}

export async function refreshLedgerForReceipt(pool, { scopeKey = 'default', receiptId } = {}) {
  const eventIds = await affectedEventIds(pool, scopeKey, receiptId);
  if (!eventIds.length) return { eventIds: [], created: { entries: 0, postings: 0, links: 0, blocked: 0 }, bounded: true };
  const projection = await loadLedgerProjection(pool, scopeKey, eventIds);
  const scopeId = (await pool.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0]?.id;
  const existing = (await pool.query(`SELECT id,source_event_id,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,reason_code,description
    FROM ledger_entries WHERE scope_id=$1 AND source_event_id=ANY($2::bigint[]) AND origin='SYSTEM_DERIVED'
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=ledger_entries.scope_id AND (s.superseded_ledger_entry_id=ledger_entries.id OR s.replacement_ledger_entry_id=ledger_entries.id))
    ORDER BY id`, [scopeId, eventIds])).rows;
  const existingByEvent = new Map(existing.map((entry) => [String(entry.source_event_id), entry]));
  const existingEntryIds = existing.map((entry) => Number(entry.id));
  const existingPostings = existingEntryIds.length === 0 ? [] : (await pool.query(`SELECT p.ledger_entry_id,a.account_code,p.currency,p.debit,p.credit,p.source_allocation_id,p.source_receipt_id
    FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
    WHERE p.ledger_entry_id=ANY($1::bigint[])`, [existingEntryIds])).rows;
  const existingLinks = existingEntryIds.length === 0 ? [] : (await pool.query(`SELECT ledger_entry_id,business_event_id,graph_evidence_id,graph_allocation_id,receipt_id,normalization_version,link_role
    FROM ledger_source_links WHERE ledger_entry_id=ANY($1::bigint[])`, [existingEntryIds])).rows;
  const stableRows = (rows, fields) => rows.map((row) => fields.map((field) => row[field] === null || row[field] === undefined ? null : String(row[field]))).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const projectedPostings = projection.entries.flatMap((entry) => entry.postings.map((posting) => [String(entry.sourceEventId), posting.account, entry.currency, posting.debit, posting.credit, posting.allocationId ?? null, posting.receiptId ?? null]));
  const persistedPostings = existingPostings.map((posting) => [String(existing.find((entry) => Number(entry.id) === Number(posting.ledger_entry_id))?.source_event_id), posting.account_code, posting.currency, posting.debit, posting.credit, posting.source_allocation_id, posting.source_receipt_id]);
  const projectedLinks = projection.entries.flatMap((entry) => entry.links.map((link) => [String(entry.sourceEventId), String(entry.sourceEventId), link.evidenceId ?? null, link.allocationId ?? null, link.receiptId ?? null, link.normalizationVersion ?? null, link.role]));
  const persistedLinks = existingLinks.map((link) => [String(existing.find((entry) => Number(entry.id) === Number(link.ledger_entry_id))?.source_event_id), link.business_event_id, link.graph_evidence_id, link.graph_allocation_id, link.receipt_id, link.normalization_version, link.link_role]);
  const childrenUnchanged = JSON.stringify(stableRows(persistedPostings, [0, 1, 2, 3, 4, 5, 6])) === JSON.stringify(stableRows(projectedPostings, [0, 1, 2, 3, 4, 5, 6]))
    && JSON.stringify(stableRows(persistedLinks, [0, 1, 2, 3, 4, 5, 6])) === JSON.stringify(stableRows(projectedLinks, [0, 1, 2, 3, 4, 5, 6]));
  const unchanged = existing.length === projection.entries.length
    && childrenUnchanged
    && projection.entries.every((entry) => {
      const current = existingByEvent.get(String(entry.sourceEventId));
      return current
        && current.semantic_key === entry.semanticKey
        && current.derivation_rule === entry.derivationRule
        && current.derivation_version === entry.derivationVersion
        && current.derivation_status === entry.derivationStatus
        && current.certification_status === entry.certificationStatus
        && current.reason_code === (entry.reasonCode ?? null)
        && current.description === (entry.description ?? null);
    });
  if (unchanged) return { ...summarizeLedgerProjection(projection), eventIds, bounded: true, changed: false, created: { entries: 0, postings: 0, links: 0, blocked: 0 } };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertNoProtectedLedgerEntries(client, scopeKey, eventIds);
    await client.query(`DELETE FROM reconciliation_results WHERE run_id IN (
      SELECT DISTINCT f.run_id FROM certification_facts f
      WHERE f.ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1 AND source_event_id=ANY($2::bigint[]) AND origin='SYSTEM_DERIVED')
         OR f.business_event_id=ANY($2::bigint[])
    )`, [scopeId, eventIds]);
    await client.query(`DELETE FROM certification_facts
      WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE scope_id=$1 AND source_event_id=ANY($2::bigint[]) AND origin='SYSTEM_DERIVED')
         OR business_event_id=ANY($2::bigint[])`, [scopeId, eventIds]);
    const ledger = await rebuildLedger(pool, { scopeKey, replace: true, eventIds, projection, client });
    const certification = await refreshCertificationForEvents(pool, { scopeKey, eventIds, client });
    await client.query('COMMIT');
    return { ...ledger, certification, eventIds, bounded: true, changed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function summarizeLedgerProjection(projection) {
  const byRule = {};
  for (const entry of projection.entries) {
    const bucket = byRule[entry.derivationRule] ?? { entries: 0, postings: 0, status: {}, debit: 0, credit: 0 };
    bucket.entries += 1;
    bucket.postings += entry.postings.length;
    bucket.status[entry.derivationStatus] = (bucket.status[entry.derivationStatus] ?? 0) + 1;
    bucket.debit += entry.postings.reduce((total, posting) => total + numeric(posting.debit), 0);
    bucket.credit += entry.postings.reduce((total, posting) => total + numeric(posting.credit), 0);
    byRule[entry.derivationRule] = bucket;
  }
  return { model: LEDGER_MODEL_VERSION, currency: LEDGER_CURRENCY, entries: projection.entries.length, postings: projection.entries.reduce((total, entry) => total + entry.postings.length, 0), byRule, blocked: projection.entries.filter((entry) => entry.derivationStatus === 'BLOCKED').map((entry) => ({ sourceEventId: entry.sourceEventId, rule: entry.derivationRule, reasonCode: entry.reasonCode })) };
}

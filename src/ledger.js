import { fiscalContentFingerprint } from './fiscal-evidence.js';
import { refreshCertificationForEvents } from './certification.js';

export const LEDGER_MODEL_VERSION = 'ledger-v1';
export const LEDGER_ORIGIN = 'SYSTEM_DERIVED';
export const LEDGER_CURRENCY = 'RUB';

export const LEDGER_RULES = Object.freeze({
  PREPAYMENT: 'LEDGER_PREPAYMENT_V1',
  FULFILLMENT: 'LEDGER_FULFILLMENT_V1',
  STANDALONE_PURCHASE: 'LEDGER_STANDALONE_PURCHASE_V1',
  RETURN: 'LEDGER_RETURN_V1',
  REFUND: 'LEDGER_REFUND_V1',
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

export function deriveLedgerEntries({ events, evidence, allocations, edges }) {
  const evidenceMap = evidenceByEvent(evidence);
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
    const eventAt = firstEvidence?.dateTime ?? event.created_at;
    const currency = event.currency || LEDGER_CURRENCY;
    let rule;
    let description;
    let postings;
    let reasonCode = null;
    let status = 'READY';
    let links = eventEvidence.map((item) => ({ evidenceId: item.evidenceId, receiptId: item.receiptId, normalizationVersion: item.normalizationVersion, role: 'FISCAL_EVIDENCE' }));

    if (event.event_type === 'PREPAYMENT' && event.rule_code === 'PREPAYMENT_SETTLEMENT_V1') {
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
  const events = (await pool.query(`SELECT e.*, s.scope_key FROM business_events e JOIN accounting_scopes s ON s.id=e.scope_id WHERE s.scope_key=$1${eventFilter} ORDER BY e.id`, eventParams)).rows;
  const ids = events.map((event) => event.id);
  if (!ids.length) return { events: [], evidence: [], allocations: [], edges: [], entries: [] };
  const evidence = (await pool.query(`SELECT ev.id AS evidence_id,ev.event_id,ev.receipt_id,ev.normalization_version,r.date_time,f.normalization_status,f.cash_total_sum,f.ecash_total_sum,f.prepaid_sum,f.credit_sum,f.provision_sum,f.payment_components_status FROM business_event_evidence ev LEFT JOIN receipts r ON r.id=ev.receipt_id LEFT JOIN receipt_fiscal_facts f ON f.receipt_id=ev.receipt_id AND f.normalization_version=ev.normalization_version WHERE ev.event_id = ANY($1::bigint[]) ORDER BY ev.id`, [ids])).rows;
  const allocations = (await pool.query(`SELECT a.* FROM business_event_allocations a JOIN accounting_scopes s ON s.id=a.scope_id WHERE s.scope_key=$1`, [scopeKey])).rows;
  const edges = (await pool.query(`SELECT e.* FROM business_event_edges e JOIN accounting_scopes s ON s.id=e.scope_id WHERE s.scope_key=$1`, [scopeKey])).rows;
  return { events, evidence, allocations, edges, entries: deriveLedgerEntries({ events, evidence, allocations, edges }) };
}

async function ensureAccounts(tx, scopeKey) {
  const scope = (await tx.query('SELECT id FROM accounting_scopes WHERE scope_key=$1', [scopeKey])).rows[0];
  if (!scope) throw new Error(`Accounting scope not found: ${scopeKey}`);
  // Serialize account-catalog upserts per scope to avoid ON CONFLICT lock cycles.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
  const accounts = new Map();
  for (const [code, definition] of Object.entries(LEDGER_ACCOUNTS)) {
    const row = (await tx.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description) VALUES($1,$2,$3,$4) ON CONFLICT(scope_id,account_code) DO UPDATE SET description=EXCLUDED.description RETURNING id,account_code`, [scope.id, code, definition.type, definition.description])).rows[0];
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
  if (!entryIds.length) return { entries, postings: [], links: [], supersessions };
  const postings = (await pool.query(`SELECT p.ledger_entry_id,a.account_code,p.currency,p.debit,p.credit,p.source_allocation_id,p.source_receipt_id
    FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
    WHERE p.ledger_entry_id=ANY($1::bigint[]) ORDER BY p.ledger_entry_id,p.id`, [entryIds])).rows;
  const links = (await pool.query(`SELECT ledger_entry_id,business_event_id,graph_evidence_id,graph_allocation_id,receipt_id,normalization_version,link_role,semantic_key,bank_receipt_match_id,bank_transaction_id
    FROM ledger_source_links WHERE ledger_entry_id=ANY($1::bigint[]) ORDER BY ledger_entry_id,id`, [entryIds])).rows;
  return { entries, postings, links, supersessions };
}

function ledgerProjectionMatches(projection, persisted) {
  const existingByEvent = new Map(persisted.entries.map((entry) => [String(entry.source_event_id), entry]));
  const persistedEntryById = new Map(persisted.entries.map((entry) => [Number(entry.id), entry]));
  const stableRows = (rows) => rows
    .map((row) => row.map((value) => value === null || value === undefined ? null : String(value)))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const projectedPostings = projection.entries.flatMap((entry) => entry.postings.map((posting) => [entry.sourceEventId, posting.account, entry.currency, posting.debit, posting.credit, posting.allocationId ?? null, posting.receiptId ?? null]));
  const persistedPostings = persisted.postings.map((posting) => [persistedEntryById.get(Number(posting.ledger_entry_id))?.source_event_id, posting.account_code, posting.currency, posting.debit, posting.credit, posting.source_allocation_id, posting.source_receipt_id]);
  const projectedLinks = projection.entries.flatMap((entry) => {
    const current = existingByEvent.get(String(entry.sourceEventId));
    return entry.links.map((link) => [entry.sourceEventId, entry.sourceEventId, link.evidenceId ?? null, link.allocationId ?? null, link.receiptId ?? null, link.normalizationVersion ?? null, link.role,
      current ? fiscalContentFingerprint({ ledgerEntryId: current.id, businessEventId: entry.sourceEventId, graphEvidenceId: link.evidenceId ?? null, graphAllocationId: link.allocationId ?? null, receiptId: link.receiptId ?? null, role: link.role }) : null,
      null, null]);
  });
  const protectedLinks = persisted.links.filter((link) => link.bank_receipt_match_id !== null || link.bank_transaction_id !== null);
  const ordinaryPersistedLinks = persisted.links
    .filter((link) => link.bank_receipt_match_id === null && link.bank_transaction_id === null)
    .map((link) => [persistedEntryById.get(Number(link.ledger_entry_id))?.source_event_id, link.business_event_id, link.graph_evidence_id, link.graph_allocation_id, link.receipt_id, link.normalization_version, link.link_role, link.semantic_key, null, null]);
  const projectedEntries = projection.entries.map((entry) => [entry.sourceEventId, entry.currency, entry.eventAt, entry.semanticKey, entry.derivationRule, entry.derivationVersion, entry.derivationStatus, entry.certificationStatus, entry.reasonCode ?? null, entry.description ?? null]);
  const persistedEntryRows = persisted.entries.map((entry) => [entry.source_event_id, entry.currency, entry.event_at, entry.semantic_key, entry.derivation_rule, entry.derivation_version, entry.derivation_status, entry.certification_status, entry.reason_code, entry.description]);
   return persisted.entries.length === projection.entries.length
     && protectedLinks.every((link) => {
       const entry = persistedEntryById.get(Number(link.ledger_entry_id));
       return entry
         && Number(link.business_event_id) === Number(entry.source_event_id)
         && Number(link.bank_receipt_match_id) > 0
         && Number(link.bank_transaction_id) > 0
         && link.semantic_key;
     })
    && persisted.supersessions.every((row) => Number(row.scope_id) > 0
      && Number(row.superseded_ledger_entry_id) > 0
      && Number(row.replacement_ledger_entry_id) > 0
      && row.semantic_key
      && row.reason_code)
    && JSON.stringify(stableRows(persistedEntryRows)) === JSON.stringify(stableRows(projectedEntries))
    && JSON.stringify(stableRows(persistedPostings)) === JSON.stringify(stableRows(projectedPostings))
    && JSON.stringify(stableRows(ordinaryPersistedLinks)) === JSON.stringify(stableRows(projectedLinks))
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
}

async function persistEntry(tx, entry, accounts) {
  const row = (await tx.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description)
    VALUES((SELECT id FROM accounting_scopes WHERE scope_key=$1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(scope_id,semantic_key,derivation_rule,derivation_version,origin) DO UPDATE SET description=EXCLUDED.description,derivation_status=EXCLUDED.derivation_status,certification_status=EXCLUDED.certification_status,reason_code=EXCLUDED.reason_code
    RETURNING id,(xmax=0) AS created`, [entry.scopeKey, entry.sourceEventId, entry.currency, entry.eventAt, entry.semanticKey, entry.derivationRule, entry.derivationVersion, entry.derivationStatus, entry.certificationStatus, entry.origin, entry.reasonCode, entry.description])).rows[0];
  const entryId = Number(row.id);
  let postingCount = 0;
  if (entry.derivationStatus !== 'BLOCKED') {
    for (const posting of entry.postings) {
      const inserted = await tx.query(`INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit,source_allocation_id,source_receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`, [entryId, accounts.get(posting.account), entry.currency, posting.debit, posting.credit, posting.allocationId ?? null, posting.receiptId ?? null]);
      postingCount += inserted.rowCount;
    }
  }
  let linkCount = 0;
  for (const link of entry.links) {
    const semanticKey = fiscalContentFingerprint({ ledgerEntryId: entryId, businessEventId: entry.sourceEventId, graphEvidenceId: link.evidenceId ?? null, graphAllocationId: link.allocationId ?? null, receiptId: link.receiptId ?? null, role: link.role });
    const inserted = await tx.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,graph_allocation_id,receipt_id,normalization_version,link_role,semantic_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(semantic_key) DO NOTHING RETURNING id`, [entryId, entry.sourceEventId, link.evidenceId ?? null, link.allocationId ?? null, link.receiptId ?? null, link.normalizationVersion ?? null, link.role, semanticKey]);
    linkCount += inserted.rowCount;
  }
  return { entryId, created: Boolean(row.created), postings: postingCount, links: linkCount };
}

export async function rebuildLedger(pool, { scopeKey = 'default', dryRun = false, replace = false, failAfter = null, eventIds = null, projection: providedProjection = null, client: transactionClient = null } = {}) {
  let projection = providedProjection;
  if (dryRun) return summarizeLedgerProjection(projection ?? await loadLedgerProjection(pool, scopeKey, eventIds));
  const client = transactionClient ?? await pool.connect();
  const ownsTransaction = !transactionClient;
  try {
    // A no-op decision must not commit against a source snapshot that can be
    // invalidated by a concurrent writer after the projection is loaded.
    if (ownsTransaction) await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    if (!projection) projection = await loadLedgerProjection(client, scopeKey, eventIds);
    if (!replace && !transactionClient) {
      const scope = (await client.query('SELECT id FROM accounting_scopes WHERE scope_key=$1 FOR UPDATE', [scopeKey])).rows[0];
      if (!scope) {
        const error = new Error(`Accounting scope not found: ${scopeKey}`);
        error.code = 'ACCOUNTING_SCOPE_NOT_FOUND';
        throw error;
      }
      const persisted = await loadPersistedLedgerState(client, scopeKey, eventIds);
      const matches = ledgerProjectionMatches(projection, persisted);
      if (matches) {
        await client.query('COMMIT');
        return { ...summarizeLedgerProjection(projection), changed: false, created: { entries: 0, postings: 0, links: 0, blocked: 0 }, balancedViolations: 0 };
      }
      if (persisted.supersessions.length || persisted.links.some((link) => link.bank_receipt_match_id !== null || link.bank_transaction_id !== null)) {
        const error = new Error('Protected ledger overlay does not match the current projection');
        error.code = 'LEDGER_PROTECTED_OVERLAY_CONFLICT';
        throw error;
      }
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
    const accounts = await ensureAccounts(client, scopeKey);
    const created = { entries: 0, postings: 0, links: 0, blocked: 0 };
    for (const entry of projection.entries) {
      const persisted = await persistEntry(client, entry, accounts);
      created.entries += Number(persisted.created); created.postings += persisted.postings; created.links += persisted.links;
      if (entry.derivationStatus === 'BLOCKED') created.blocked += 1;
      if (failAfter !== null && created.entries >= Number(failAfter)) throw new Error('injected ledger builder failure');
    }
    const unbalanced = (await client.query(`SELECT count(*)::int AS count FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING SUM(debit)<>SUM(credit)) q`)).rows[0].count;
    if (Number(unbalanced) !== 0) throw new Error(`Ledger is unbalanced: ${unbalanced}`);
    if (ownsTransaction) await client.query('COMMIT');
    return { ...summarizeLedgerProjection(projection), created, balancedViolations: Number(unbalanced) };
  } catch (error) { if (ownsTransaction) await client.query('ROLLBACK'); throw error; } finally { if (ownsTransaction) client.release(); }
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

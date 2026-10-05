import crypto from 'node:crypto';
import {
  BUSINESS_EVENT_CANDIDATE_KINDS,
  BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES,
  projectBankBusinessEventCandidate,
  projectBankBusinessEventCandidates,
  TRANSFER_DIRECTIONS,
} from './bank-business-event-candidate-projection.js';
import { loadBalancedBankJournalProjection } from './balanced-bank-journal-projection.js';

export const BANK_INTERNAL_TRANSFER_MATCHING_VERSION = 'bank-internal-transfer-matching-v1';
export const INTERNAL_TRANSFER_MATCH_STATUSES = Object.freeze({
  MATCHED: 'MATCHED',
  UNMATCHED: 'UNMATCHED',
  AMBIGUOUS: 'AMBIGUOUS',
  INELIGIBLE: 'INELIGIBLE',
});

const REQUIRED_CANDIDATE_FIELDS = [
  'modelVersion', 'projectionStatus', 'candidateKey', 'journalKey', 'bankTransactionId',
  'scopeKey', 'occurredAt', 'amount', 'currency', 'sourceEventType', 'direction',
  'candidateKind', 'businessEventType', 'transferDirection', 'bankSide',
  'sourceProvenance',
];

function stableJson(value) { return JSON.stringify(value); }

function positiveInteger(value) { return Number.isInteger(value) && value > 0; }

function nonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }

function canonicalOwner(row) {
  if (!row || !positiveInteger(Number(row.financialAccountId ?? row.accountId))
    || !positiveInteger(Number(row.personId))
    || !nonEmptyString(row.accountScopeKey)
    || !nonEmptyString(row.personScopeKey)
    || row.relationType !== 'OWNER'
    || !nonEmptyString(row.provenance)
    || row.accountScopeKey !== row.personScopeKey) return null;
  return {
    financialAccountId: Number(row.financialAccountId ?? row.accountId),
    accountScopeKey: row.accountScopeKey,
    personId: Number(row.personId),
    personScopeKey: row.personScopeKey,
    relationType: 'OWNER',
    provenance: row.provenance,
  };
}

export function buildBankInternalTransferOwnershipSnapshot(rows) {
  if (!Array.isArray(rows)) throw new Error('ownership rows must be an array');
  const accounts = new Map();
  for (const row of rows) {
    const owner = canonicalOwner(row);
    const accountId = Number(row?.financialAccountId ?? row?.accountId);
    if (!positiveInteger(accountId)) continue;
    const accountScopeKey = typeof row.accountScopeKey === 'string' ? row.accountScopeKey : null;
    const current = accounts.get(accountId) ?? { financialAccountId: accountId, accountScopeKey, owners: [], invalid: false };
    if (current.accountScopeKey !== accountScopeKey) current.invalid = true;
    if (owner) current.owners.push(owner);
    accounts.set(accountId, current);
  }
  return {
    modelVersion: BANK_INTERNAL_TRANSFER_MATCHING_VERSION,
    accounts: [...accounts.values()]
      .map((account) => ({
        financialAccountId: account.financialAccountId,
        accountScopeKey: account.invalid ? null : account.accountScopeKey,
        owners: [...new Map(account.owners.map((owner) => [stableJson(owner), owner])).values()]
          .sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
      }))
      .sort((left, right) => left.financialAccountId - right.financialAccountId),
  };
}

function accountSnapshot(snapshot, accountId) {
  return (snapshot.accounts ?? []).find((account) => account.financialAccountId === accountId) ?? null;
}

function validateOwnershipSnapshot(snapshot) {
  if (!snapshot || snapshot.modelVersion !== BANK_INTERNAL_TRANSFER_MATCHING_VERSION) {
    throw new Error('ownershipSnapshot modelVersion is invalid');
  }
  if (!Array.isArray(snapshot.accounts)) throw new Error('ownershipSnapshot accounts must be an array');
  const accountIds = new Set();
  const accounts = snapshot.accounts.map((account) => {
    if (!account || !positiveInteger(account.financialAccountId)
      || accountIds.has(account.financialAccountId)
      || !nonEmptyString(account.accountScopeKey)
      || !Array.isArray(account.owners)) {
      throw new Error('ownershipSnapshot account contract is invalid');
    }
    accountIds.add(account.financialAccountId);
    const ownerIds = new Map();
    const owners = account.owners.map((owner) => {
      if (!owner || owner.financialAccountId !== account.financialAccountId
        || owner.accountScopeKey !== account.accountScopeKey
        || !positiveInteger(owner.personId)
        || !nonEmptyString(owner.personScopeKey)
        || owner.personScopeKey !== account.accountScopeKey
        || owner.relationType !== 'OWNER'
        || !nonEmptyString(owner.provenance)) {
        throw new Error('ownershipSnapshot owner contract is invalid');
      }
      const prior = ownerIds.get(owner.personId);
      const canonical = {
        financialAccountId: owner.financialAccountId,
        accountScopeKey: owner.accountScopeKey,
        personId: owner.personId,
        personScopeKey: owner.personScopeKey,
        relationType: 'OWNER',
        provenance: owner.provenance,
      };
      if (prior && stableJson(prior) !== stableJson(canonical)) {
        throw new Error('ownershipSnapshot has conflicting duplicate owner evidence');
      }
      ownerIds.set(owner.personId, canonical);
      return canonical;
    });
    return {
      financialAccountId: account.financialAccountId,
      accountScopeKey: account.accountScopeKey,
      owners: [...ownerIds.values()].sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    };
  });
  return {
    modelVersion: BANK_INTERNAL_TRANSFER_MATCHING_VERSION,
    accounts: accounts.sort((left, right) => left.financialAccountId - right.financialAccountId),
  };
}

function candidateProjectionMatches(supplied, regenerated) {
  return REQUIRED_CANDIDATE_FIELDS.every((field) => stableJson(supplied?.[field]) === stableJson(regenerated?.[field]));
}

function validateMaxTimeDelta(maxTimeDeltaMs) {
  if (!Number.isSafeInteger(maxTimeDeltaMs) || maxTimeDeltaMs <= 0) {
    throw new Error('maxTimeDeltaMs must be a finite positive safe integer');
  }
}

function statusKey(status) {
  return stableJson({
    candidateKey: status.candidateKey,
    bankTransactionId: status.bankTransactionId,
    status: status.status,
    reasonCode: status.reasonCode,
  });
}

function statusRow(entry, status, reasonCode) {
  const candidate = entry?.candidate;
  return {
    candidateKey: candidate?.candidateKey ?? null,
    bankTransactionId: positiveInteger(candidate?.bankTransactionId) ? candidate.bankTransactionId : null,
    status,
    reasonCode,
  };
}

function transferEligible(candidate) {
  return candidate?.projectionStatus === BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.PROJECTED
    && candidate.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER
    && candidate.businessEventType === 'TRANSFER'
    && (candidate.transferDirection === TRANSFER_DIRECTIONS.OUTGOING
      || candidate.transferDirection === TRANSFER_DIRECTIONS.INCOMING)
    && candidate.bankSide?.type === 'FINANCIAL_ACCOUNT'
    && positiveInteger(candidate.bankSide.financialAccountId);
}

function parseTime(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function matchFingerprint(outgoing, incoming, ownerPersonId, outgoingOwner, incomingOwner, maxTimeDeltaMs, timeDeltaMs) {
  return {
    modelVersion: BANK_INTERNAL_TRANSFER_MATCHING_VERSION,
    maxTimeDeltaMs,
    scopeKey: outgoing.candidate.scopeKey,
    amount: outgoing.candidate.amount,
    currency: outgoing.candidate.currency,
    ownerPersonId,
    timeDeltaMs,
    outgoing: {
      candidateKey: outgoing.candidate.candidateKey,
      journalKey: outgoing.candidate.journalKey,
      bankTransactionId: outgoing.candidate.bankTransactionId,
      financialAccountId: outgoing.candidate.bankSide.financialAccountId,
      occurredAt: outgoing.candidate.occurredAt,
    },
    incoming: {
      candidateKey: incoming.candidate.candidateKey,
      journalKey: incoming.candidate.journalKey,
      bankTransactionId: incoming.candidate.bankTransactionId,
      financialAccountId: incoming.candidate.bankSide.financialAccountId,
      occurredAt: incoming.candidate.occurredAt,
    },
    outgoingOwnerEvidence: [outgoingOwner],
    incomingOwnerEvidence: [incomingOwner],
  };
}

function makeMatch(outgoing, incoming, commonOwner, outgoingAccount, incomingAccount, maxTimeDeltaMs, timeDeltaMs) {
  const outgoingOwner = outgoingAccount.owners.find((owner) => owner.personId === commonOwner);
  const incomingOwner = incomingAccount.owners.find((owner) => owner.personId === commonOwner);
  if (!outgoingOwner || !incomingOwner) throw new Error('common owner evidence is missing');
  const fingerprint = matchFingerprint(
    outgoing,
    incoming,
    commonOwner,
    outgoingOwner,
    incomingOwner,
    maxTimeDeltaMs,
    timeDeltaMs,
  );
  const matchKey = crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
  return {
    modelVersion: BANK_INTERNAL_TRANSFER_MATCHING_VERSION,
    matchStatus: INTERNAL_TRANSFER_MATCH_STATUSES.MATCHED,
    matchKey,
    businessEventType: 'INTERNAL_TRANSFER',
    scopeKey: outgoing.candidate.scopeKey,
    ownerPersonId: commonOwner,
    amount: outgoing.candidate.amount,
    currency: outgoing.candidate.currency,
    maxTimeDeltaMs,
    timeDeltaMs,
    outgoing: {
      candidateKey: outgoing.candidate.candidateKey,
      journalKey: outgoing.candidate.journalKey,
      bankTransactionId: outgoing.candidate.bankTransactionId,
      financialAccountId: outgoing.candidate.bankSide.financialAccountId,
      occurredAt: outgoing.candidate.occurredAt,
    },
    incoming: {
      candidateKey: incoming.candidate.candidateKey,
      journalKey: incoming.candidate.journalKey,
      bankTransactionId: incoming.candidate.bankTransactionId,
      financialAccountId: incoming.candidate.bankSide.financialAccountId,
      occurredAt: incoming.candidate.occurredAt,
    },
    ownershipProvenance: {
      outgoing: [outgoingOwner],
      incoming: [incomingOwner],
    },
    reasonCode: 'PROVEN_TWO_SIDED_OWN_ACCOUNT_TRANSFER',
  };
}

function ownerIntersection(left, right) {
  const rightIds = new Set(right.owners.map((owner) => owner.personId));
  return [...new Set(left.owners.filter((owner) => rightIds.has(owner.personId)).map((owner) => owner.personId))].sort((a, b) => a - b);
}

function compatible(left, right, snapshot, maxTimeDeltaMs) {
  const outgoing = left.candidate.transferDirection === TRANSFER_DIRECTIONS.OUTGOING ? left : right;
  const incoming = left.candidate.transferDirection === TRANSFER_DIRECTIONS.INCOMING ? left : right;
  if (outgoing.candidate.transferDirection !== TRANSFER_DIRECTIONS.OUTGOING
    || incoming.candidate.transferDirection !== TRANSFER_DIRECTIONS.INCOMING) return null;
  const a = outgoing.candidate;
  const b = incoming.candidate;
  if (a.bankTransactionId === b.bankTransactionId || a.journalKey === b.journalKey
    || a.bankSide.financialAccountId === b.bankSide.financialAccountId
    || !nonEmptyString(a.scopeKey) || a.scopeKey !== b.scopeKey
    || a.amount !== b.amount || a.currency !== b.currency) return null;
  const outgoingAccount = accountSnapshot(snapshot, a.bankSide.financialAccountId);
  const incomingAccount = accountSnapshot(snapshot, b.bankSide.financialAccountId);
  if (!outgoingAccount || !incomingAccount
    || outgoingAccount.accountScopeKey !== a.scopeKey
    || incomingAccount.accountScopeKey !== b.scopeKey) return null;
  const commonOwners = ownerIntersection(outgoingAccount, incomingAccount);
  if (commonOwners.length !== 1) return null;
  const outgoingTime = parseTime(a.occurredAt);
  const incomingTime = parseTime(b.occurredAt);
  if (outgoingTime == null || incomingTime == null) return null;
  const timeDeltaMs = Math.abs(outgoingTime - incomingTime);
  if (timeDeltaMs > maxTimeDeltaMs) return null;
  return { outgoing, incoming, outgoingAccount, incomingAccount, ownerPersonId: commonOwners[0], timeDeltaMs };
}

function assertNoDuplicateIdentity(entries) {
  for (const field of ['candidateKey', 'journalKey', 'bankTransactionId']) {
    const seen = new Set();
    for (const entry of entries) {
      const value = entry?.candidate?.[field];
      if (value == null) continue;
      if (seen.has(String(value))) throw new Error(`duplicate ${field} input`);
      seen.add(String(value));
    }
  }
}

function normalizeEntries(entries) {
  assertNoDuplicateIdentity(entries);
  return entries.map((entry, index) => {
    const regenerated = projectBankBusinessEventCandidate(entry?.journal);
    if (regenerated.projectionStatus !== BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.PROJECTED) {
      return { entry, index, candidate: entry?.candidate, ineligibleReason: 'JOURNAL_PROJECTION_UNRESOLVED' };
    }
    if (!candidateProjectionMatches(entry?.candidate, regenerated)) {
      return { entry, index, candidate: entry?.candidate, ineligibleReason: 'CANDIDATE_JOURNAL_MISMATCH' };
    }
    if (!transferEligible(regenerated)) {
      return { entry, index, candidate: regenerated, ineligibleReason: 'CANDIDATE_NOT_ELIGIBLE_TRANSFER' };
    }
    return { entry, index, candidate: regenerated };
  });
}

export function matchBankInternalTransfers(entries, ownershipSnapshot, { maxTimeDeltaMs } = {}) {
  validateMaxTimeDelta(maxTimeDeltaMs);
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  const canonicalSnapshot = validateOwnershipSnapshot(ownershipSnapshot);
  const normalized = normalizeEntries(entries);
  const statuses = new Map();
  for (const row of normalized) {
    if (row.ineligibleReason) statuses.set(row.index, statusRow(row.entry, INTERNAL_TRANSFER_MATCH_STATUSES.INELIGIBLE, row.ineligibleReason));
  }
  const eligible = normalized.filter((row) => !row.ineligibleReason);
  const outgoing = eligible.filter((row) => row.candidate.transferDirection === TRANSFER_DIRECTIONS.OUTGOING);
  const incoming = eligible.filter((row) => row.candidate.transferDirection === TRANSFER_DIRECTIONS.INCOMING);
  const edges = [];
  for (const left of outgoing) {
    for (const right of incoming) {
      const edge = compatible(left, right, canonicalSnapshot, maxTimeDeltaMs);
      if (edge) edges.push(edge);
    }
  }
  const adjacency = new Map(eligible.map((row) => [row.index, []]));
  for (const edge of edges) {
    adjacency.get(edge.outgoing.index).push(edge.incoming.index);
    adjacency.get(edge.incoming.index).push(edge.outgoing.index);
  }
  const matches = [];
  const visited = new Set();
  const edgeFor = (left, right) => edges.find((edge) => edge.outgoing.index === left && edge.incoming.index === right);
  for (const row of eligible) {
    if (visited.has(row.index)) continue;
    const component = [];
    const queue = [row.index];
    visited.add(row.index);
    while (queue.length) {
      const index = queue.shift();
      component.push(index);
      for (const adjacent of adjacency.get(index) ?? []) {
        if (!visited.has(adjacent)) { visited.add(adjacent); queue.push(adjacent); }
      }
    }
    if (component.length === 1 && (adjacency.get(component[0]) ?? []).length === 0) {
      const item = normalized.find((candidate) => candidate.index === component[0]);
      statuses.set(component[0], statusRow(item.entry, INTERNAL_TRANSFER_MATCH_STATUSES.UNMATCHED, 'NO_COMPATIBLE_COUNTERPART'));
      continue;
    }
    const componentOutgoing = component.filter((index) => outgoing.some((item) => item.index === index));
    const componentIncoming = component.filter((index) => incoming.some((item) => item.index === index));
    if (component.length !== 2 || componentOutgoing.length !== 1 || componentIncoming.length !== 1
      || (adjacency.get(componentOutgoing[0]) ?? []).length !== 1
      || (adjacency.get(componentIncoming[0]) ?? []).length !== 1) {
      for (const index of component) {
        const item = normalized.find((candidate) => candidate.index === index);
        statuses.set(index, statusRow(item.entry, INTERNAL_TRANSFER_MATCH_STATUSES.AMBIGUOUS, 'MULTIPLE_COMPATIBLE_CANDIDATES'));
      }
      continue;
    }
    const edge = edgeFor(componentOutgoing[0], componentIncoming[0]);
    const outgoingItem = normalized.find((item) => item.index === componentOutgoing[0]);
    const incomingItem = normalized.find((item) => item.index === componentIncoming[0]);
    matches.push(makeMatch(edge.outgoing, edge.incoming, edge.ownerPersonId, edge.outgoingAccount, edge.incomingAccount, maxTimeDeltaMs, edge.timeDeltaMs));
    statuses.set(outgoingItem.index, statusRow(outgoingItem.entry, INTERNAL_TRANSFER_MATCH_STATUSES.MATCHED, 'PROVEN_TWO_SIDED_OWN_ACCOUNT_TRANSFER'));
    statuses.set(incomingItem.index, statusRow(incomingItem.entry, INTERNAL_TRANSFER_MATCH_STATUSES.MATCHED, 'PROVEN_TWO_SIDED_OWN_ACCOUNT_TRANSFER'));
  }
  const candidateStatuses = normalized.map((row) => statuses.get(row.index)
    ?? statusRow(row.entry, INTERNAL_TRANSFER_MATCH_STATUSES.UNMATCHED, 'NO_COMPATIBLE_COUNTERPART'))
    .sort((left, right) => statusKey(left).localeCompare(statusKey(right)));
  matches.sort((left, right) => left.matchKey.localeCompare(right.matchKey));
  const summary = {
    totalInputCandidates: entries.length,
    eligibleTransfers: eligible.length,
    matchedTransfers: candidateStatuses.filter((row) => row.status === INTERNAL_TRANSFER_MATCH_STATUSES.MATCHED).length,
    internalTransferMatches: matches.length,
    unmatchedTransfers: candidateStatuses.filter((row) => row.status === INTERNAL_TRANSFER_MATCH_STATUSES.UNMATCHED).length,
    ambiguousTransfers: candidateStatuses.filter((row) => row.status === INTERNAL_TRANSFER_MATCH_STATUSES.AMBIGUOUS).length,
    ineligibleCandidates: candidateStatuses.filter((row) => row.status === INTERNAL_TRANSFER_MATCH_STATUSES.INELIGIBLE).length,
    ineligibleByReason: Object.fromEntries(candidateStatuses.filter((row) => row.status === INTERNAL_TRANSFER_MATCH_STATUSES.INELIGIBLE)
      .reduce((counts, row) => counts.set(row.reasonCode, (counts.get(row.reasonCode) ?? 0) + 1), new Map())),
  };
  if (summary.matchedTransfers !== summary.internalTransferMatches * 2) throw new Error('Internal transfer matching cardinality invariant failed');
  return { matches, candidateStatuses, summary };
}

export async function loadBankInternalTransferOwnershipSnapshot(pool, financialAccountIds) {
  if (!Array.isArray(financialAccountIds)) throw new Error('financialAccountIds must be an array');
  const ids = [...new Set(financialAccountIds.filter(positiveInteger))].sort((a, b) => a - b);
  if (!ids.length) return buildBankInternalTransferOwnershipSnapshot([]);
  const result = await pool.query(`
    SELECT a.id AS "financialAccountId", account_scope.scope_key AS "accountScopeKey",
           p.id AS "personId", person_scope.scope_key AS "personScopeKey",
           far.relation_type AS "relationType", far.provenance
    FROM financial_accounts a
    JOIN accounting_scopes account_scope ON account_scope.id=a.scope_id
    JOIN financial_account_person_relations far ON far.financial_account_id=a.id
    JOIN persons p ON p.id=far.person_id
    JOIN accounting_scopes person_scope ON person_scope.id=p.scope_id
    WHERE a.id=ANY($1::bigint[]) AND far.relation_type='OWNER'
    ORDER BY a.id, p.id, far.provenance`, [ids]);
  return buildBankInternalTransferOwnershipSnapshot(result.rows);
}

export async function loadBankInternalTransferMatching(pool, { scopeKey = null, from = null, to = null, maxTimeDeltaMs } = {}) {
  validateMaxTimeDelta(maxTimeDeltaMs);
  const journalProjection = await loadBalancedBankJournalProjection(pool, { scopeKey, from, to });
  const candidateProjection = projectBankBusinessEventCandidates(journalProjection.projections);
  const journalsByTransaction = new Map(journalProjection.projections.map((journal) => [journal.bankTransactionId, journal]));
  const entries = candidateProjection.projections.map((candidate) => ({
    candidate,
    journal: (() => {
      const journal = journalsByTransaction.get(candidate.bankTransactionId);
      return journal && journal.journalKey === candidate.journalKey ? journal : undefined;
    })(),
  }));
  const accountIds = entries
    .filter(({ candidate }) => candidate.projectionStatus === BUSINESS_EVENT_CANDIDATE_PROJECTION_STATUSES.PROJECTED
      && candidate.candidateKind === BUSINESS_EVENT_CANDIDATE_KINDS.TRANSFER
      && candidate.businessEventType === 'TRANSFER'
      && (candidate.transferDirection === TRANSFER_DIRECTIONS.OUTGOING
        || candidate.transferDirection === TRANSFER_DIRECTIONS.INCOMING)
      && candidate.bankSide?.type === 'FINANCIAL_ACCOUNT')
    .map(({ candidate }) => candidate.bankSide.financialAccountId);
  const snapshot = await loadBankInternalTransferOwnershipSnapshot(pool, accountIds);
  return matchBankInternalTransfers(entries, snapshot, { maxTimeDeltaMs });
}

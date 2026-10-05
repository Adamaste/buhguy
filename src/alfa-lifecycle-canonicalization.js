import crypto from 'node:crypto';
import {
  projectBankCashFlowTransaction,
} from './bank-cash-flow-projection.js';

export const ALFA_LIFECYCLE_CANONICALIZATION_VERSION = 'alfa-lifecycle-canonicalization-v1';
export const ALFA_LIFECYCLE_RULE_VERSION = 'alfa-primary-update-empty-v1';
export const ALFA_PROVIDER = 'ru.alfabank.mobile.android';

const ADAPTER = 'android-notification';
const SCHEMA_VERSION = '1';
const PROJECTED = 'PROJECTED';
const UNRESOLVED = 'UNRESOLVED';

// These bounds are derived from the three observed lifecycle topologies:
// primary->update is 10-12s and update->empty is 0-0.5s by event time.
const PRIMARY_UPDATE_MIN_MS = 10_000;
const PRIMARY_UPDATE_MAX_MS = 12_000;
const UPDATE_COMPANION_MIN_MS = 0;
const UPDATE_COMPANION_MAX_MS = 500;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function metadata(row) {
  return row?.ingestionMetadata ?? {};
}

function sameSource(a, b) {
  const left = metadata(a);
  const right = metadata(b);
  return left.provider === ALFA_PROVIDER
    && right.provider === ALFA_PROVIDER
    && left.adapter === ADAPTER
    && right.adapter === ADAPTER
    && left.schemaVersion === SCHEMA_VERSION
    && right.schemaVersion === SCHEMA_VERSION
    && left.sourcePackage === right.sourcePackage
    && (left.notificationChannel ?? null) === (right.notificationChannel ?? null);
}

function canonicalDecimal(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? ''));
  if (!match) return null;
  const integer = match[1].replace(/^0+(?=\d)/, '');
  return `${integer}.${(match[2] ?? '').padEnd(2, '0')}`;
}

function iso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function payloadFields(row) {
  const payload = row?.payload ?? {};
  const description = text(payload.description);
  const body = description.trim() !== '' ? description : text(payload.text);
  return { payload, description, body };
}

function primaryFacts(row) {
  const { payload, description, body } = payloadFields(row);
  const title = text(payload.title).trim();
  if (!/^[\p{L}\p{M}]+-[\p{L}\p{M}]+$/u.test(title)) return null;
  if (!description.trim() || description !== text(payload.text)) return null;
  if (body.includes(';') || !body.includes('RUB')) return null;
  const match = /^(?:[\p{L}\p{M}]+\s+){3}[\p{L}\p{M}]+:\s+(\d+)\.\s+[\p{L}\p{M}]+\s+(\d+\.\d{1,2})\s+RUB\s+[\p{L}\p{M}]+\s+[\p{L}\p{M}]+$/u.exec(body);
  if (!match) return null;
  const occurredAt = iso(row.eventTime ?? row.occurredAt);
  if (!occurredAt) return null;
  return { amount: canonicalDecimal(match[2]), occurredAt };
}

function updateFacts(row) {
  const { payload, description, body } = payloadFields(row);
  const titleMatch = /^-\s*(\d+)\s+₽\.\s+[\p{L}\p{M}]+$/u.exec(text(payload.title).trim());
  if (!titleMatch || !description.trim() || description !== text(payload.text)) return null;
  if (!/^[\p{L}\p{M}]+:\s+\d+,\d{2}\s+₽;\s+(?:••|··|•|\*)\s*\d{4}$/u.test(body)) return null;
  const occurredAt = iso(row.eventTime ?? row.occurredAt);
  if (!occurredAt) return null;
  return { amount: canonicalDecimal(titleMatch[1]), occurredAt };
}

function emptyFacts(row) {
  const { payload } = payloadFields(row);
  const hasContent = ['title', 'description', 'text', 'reference']
    .some((key) => text(payload[key]).trim() !== '');
  return hasContent ? null : { occurredAt: iso(row.eventTime ?? row.occurredAt) };
}

function classify(row) {
  if (!row || !Number.isInteger(Number(row.observationId)) || !Number.isInteger(Number(row.bankTransactionId))) return { kind: 'OTHER' };
  const source = metadata(row);
  if (source.provider !== ALFA_PROVIDER || source.adapter !== ADAPTER || source.schemaVersion !== SCHEMA_VERSION) return { kind: 'OTHER' };
  const primary = primaryFacts(row);
  if (primary) return { kind: 'PRIMARY', facts: primary };
  const update = updateFacts(row);
  if (update) return { kind: 'UPDATE', facts: update };
  const empty = emptyFacts(row);
  if (empty) return { kind: 'EMPTY', facts: empty };
  if (/^[-+]\s*\d+(?:[.,]\d{1,2})?\s+₽$/u.test(text(row.payload?.title).trim())) return { kind: 'F5_TRANSFER_OWNED_BY_PROVIDER_NORMALIZER' };
  return { kind: 'OTHER' };
}

function deltaMs(later, earlier) {
  return new Date(later).getTime() - new Date(earlier).getTime();
}

function projectionKey(candidate) {
  const material = {
    modelVersion: ALFA_LIFECYCLE_CANONICALIZATION_VERSION,
    ruleVersion: ALFA_LIFECYCLE_RULE_VERSION,
    primaryObservationId: candidate.sourceProvenance.primaryObservationId,
    primaryTransactionId: candidate.sourceProvenance.primaryTransactionId,
    updateObservationId: candidate.sourceProvenance.updateObservationId,
    updateTransactionId: candidate.sourceProvenance.updateTransactionId,
    companionObservationId: candidate.sourceProvenance.companionObservationId,
    companionTransactionId: candidate.sourceProvenance.companionTransactionId,
    occurredAt: candidate.occurredAt,
    amount: candidate.amount,
    currency: candidate.currency,
    eventType: candidate.eventType,
    direction: candidate.direction,
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function unresolvedResult(primaryObservationId, reasonCode, related = {}) {
  return { primaryObservationId, status: UNRESOLVED, reasonCode, ...related };
}

function validCompanion(primary, update, empty) {
  if (!sameSource(primary, update) || !sameSource(update, empty)) return false;
  const primaryTime = iso(primary.eventTime ?? primary.occurredAt);
  const updateTime = iso(update.eventTime ?? update.occurredAt);
  const emptyTime = iso(empty.eventTime ?? empty.occurredAt);
  if (!primaryTime || !updateTime || !emptyTime) return false;
  const primaryUpdate = deltaMs(updateTime, primaryTime);
  const updateEmpty = deltaMs(emptyTime, updateTime);
  return primaryUpdate >= PRIMARY_UPDATE_MIN_MS
    && primaryUpdate <= PRIMARY_UPDATE_MAX_MS
    && updateEmpty >= UPDATE_COMPANION_MIN_MS
    && updateEmpty <= UPDATE_COMPANION_MAX_MS;
}

function candidate(primary, update, empty, primaryClass, updateClass) {
  const result = {
    modelVersion: ALFA_LIFECYCLE_CANONICALIZATION_VERSION,
    projectionStatus: PROJECTED,
    projectionKey: null,
    eventType: 'UNKNOWN',
    direction: 'DEBIT',
    normalizationVersion: ALFA_LIFECYCLE_CANONICALIZATION_VERSION,
    amount: primaryClass.facts.amount,
    currency: 'RUB',
    occurredAt: primaryClass.facts.occurredAt,
    normalizationStatus: 'READY',
    evidenceQuality: 'EXACT',
    merchant: null,
    counterparty: null,
    accountReference: null,
    accountReferenceKind: null,
    sourceProvenance: {
      projectionModelVersion: ALFA_LIFECYCLE_CANONICALIZATION_VERSION,
      structuralRuleVersion: ALFA_LIFECYCLE_RULE_VERSION,
      primaryObservationId: Number(primary.observationId),
      primaryTransactionId: Number(primary.bankTransactionId),
      updateObservationId: Number(update.observationId),
      updateTransactionId: Number(update.bankTransactionId),
      companionObservationId: Number(empty.observationId),
      companionTransactionId: Number(empty.bankTransactionId),
      updateRole: 'DIRECTION_EVIDENCE_ONLY',
      companionRole: 'NON_MONETARY',
      reasonCode: 'PRIMARY_WITH_UNIQUE_DEBIT_UPDATE_AND_EMPTY_COMPANION',
    },
  };
  result.projectionKey = projectionKey(result);
  return result;
}

export function projectAlfaLifecycle(rows) {
  const classified = rows.map((row) => ({ row, classification: classify(row) }));
  const primaries = classified.filter((item) => item.classification.kind === 'PRIMARY');
  const updates = classified.filter((item) => item.classification.kind === 'UPDATE');
  const empties = classified.filter((item) => item.classification.kind === 'EMPTY');
  const candidates = [];
  const unresolvedRows = [];
  const possible = [];

  for (const primaryItem of primaries) {
    const primary = primaryItem.row;
    const primaryTime = iso(primary.eventTime ?? primary.occurredAt);
    const topologicalUpdates = updates.filter((updateItem) => {
      const updateTime = iso(updateItem.row.eventTime ?? updateItem.row.occurredAt);
      if (!primaryTime || !updateTime || !sameSource(primary, updateItem.row)) return false;
      const delta = deltaMs(updateTime, primaryTime);
      return delta >= PRIMARY_UPDATE_MIN_MS && delta <= PRIMARY_UPDATE_MAX_MS;
    });
    const matchingUpdates = topologicalUpdates.filter((updateItem) => updateItem.classification.facts.amount === primaryItem.classification.facts.amount);
    if (topologicalUpdates.length > 0 && matchingUpdates.length === 0) {
      unresolvedRows.push(unresolvedResult(Number(primary.observationId), 'AMOUNT_MISMATCH'));
      continue;
    }
    const combos = matchingUpdates.flatMap((updateItem) => empties
      .filter((emptyItem) => validCompanion(primary, updateItem.row, emptyItem.row))
      .map((emptyItem) => ({ updateItem, emptyItem })));
    if (combos.length === 0) {
      unresolvedRows.push(unresolvedResult(Number(primary.observationId), topologicalUpdates.length === 0 ? 'MISSING_DIRECTION_UPDATE' : 'MISSING_COMPANION'));
      continue;
    }
    if (combos.length !== 1) {
      unresolvedRows.push(unresolvedResult(Number(primary.observationId), 'AMBIGUOUS_LIFECYCLE'));
      continue;
    }
    possible.push({ primaryItem, ...combos[0] });
  }

  const updateUsers = new Map();
  const emptyUsers = new Map();
  for (const match of possible) {
    const updateId = Number(match.updateItem.row.observationId);
    const emptyId = Number(match.emptyItem.row.observationId);
    updateUsers.set(updateId, [...(updateUsers.get(updateId) ?? []), match]);
    emptyUsers.set(emptyId, [...(emptyUsers.get(emptyId) ?? []), match]);
  }
  const conflicted = new Set();
  for (const matches of [...updateUsers.values(), ...emptyUsers.values()]) {
    if (matches.length > 1) for (const match of matches) conflicted.add(Number(match.primaryItem.row.observationId));
  }
  for (const match of possible) {
    const primary = match.primaryItem.row;
    if (conflicted.has(Number(primary.observationId))) {
      unresolvedRows.push(unresolvedResult(Number(primary.observationId), 'AMBIGUOUS_LIFECYCLE'));
      continue;
    }
    candidates.push(candidate(primary, match.updateItem.row, match.emptyItem.row, match.primaryItem.classification, match.updateItem.classification));
  }
  return {
    candidates,
    unresolved: unresolvedRows,
    memberClassifications: classified.map(({ row, classification }) => ({
      observationId: Number(row.observationId),
      transactionId: Number(row.bankTransactionId),
      kind: classification.kind,
    })),
  };
}

export function toBankCashFlowProjectionInput(candidate, { sourceScopeKeys = ['UNRESOLVED_SCOPE'] } = {}) {
  if (!candidate || candidate.projectionStatus !== PROJECTED) throw new Error('A projected candidate is required');
  return {
    bankTransactionId: candidate.sourceProvenance.primaryTransactionId,
    occurredAt: candidate.occurredAt,
    amount: candidate.amount,
    currency: candidate.currency,
    sourceEventType: candidate.eventType,
    direction: candidate.direction,
    normalizationStatus: candidate.normalizationStatus,
    evidenceQuality: candidate.evidenceQuality,
    sourceScopeKeys,
    accountResolutionState: 'UNKNOWN',
  };
}

export function projectAlfaLifecycleCashFlow(candidate, options = {}) {
  return projectBankCashFlowTransaction(toBankCashFlowProjectionInput(candidate, options));
}

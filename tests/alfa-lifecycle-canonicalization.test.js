import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALFA_LIFECYCLE_CANONICALIZATION_VERSION,
  projectAlfaLifecycle,
  projectAlfaLifecycleCashFlow,
} from '../src/alfa-lifecycle-canonicalization.js';
import { projectBalancedBankJournal } from '../src/balanced-bank-journal-projection.js';

const metadata = {
  provider: 'ru.alfabank.mobile.android',
  adapter: 'android-notification',
  schemaVersion: '1',
  sourcePackage: 'ru.alfabank.mobile.android',
  notificationChannel: 'AlfaBank',
};

const primaryPayload = (amount = '2468.00') => ({
  title: 'СИНТЕТИЧЕСКИЙ-ЗАГОЛОВОК',
  description: `СЛОВО ДВА ТРИ ЧЕТЫРЕ: 1111. СЧЕТ ${amount} RUB ТЕСТ ЗНАЧЕНИЕ`,
  text: `СЛОВО ДВА ТРИ ЧЕТЫРЕ: 1111. СЧЕТ ${amount} RUB ТЕСТ ЗНАЧЕНИЕ`,
});

const updatePayload = (amount = '2468') => ({
  title: `- ${amount} ₽. МЕТРО`,
  description: 'ОСТАТОК: 1111,11 ₽; ••0271',
  text: 'ОСТАТОК: 1111,11 ₽; ••0271',
});

const emptyPayload = {};

function row(observationId, bankTransactionId, eventTime, payload, overrides = {}) {
  return {
    observationId,
    bankTransactionId,
    eventTime,
    observedAt: eventTime,
    payload,
    ingestionMetadata: { ...metadata, ...overrides.ingestionMetadata },
  };
}

function lifecycle({ amount = '2468.00', start = '2026-10-04T20:00:00.000Z' } = {}) {
  const base = new Date(start).getTime();
  const at = (offset) => new Date(base + offset).toISOString();
  return [
    row(437, 341, at(0), primaryPayload(amount)),
    row(438, 342, at(11_000), updatePayload(amount.replace('.00', ''))),
    row(439, 343, at(11_200), emptyPayload),
  ];
}

test('controlled A and B each produce exactly one UNKNOWN/DEBIT candidate', () => {
  const a = projectAlfaLifecycle(lifecycle());
  const b = projectAlfaLifecycle(lifecycle({ amount: '9753.00', start: '2026-10-05T08:00:00.000Z' }));
  for (const result of [a, b]) {
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].eventType, 'UNKNOWN');
    assert.equal(result.candidates[0].direction, 'DEBIT');
    assert.equal(result.candidates[0].normalizationVersion, ALFA_LIFECYCLE_CANONICALIZATION_VERSION);
    assert.equal(result.candidates[0].normalizationStatus, 'READY');
    assert.equal(result.candidates[0].evidenceQuality, 'EXACT');
  }
  assert.equal(a.candidates[0].amount, '2468.00');
  assert.equal(b.candidates[0].amount, '9753.00');
});

test('natural same-shaped lifecycle remains UNKNOWN/DEBIT and never PURCHASE', () => {
  const result = projectAlfaLifecycle(lifecycle({ start: '2026-10-05T09:00:00.000Z' }));
  assert.equal(result.candidates[0].eventType, 'UNKNOWN');
  assert.notEqual(result.candidates[0].eventType, 'PURCHASE');
});

test('primary-only, update-only, and companion-only inputs emit no monetary candidate', () => {
  const rows = lifecycle();
  assert.equal(projectAlfaLifecycle([rows[0]]).candidates.length, 0);
  assert.equal(projectAlfaLifecycle([rows[1]]).candidates.length, 0);
  assert.equal(projectAlfaLifecycle([rows[2]]).candidates.length, 0);
  assert.equal(projectAlfaLifecycle([rows[0]]).unresolved[0].reasonCode, 'MISSING_DIRECTION_UPDATE');
});

test('amount mismatch and reversed order fail closed', () => {
  const rows = lifecycle();
  const mismatch = projectAlfaLifecycle([rows[0], row(438, 342, rows[1].eventTime, updatePayload('9753')), rows[2]]);
  assert.equal(mismatch.candidates.length, 0);
  assert.equal(mismatch.unresolved[0].reasonCode, 'AMOUNT_MISMATCH');
  const reversed = projectAlfaLifecycle([
    row(438, 342, '2026-10-04T20:00:00.000Z', updatePayload()),
    row(437, 341, '2026-10-04T20:00:11.000Z', primaryPayload()),
    row(439, 343, '2026-10-04T20:00:11.200Z', emptyPayload),
  ]);
  assert.equal(reversed.candidates.length, 0);
});

test('competing primaries and competing updates fail closed', () => {
  const rows = lifecycle();
  const competingPrimary = [
    row(437, 341, '2026-10-04T20:00:00.000Z', primaryPayload()),
    row(440, 344, '2026-10-04T20:00:00.500Z', primaryPayload()),
    row(438, 342, '2026-10-04T20:00:10.500Z', updatePayload()),
    row(439, 343, '2026-10-04T20:00:10.700Z', emptyPayload),
  ];
  const primaryResult = projectAlfaLifecycle(competingPrimary);
  assert.equal(primaryResult.candidates.length, 0);
  assert.equal(primaryResult.unresolved.filter((item) => item.reasonCode === 'AMBIGUOUS_LIFECYCLE').length, 2);
  const competingUpdates = [
    rows[0],
    row(438, 342, '2026-10-04T20:00:10.500Z', updatePayload()),
    row(440, 344, '2026-10-04T20:00:10.800Z', updatePayload()),
    row(439, 343, '2026-10-04T20:00:11.000Z', emptyPayload),
  ];
  const updateResult = projectAlfaLifecycle(competingUpdates);
  assert.equal(updateResult.candidates.length, 0);
  assert.equal(updateResult.unresolved[0].reasonCode, 'AMBIGUOUS_LIFECYCLE');
});

test('F5 transfer remains owned by the provider normalizer and update never emits money alone', () => {
  const f5 = row(500, 600, '2026-10-04T20:00:00.000Z', {
    title: '- 2468 ₽',
    description: 'СЧЕТ 0000*1111; Перевод на СИНТЕТИЧЕСКИЙ 2468,00 RUB; Получатель: 2222*3333; 12 карта 34:56',
    text: 'СЧЕТ 0000*1111; Перевод на СИНТЕТИЧЕСКИЙ 2468,00 RUB; Получатель: 2222*3333; 12 карта 34:56',
  });
  const result = projectAlfaLifecycle([f5]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.memberClassifications[0].kind, 'F5_TRANSFER_OWNED_BY_PROVIDER_NORMALIZER');
});

test('projection preserves exact decimal strings and deterministic provenance key', () => {
  const rows = lifecycle({ amount: '99999999999999.00' });
  const first = projectAlfaLifecycle(rows);
  const second = projectAlfaLifecycle(rows);
  assert.equal(first.candidates[0].amount, '99999999999999.00');
  assert.equal(first.candidates[0].projectionKey, second.candidates[0].projectionKey);
  assert.deepEqual(first.candidates[0], second.candidates[0]);
  assert.equal(first.candidates[0].sourceProvenance.primaryObservationId, 437);
  assert.equal(first.candidates[0].sourceProvenance.updateObservationId, 438);
  assert.equal(first.candidates[0].sourceProvenance.companionObservationId, 439);
});

test('canonical candidate produces one UNKNOWN/DEBIT cash-flow and balanced journal in memory', () => {
  const candidate = projectAlfaLifecycle(lifecycle()).candidates[0];
  const cashFlow = projectAlfaLifecycleCashFlow(candidate);
  assert.equal(cashFlow.projectionStatus, 'UNRESOLVED');
  assert.equal(cashFlow.reasonCode, 'EVENT_TYPE_UNKNOWN');
  assert.equal(cashFlow.direction, 'DEBIT');
  const journal = projectBalancedBankJournal(cashFlow);
  assert.equal(journal.projectionStatus, 'PROJECTED');
  assert.equal(journal.postings.length, 2);
  assert.deepEqual(journal.postings.map((posting) => posting.account.code ?? posting.account.type), ['UNCLASSIFIED_OUTGOING', 'UNRESOLVED_BANK_ACCOUNT']);
});

test('one lifecycle produces one monetary candidate and no internal transfer', () => {
  const result = projectAlfaLifecycle(lifecycle());
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates.some((candidate) => candidate.eventType === 'INTERNAL_TRANSFER'), false);
  assert.equal(result.memberClassifications.filter((item) => item.kind === 'UPDATE' || item.kind === 'EMPTY').length, 2);
});

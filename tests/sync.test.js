import test from 'node:test';
import assert from 'node:assert/strict';
import { syncReceipts } from '../src/sync.js';
import { SessionExpiredError } from '../src/errors.js';

function repositoryFixture(existing = new Set()) {
  const saved = [];
  return { saved, async updateSyncState() {}, async upsertBundle(bundle) { saved.push(bundle); return { id: bundle.normalized.id, created: !existing.has(bundle.normalized.id) }; } };
}

test('sync is idempotent and stores full receipts only once', async () => {
  const repository = repositoryFixture(new Set(['known']));
  const client = { async listReceipts() { return { hasMore: false, receipts: [{ id: 'known' }, { id: 'new' }] }; }, async getReceiptRaw(id) { return { id, key: id, dateTime: '2026-09-04T10:00:00Z', user: 'Shop', totalSum: 10, items: [{ name: 'Tea', quantity: 1, price: 10, sum: 10 }] }; } };
  const result = await syncReceipts({ client, repository });
  assert.deepEqual(result, { fetched: 2, inserted: 1, alreadyExisted: 1, errors: 0 });
  assert.equal(repository.saved[0].normalized.items[0].name, 'Tea');
});

test('bounded ledger refresh owns certification and sync does not invoke it twice', async () => {
  const repository = repositoryFixture();
  let ledgerCalls = 0;
  let certificationCalls = 0;
  const result = await syncReceipts({
    client: { async listReceipts() { return { hasMore: false, receipts: [{ id: 'new' }] }; }, async getReceiptRaw(id) { return { key: id, items: [] }; } },
    repository,
    normalizer: async () => ({ facts: { normalizationStatus: 'READY' } }),
    ledgerRefresher: async () => { ledgerCalls += 1; return { bounded: true, eventIds: [42], certification: { facts: 1 } }; },
    certificationRefresher: async () => { certificationCalls += 1; return { bounded: true, facts: 1 }; },
    logger: { info() {}, error() {} },
  });
  assert.equal(result.ledger_refresh_failed, undefined);
  assert.equal(ledgerCalls, 1);
  assert.equal(certificationCalls, 0);
});

test('sync continues after one receipt detail error', async () => {
  const repository = repositoryFixture();
  const client = { async listReceipts() { return { hasMore: false, receipts: [{ id: 'bad' }, { id: 'good' }] }; }, async getReceiptRaw(id) { if (id === 'bad') throw new Error('temporary API error'); return { key: id, items: [] }; } };
  const result = await syncReceipts({ client, repository, logger: { error() {} } });
  assert.deepEqual(result, { fetched: 2, inserted: 1, alreadyExisted: 0, errors: 1 });
});

test('sync reports authentication failure instead of empty success', async () => {
  let stateError;
  const repository = { async updateSyncState(_account, values) { stateError = values.error; } };
  const client = { async listReceipts() { throw new SessionExpiredError('FNS session refresh failed', { status: 422, code: 'refresh.token.device.change.error.code' }); } };
  const result = await syncReceipts({ client, repository, logger: { error() {} } });
  assert.deepEqual(result, { fetched: 0, inserted: 0, alreadyExisted: 0, errors: 1, authError: 'FNS authentication/refresh failed' });
  assert.equal(stateError, 'FNS session refresh failed');
});

test('sync enters each saved receipt into the normalization lifecycle', async () => {
  const repository = repositoryFixture();
  const normalizedIds = [];
  const client = { async listReceipts() { return { hasMore: false, receipts: [{ id: 'new-a' }, { id: 'new-b' }] }; }, async getReceiptRaw(id) { return { key: id, items: [] }; } };
  const result = await syncReceipts({ client, repository, normalizer: async (receiptId) => { normalizedIds.push(receiptId); } });
  assert.equal(result.errors, 0);
  assert.equal(result.source_ingest_success_count, 2);
  assert.equal(result.normalization_ready_count, 0);
  assert.equal(result.normalization_blocked_count, 0);
  assert.equal(result.normalization_failed_count, 0);
  assert.deepEqual(normalizedIds, ['new-a', 'new-b']);
});

test('poison normalization is aggregated without starving later source ingestion', async () => {
  const repository = repositoryFixture();
  const client = { async listReceipts() { return { hasMore: false, receipts: [{ id: 'poison' }, { id: 'healthy-b' }, { id: 'healthy-c' }] }; }, async getReceiptRaw(id) { return { key: id, items: [] }; } };
  const result = await syncReceipts({ client, repository, normalizer: async (receiptId) => { if (receiptId === 'poison') throw new Error('poison'); return { facts: { normalizationStatus: 'READY' } }; }, logger: { info() {}, error() {} } });
  assert.equal(result.source_ingest_success_count, 3);
  assert.equal(result.normalization_ready_count, 2);
  assert.equal(result.normalization_failed_count, 1);
  assert.equal(repository.saved.length, 3);
});

test('incremental matcher runs after READY normalization and exposes counters', async () => {
  const repository = repositoryFixture();
  const result = await syncReceipts({
    client: { async listReceipts() { return { hasMore: false, receipts: [{ id: 'ready' }] }; }, async getReceiptRaw(id) { return { key: id, items: [] }; } },
    repository,
    normalizer: async () => ({ facts: { normalizationStatus: 'READY' } }),
    matcher: async () => ({ summary: { settlementsExamined: 1, confirmedSettlements: 1, ambiguousSettlements: 0, candidateOnlySettlements: 2, unmatchedSettlements: 3 }, triggerStatus: 'CONFIRMED' }),
    logger: { info() {}, error() {} },
  });
  assert.equal(result.normalization_failed_count, 0);
  assert.deepEqual({ matcher_examined: result.matcher_examined, matcher_confirmed: result.matcher_confirmed, matcher_candidate_only: result.matcher_candidate_only, matcher_unmatched: result.matcher_unmatched, matcher_failed: result.matcher_failed }, { matcher_examined: 1, matcher_confirmed: 1, matcher_candidate_only: 2, matcher_unmatched: 3, matcher_failed: 0 });
});

test('matcher failure is visible without rolling back source or normalization', async () => {
  const repository = repositoryFixture();
  const result = await syncReceipts({
    client: { async listReceipts() { return { hasMore: false, receipts: [{ id: 'ready' }] }; }, async getReceiptRaw(id) { return { key: id, items: [] }; } },
    repository,
    normalizer: async () => ({ facts: { normalizationStatus: 'READY' } }),
    matcher: async () => { throw new Error('matcher poison'); },
    logger: { info() {}, error() {} },
  });
  assert.equal(result.source_ingest_success_count, 1);
  assert.equal(result.normalization_ready_count, 1);
  assert.equal(result.normalization_failed_count, 0);
  assert.equal(result.matcher_failed, 1);
  assert.equal(repository.saved.length, 1);
});

test('return matcher is bounded to newly ingested return receipts', async () => {
  const calls = [];
  const repository = repositoryFixture(new Set(['replay']));
  const result = await syncReceipts({
    client: { async listReceipts() { return { hasMore: false, receipts: [{ id: 'replay' }, { id: 'new-return' }, { id: 'new-sale' }] }; }, async getReceiptRaw(id) { return { key: id, items: [] }; } },
    repository,
    normalizer: async (_receiptId) => ({ facts: { normalizationStatus: 'READY', fiscalOperationType: _receiptId === 'new-return' ? 2 : 1 } }),
    returnMatcher: async (receiptId) => { calls.push(receiptId); return { summary: { returnsExamined: 1, confirmed: 0, ambiguous: 0, candidateOnly: 1, unresolved: 0 }, triggerStatus: 'CANDIDATE_ONLY', receiptId }; },
    logger: { info() {}, error() {} },
  });
  assert.deepEqual(calls, ['new-return']);
  assert.equal(result.return_matcher_candidate_only, 1);
  assert.equal(result.return_matcher_failed, 0);
});

test('known unavailable detail becomes explicit non-fatal source state', async () => {
  const unavailable = new Error('provider detail unavailable');
  Object.assign(unavailable, { status: 422, code: 'KNOWN_DETAIL_UNAVAILABLE' });
  const states = new Map();
  const repository = {
    async updateSyncState() {},
    async updateSourceSyncState() {},
    async upsertSourceReceiptReference({ sourceReceiptId }) { const row = states.get(sourceReceiptId) ?? { status: 'PENDING_DETAIL', detail_next_retry_at: null }; states.set(sourceReceiptId, row); return row; },
    async markSourceReceiptDetailAttempt() {},
    async markSourceReceiptDetailUnavailable({ sourceReceiptId }) { states.set(sourceReceiptId, { status: 'FNS_DETAIL_UNAVAILABLE', detail_next_retry_at: new Date(Date.now() + 86_400_000).toISOString() }); },
  };
  const result = await syncReceipts({
    client: { async listReceipts() { return { hasMore: false, receipts: [{ id: 'unavailable' }] }; }, async getReceiptRaw() { throw unavailable; } },
    repository,
    sourceContext: { sourceId: 2 },
    detailErrorClassifier: (error) => error.status === 422 && error.code === 'KNOWN_DETAIL_UNAVAILABLE',
    logger: { warn() {}, error() {} },
  });
  assert.equal(result.errors, 0);
  assert.equal(result.detailUnavailable, 1);
  assert.equal(result.unclassified, 0);
  assert.equal(states.get('unavailable').status, 'FNS_DETAIL_UNAVAILABLE');
});

test('future detail retry is skipped without calling FNS detail endpoint', async () => {
  let detailCalls = 0;
  const repository = {
    async updateSyncState() {},
    async updateSourceSyncState() {},
    async upsertSourceReceiptReference() { return { status: 'FNS_DETAIL_UNAVAILABLE', detail_next_retry_at: new Date(Date.now() + 60_000).toISOString() }; },
  };
  const result = await syncReceipts({
    client: { async listReceipts() { return { hasMore: false, receipts: [{ id: 'pending-retry' }] }; }, async getReceiptRaw() { detailCalls += 1; } },
    repository,
    sourceContext: { sourceId: 2 },
    logger: { warn() {}, error() {} },
  });
  assert.equal(detailCalls, 0);
  assert.equal(result.retryPending, 1);
  assert.equal(result.errors, 0);
});

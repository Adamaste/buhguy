import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INVARIANT_INTERNAL_TRANSFER_WINDOW_MS,
  runReadOnlyMatchedPurchasePreview,
} from '../scripts/matched-purchase-preview-read-only.mjs';

function fakePool() {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (String(text).includes("current_setting('transaction_read_only')")) return { rows: [{ value: 'on' }] };
      return { rows: [] };
    },
    release() { queries.push({ text: 'RELEASE' }); },
  };
  return { pool: { async connect() { return client; } }, client, queries };
}

const validSummary = {
  matchedPairs: 1,
  persistRequired: 1,
  alreadyPersisted: 0,
  blockedMatchedPairs: 0,
  ambiguousBankPurchases: 0,
  ambiguousReceipts: 0,
  unmatchedBankPurchases: 0,
  unmatchedReceipts: 0,
  ineligibleBankEntries: 0,
  ineligibleReceipts: 0,
};

test('runner passes one transaction client to the authoritative preview and emits aggregate-only output', async () => {
  const { pool, client, queries } = fakePool();
  const calls = [];
  const result = await runReadOnlyMatchedPurchasePreview(pool, {
    scopeKey: 'default',
    from: '2026-10-06T00:00:00.000Z',
    to: '2026-10-07T00:00:00.000Z',
    preview: async (previewClient, options) => {
      calls.push({ previewClient, options });
      assert.equal(options.scopeKey, 'default');
      assert.equal(options.from, '2026-10-06T00:00:00.000Z');
      assert.equal(options.to, '2026-10-07T00:00:00.000Z');
      assert.ok([5000, INVARIANT_INTERNAL_TRANSFER_WINDOW_MS].includes(options.internalTransferMaxTimeDeltaMs));
      assert.equal(options.receiptMaxTimeDeltaMs, 300000);
      assert.equal(typeof options.logger.info, 'function');
      return {
        modelVersion: 'matched-purchase-writer-orchestration-v1',
        readiness: 'READY',
        summary: validSummary,
        decisions: [{ sensitive: 'must not be returned' }],
      };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].previewClient, client);
  assert.equal(calls[1].previewClient, client);
  assert.deepEqual(calls.map(({ options }) => options.internalTransferMaxTimeDeltaMs), [5000, INVARIANT_INTERNAL_TRANSFER_WINDOW_MS]);
  assert.deepEqual(result, {
    modelVersion: 'matched-purchase-writer-orchestration-v1',
    readiness: 'READY',
    summary: validSummary,
  });
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
  assert.match(queries[0].text, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/);
  assert.deepEqual(queries.slice(1, 3).map((query) => query.params[0]), ['120000ms', '5000ms']);
  assert.equal(queries.some((query) => /INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP/i.test(query.text)), false);
  assert.equal(queries.at(-2).text, 'ROLLBACK');
});

test('runner fails closed when the wide-window purchase identities or edges differ', async () => {
  const { pool, queries } = fakePool();
  const result = await runReadOnlyMatchedPurchasePreview(pool, {
    scopeKey: 'default',
    from: '2026-10-06T00:00:00.000Z',
    to: '2026-10-07T00:00:00.000Z',
    preview: async (_client, options) => ({
      modelVersion: 'matched-purchase-writer-orchestration-v1',
      readiness: 'READY',
      summary: validSummary,
      decisions: options.internalTransferMaxTimeDeltaMs === 5000 ? [{ matchKey: 'a'.repeat(64) }] : [{ matchKey: 'b'.repeat(64) }],
      bankStatuses: [],
      receiptStatuses: [],
    }),
  });
  assert.deepEqual(result, {
    modelVersion: 'matched-purchase-writer-orchestration-v1',
    readiness: 'REVIEW_REQUIRED',
    reasonCode: 'MATCHING_WINDOW_INVARIANCE_MISMATCH',
    summary: validSummary,
  });
  assert.equal(queries.filter((query) => query.text === 'ROLLBACK').length, 1);
});

test('runner rolls back when the authoritative preview fails', async () => {
  const { pool, queries } = fakePool();
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(pool, {
    scopeKey: 'default',
    from: '2026-10-06T00:00:00.000Z',
    to: '2026-10-07T00:00:00.000Z',
    preview: async () => { throw new Error('secret payload must not escape'); },
  }), /secret payload/);
  assert.equal(queries.filter((query) => query.text === 'ROLLBACK').length, 1);
});

test('runner fails closed for invalid result contracts and bounded periods', async () => {
  const { pool } = fakePool();
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(pool, {
    scopeKey: 'default',
    from: '2026-10-06T00:00:00.000Z',
    to: '2026-10-07T00:00:00.000Z',
    preview: async () => ({ modelVersion: 'matched-purchase-writer-orchestration-v1', readiness: 'READY', summary: null }),
  }), /result contract|summary/);
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(pool, {
    scopeKey: 'default',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-04-01T00:00:00.000Z',
    preview: async () => ({ modelVersion: 'matched-purchase-writer-orchestration-v1', readiness: 'READY', summary: validSummary }),
  }), /bounded range/);
});

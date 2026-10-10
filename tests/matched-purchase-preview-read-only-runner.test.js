import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INVARIANT_INTERNAL_TRANSFER_WINDOW_MS,
  previewFailureStage,
  PREVIEW_FAILURE_STAGE_CODES,
  runReadOnlyMatchedPurchasePreview,
  technicalFailurePayload,
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

function configurablePool({ connect, query, release } = {}) {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (query) return query(text, params, queries);
      if (String(text).includes("current_setting('transaction_read_only')")) return { rows: [{ value: 'on' }] };
      return { rows: [] };
    },
    release() { queries.push({ text: 'RELEASE' }); release?.(); },
  };
  return {
    pool: { async connect() { if (connect) return connect(client, queries); return client; } },
    client,
    queries,
  };
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

test('runner classifies connection and transaction setup stages without leaking errors', async () => {
  const connectionFailure = configurablePool({ connect: async () => { throw Object.freeze({ secret: 'hidden' }); } });
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(connectionFailure.pool, {
    scopeKey: 'default', from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z',
  }), (error) => { assert.equal(previewFailureStage(error), 'POOL_CONNECT'); return true; });

  const beginFailure = configurablePool({ query: async (text) => {
    if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') throw 'secret';
    return { rows: [] };
  } });
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(beginFailure.pool, {
    scopeKey: 'default', from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z',
  }), (error) => { assert.equal(previewFailureStage(error), 'TRANSACTION_BEGIN'); return true; });
});

test('runner classifies read-only, wide preview, result validation and rollback stages', async () => {
  const readOnlyFailure = configurablePool({ query: async (text) => {
    if (text.includes("current_setting('transaction_read_only')")) return { rows: [{ value: 'off' }] };
    return { rows: [] };
  } });
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(readOnlyFailure.pool, {
    scopeKey: 'default', from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z',
  }), (error) => { assert.equal(previewFailureStage(error), 'SESSION_READ_ONLY'); return true; });

  const wideFailure = configurablePool();
  let calls = 0;
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(wideFailure.pool, {
    scopeKey: 'default', from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z',
    preview: async () => { calls += 1; if (calls === 2) throw new Error('secret'); return { modelVersion: 'matched-purchase-writer-orchestration-v1', readiness: 'READY', summary: validSummary }; },
  }), (error) => { assert.equal(previewFailureStage(error), 'WIDE_PREVIEW'); return true; });

  const validationFailure = configurablePool();
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(validationFailure.pool, {
    scopeKey: 'default', from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z',
    preview: async () => ({ modelVersion: 'matched-purchase-writer-orchestration-v1', readiness: 'READY', summary: null }),
  }), (error) => { assert.equal(previewFailureStage(error), 'RESULT_VALIDATION'); return true; });

  const rollbackFailure = configurablePool({ query: async (text) => {
    if (text === 'ROLLBACK') throw new Error('database secret');
    return String(text).includes("current_setting('transaction_read_only')") ? { rows: [{ value: 'on' }] } : { rows: [] };
  } });
  await assert.rejects(() => runReadOnlyMatchedPurchasePreview(rollbackFailure.pool, {
    scopeKey: 'default', from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z',
    preview: async () => ({ modelVersion: 'matched-purchase-writer-orchestration-v1', readiness: 'READY', summary: validSummary }),
  }), (error) => { assert.equal(previewFailureStage(error), 'ROLLBACK'); return true; });
});

test('technical output is exact, safe, and stage-enum compatible', () => {
  assert.deepEqual(Object.keys(technicalFailurePayload(new Error('secret SQL payload'))).sort(), ['data', 'ok', 'reasonCode', 'stage', 'status']);
  assert.equal(technicalFailurePayload(new Error('secret SQL payload')).stage, 'UNKNOWN');
  assert.equal(JSON.stringify(technicalFailurePayload(new Error('secret SQL payload'))).includes('secret'), false);
  assert.deepEqual(PREVIEW_FAILURE_STAGE_CODES, ['POOL_CONNECT', 'TRANSACTION_BEGIN', 'SESSION_READ_ONLY', 'NARROW_PREVIEW', 'WIDE_PREVIEW', 'RESULT_VALIDATION', 'ROLLBACK']);
});

test('runner rolls back when the authoritative preview fails', async () => {
  const { pool, queries } = fakePool();
  let error;
  await assert.rejects(
    () => runReadOnlyMatchedPurchasePreview(pool, {
      scopeKey: 'default',
      from: '2026-10-06T00:00:00.000Z',
      to: '2026-10-07T00:00:00.000Z',
      preview: async () => { throw new Error('secret payload must not escape'); },
    }),
    (candidate) => { error = candidate; return /secret payload/.test(candidate.message); },
  );
  assert.equal(previewFailureStage(error), 'NARROW_PREVIEW');
  assert.equal(queries.filter((query) => query.text === 'ROLLBACK').length, 1);
});

test('preview failure diagnostics expose only an allowlisted stage', async () => {
  const { pool } = fakePool();
  let error;
  await assert.rejects(
    () => runReadOnlyMatchedPurchasePreview(pool, {
      scopeKey: 'default',
      from: '2026-10-06T00:00:00.000Z',
      to: '2026-10-07T00:00:00.000Z',
      preview: async () => { throw new Error('secret payload'); },
    }),
    (candidate) => { error = candidate; return true; },
  );
  assert.equal(previewFailureStage(error), 'NARROW_PREVIEW');
  assert.equal(Object.keys(error).includes('message'), false);
  assert.equal(previewFailureStage(new Error('unknown')), 'UNKNOWN');
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

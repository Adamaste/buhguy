import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import test from 'node:test';
import { loadBankReceiptMatching } from '../src/bank-receipt-matching.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';
import { rebuildLedger } from '../src/ledger.js';
import { previewMatchedPurchaseOrchestration } from '../src/matched-purchase-orchestration.js';
import { persistMatchedPurchase } from '../src/matched-purchase-persistence.js';
import { runReadOnlyMatchedPurchasePreview } from '../scripts/matched-purchase-preview-read-only.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
let sequence = 0;

const TABLES = [
  'bank_event_observations', 'bank_transactions', 'bank_transaction_account_resolution',
  'bank_transaction_payment_instrument_resolution', 'bank_receipt_matches',
  'business_events', 'business_event_evidence', 'business_event_edges', 'business_event_allocations',
  'business_event_bank_evidence', 'ledger_accounts', 'ledger_entries', 'ledger_postings',
  'ledger_source_links', 'ledger_entry_supersessions', 'certification_facts',
  'reconciliation_runs', 'reconciliation_results',
];

async function snapshot(pool) {
  const result = {};
  for (const table of TABLES) result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
  return JSON.stringify(result);
}

async function createFixture(pool, prefix, { standalone = false } = {}) {
  const suffix = `${process.pid}-${Date.now()}-${sequence += 1}`;
  const scopeKey = `${prefix}-scope-${suffix}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scopeId = Number((await client.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, prefix])).rows[0].id);
    const personId = Number((await client.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, `${prefix}-person-${suffix}`, prefix])).rows[0].id);
    const accountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'fixture-bank',$2,'RUB') RETURNING id", [scopeId, `${prefix} account`])).rows[0].id);
    const sourceId = Number((await client.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,'ANDROID_NOTIFICATION',$2) RETURNING id", [`${prefix}-source-${suffix}`, prefix])).rows[0].id);
    await client.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [sourceId, personId]);
    await client.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES($1,$2,'OWNER','fixture','fixture')", [accountId, personId]);
    const observationId = Number((await client.query('INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256) VALUES($1,$2,NOW(),NOW(),\'{}\',$3) RETURNING id', [sourceId, digest(`dedup:${suffix}`), digest(`payload:${suffix}`)])).rows[0].id);
    const transaction = (await client.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality) VALUES($1,'2026-10-06T10:00:00.000Z','12.34','RUB','DEBIT','PURCHASE','READY','fixture','EXACT') RETURNING id", [observationId])).rows[0];
    const transactionId = Number(transaction.id);
    await client.query("INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES($1,$2,'EXACT','fixture','fixture')", [transactionId, accountId]);
    const receipt = (await client.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency,operation_type) VALUES($1,'2026-10-06T10:01:00.000Z','fixture','12.34','RUB',1) RETURNING id,date_time", [`${prefix}-receipt-${suffix}`])).rows[0];
    const receiptId = Number(receipt.id);
    const fnsSourceId = Number((await client.query("INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref) VALUES($1,$2,$3,'fixture','fixture') RETURNING id", [scopeId, `${prefix}-fns-${suffix}`, prefix])).rows[0].id);
    await client.query('INSERT INTO fns_source_person(fns_source_id,person_id) VALUES($1,$2)', [fnsSourceId, personId]);
    await client.query('INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,$3)', [receiptId, fnsSourceId, `${prefix}-source-receipt-${suffix}`]);
    const itemId = Number((await client.query("INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum) VALUES($1,0,'fixture','1','12.34','12.34') RETURNING id", [receiptId])).rows[0].id);
    await client.query('INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256) VALUES($1,\'fiscal-normalizer-v1\',4,$2)', [itemId, digest(`item:${suffix}`)]);
    await client.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO','12.34','PRESENT_VALUE','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','UNKNOWN')", [receiptId, digest(`source:${suffix}`), digest(`normalized:${suffix}`)]);
    await client.query('COMMIT');
    const fixture = { scopeId, scopeKey, personId, accountId, sourceId, transactionId, receiptId };
    if (standalone) {
      await persistStandalonePurchases(pool, { scopeKey, receiptIds: [receiptId] });
      const eventId = Number((await pool.query("SELECT ev.event_id FROM business_event_evidence ev JOIN business_events e ON e.id=ev.event_id WHERE ev.receipt_id=$1 AND e.scope_id=$2 AND ev.evidence_role='PURCHASE_EVIDENCE'", [receiptId, scopeId])).rows[0].event_id);
      await rebuildLedger(pool, { scopeKey, eventIds: [eventId] });
    }
    return fixture;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function addAmbiguousPair(pool, fixture, prefix) {
  const suffix = `${process.pid}-${Date.now()}-${sequence += 1}`;
  const observationId = Number((await pool.query('INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256) VALUES($1,$2,NOW(),NOW(),\'{}\',$3) RETURNING id', [fixture.sourceId, digest(`dedup:${prefix}:${suffix}`), digest(`payload:${prefix}:${suffix}`)])).rows[0].id);
  const transactionId = Number((await pool.query("INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality) VALUES($1,'2026-10-06T10:00:00.000Z','12.34','RUB','DEBIT','PURCHASE','READY','fixture','EXACT') RETURNING id", [observationId])).rows[0].id);
  await pool.query("INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES($1,$2,'EXACT','fixture','fixture')", [transactionId, fixture.accountId]);
  const receiptId = Number((await pool.query("INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency,operation_type) VALUES($1,'2026-10-06T10:01:00.000Z','fixture','12.34','RUB',1) RETURNING id", [`${prefix}-receipt-${suffix}`])).rows[0].id);
  const fnsSourceId = Number((await pool.query("INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref) VALUES($1,$2,$3,'fixture','fixture') RETURNING id", [fixture.scopeId, `${prefix}-fns-${suffix}`, prefix])).rows[0].id);
  await pool.query('INSERT INTO fns_source_person(fns_source_id,person_id) VALUES($1,$2)', [fnsSourceId, fixture.personId]);
  await pool.query('INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,$3)', [receiptId, fnsSourceId, `${prefix}-source-receipt-${suffix}`]);
  const itemId = Number((await pool.query("INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum) VALUES($1,0,'fixture','1','12.34','12.34') RETURNING id", [receiptId])).rows[0].id);
  await pool.query('INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256) VALUES($1,\'fiscal-normalizer-v1\',4,$2)', [itemId, digest(`item:${prefix}:${suffix}`)]);
  await pool.query("INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status) VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO','12.34','PRESENT_VALUE','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','UNKNOWN')", [receiptId, digest(`source:${prefix}:${suffix}`), digest(`normalized:${prefix}:${suffix}`)]);
  return { transactionId, receiptId };
}

async function cleanup(pool, scopeId) {
  await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]).catch(() => {});
}

function readOnlyPool(pool, queries) {
  return {
    query: async (text, params) => {
      const normalized = String(text).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim().toUpperCase();
      if (!/^(SELECT|WITH)\b/.test(normalized)
        || /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|VACUUM|CALL|DO|COPY|BEGIN|COMMIT|ROLLBACK|SET)\b/.test(normalized)) {
        throw new Error(`NON_READ_ONLY_SQL:${text}`);
      }
      queries.push({ text: String(text), params });
      return pool.query(text, params);
    },
  };
}

async function withReadOnlyTransaction(pool, queries, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    return await callback(readOnlyPool({ query: (text, params) => client.query(text, params) }, queries));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

integration('authoritative preview is PERSIST_REQUIRED and SELECT-only', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'preview-authoritative');
    const before = await snapshot(pool);
    const queries = [];
    const result = await withReadOnlyTransaction(pool, queries, (readOnly) => previewMatchedPurchaseOrchestration(readOnly, { scopeKey: fixture.scopeKey, internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000 }));
    assert.equal(result.readiness, 'READY');
    assert.equal(result.summary.persistRequired, 1);
    assert.equal(result.decisions[0].orchestrationAction, 'PERSIST_REQUIRED');
    assert.ok(queries.length > 0);
    assert.equal(await snapshot(pool), before);
  } finally { await pool.end(); }
});

integration('public preview ignores caller matchingLoader injection and rejects stale match selection', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'preview-loader-isolation');
    const options = { scopeKey: fixture.scopeKey, internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000 };
    const result = await previewMatchedPurchaseOrchestration(pool, { ...options, matchingLoader: async () => ({ matches: [] }) });
    assert.equal(result.readiness, 'READY');
    assert.equal(result.summary.persistRequired, 1);
    const missing = await previewMatchedPurchaseOrchestration(pool, { ...options, matchKey: digest('missing-match') });
    assert.equal(missing.readiness, 'REVIEW_REQUIRED');
    assert.deepEqual(missing.selection, { matchKey: digest('missing-match'), status: 'REVIEW_REQUIRED', reasonCode: 'MATCH_NOT_FOUND' });
  } finally { await pool.end(); }
});

integration('real writer persistence preserves orchestration identity and read-only NOOP preview', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'preview-already-persisted');
    const options = { scopeKey: fixture.scopeKey, internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000 };
    const before = await previewMatchedPurchaseOrchestration(pool, options);
    assert.equal(before.decisions[0].orchestrationAction, 'PERSIST_REQUIRED');
    await persistMatchedPurchase(pool, options);
    const queries = [];
    const persistedSnapshot = await snapshot(pool);
    const after = await withReadOnlyTransaction(pool, queries, (readOnly) => previewMatchedPurchaseOrchestration(readOnly, { ...options, matchingLoader: async () => ({ matches: [] }) }));
    assert.equal(after.decisions[0].orchestrationAction, 'NOOP_ALREADY_PERSISTED');
    assert.equal(after.decisions[0].orchestrationKey, before.decisions[0].orchestrationKey);
    assert.equal(after.decisions[0].matchKey, before.decisions[0].matchKey);
    assert.equal(after.decisions[0].enrichmentKey, before.decisions[0].enrichmentKey);
    assert.equal(after.decisions[0].writePlan.expectedSemanticChange, false);
    assert.ok(queries.length > 0);
    assert.equal(await snapshot(pool), persistedSnapshot);
  } finally { await pool.end(); }
});

integration('query guard rejects data modifying CTE and all mutation classes', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const queries = [];
    const readOnly = readOnlyPool(pool, queries);
    for (const sql of ['INSERT INTO receipts DEFAULT VALUES', 'UPDATE receipts SET seller= seller', 'DELETE FROM receipts', 'MERGE INTO receipts USING receipts ON false WHEN NOT MATCHED THEN INSERT DEFAULT VALUES', 'TRUNCATE receipts', 'CREATE TABLE forbidden_guard(id integer)', 'WITH removed AS (DELETE FROM receipts RETURNING id) SELECT * FROM removed']) {
      await assert.rejects(() => readOnly.query(sql), /NON_READ_ONLY_SQL/);
    }
  } finally { await pool.end(); }
});

integration('real standalone purchase previews REFINE without invoking the writer', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'preview-refine', { standalone: true });
    const options = { scopeKey: fixture.scopeKey, internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000 };
    const refine = await previewMatchedPurchaseOrchestration(pool, options);
    assert.equal(refine.summary.persistRequired, 1);
    assert.equal(refine.decisions[0].ledgerDisposition, 'REFINE_EXISTING_FISCAL_FUNDING');
  } finally { await pool.end(); }
});

integration('preview snapshot remains unchanged for ambiguous and unmatched evidence', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'preview-ambiguous');
    await addAmbiguousPair(pool, fixture, 'preview-ambiguous');
    const before = await snapshot(pool);
    const result = await previewMatchedPurchaseOrchestration(pool, { scopeKey: fixture.scopeKey, internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000 });
    assert.equal(result.readiness, 'REVIEW_REQUIRED');
    assert.equal(result.summary.matchedPairs, 0);
    assert.equal(result.summary.ambiguousBankPurchases, 2);
    assert.equal(result.summary.ambiguousReceipts, 2);
    assert.equal(await snapshot(pool), before);
  } finally { await pool.end(); }
});

integration('read-only runner uses one PostgreSQL snapshot and leaves persistence unchanged', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'preview-runner');
    const before = await snapshot(pool);
    const result = await runReadOnlyMatchedPurchasePreview(pool, {
      scopeKey: fixture.scopeKey,
      from: '2026-10-06T00:00:00.000Z',
      to: '2026-10-07T00:00:00.000Z',
    });
    assert.equal(result.ok, undefined);
    assert.equal(result.readiness, 'READY');
    assert.equal(result.summary.persistRequired, 1);
    assert.equal(result.summary.alreadyPersisted, 0);
    assert.equal(await snapshot(pool), before);
  } finally { await pool.end(); }
});

integration('read-only runner stops when the wide window changes a purchase edge', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'preview-runner-invariance');
    const before = await snapshot(pool);
    const result = await runReadOnlyMatchedPurchasePreview(pool, {
      scopeKey: fixture.scopeKey,
      from: '2026-10-06T00:00:00.000Z',
      to: '2026-10-07T00:00:00.000Z',
      preview: async (client, options) => {
        const result = await previewMatchedPurchaseOrchestration(client, {
          scopeKey: fixture.scopeKey,
          from: options.from,
          to: options.to,
          internalTransferMaxTimeDeltaMs: options.internalTransferMaxTimeDeltaMs,
          receiptMaxTimeDeltaMs: options.receiptMaxTimeDeltaMs,
          logger: options.logger,
        });
        if (options.internalTransferMaxTimeDeltaMs === 5000) return result;
        return {
          ...result,
          decisions: result.decisions.map((row) => ({ ...row, matchKey: 'b'.repeat(64) })),
        };
      },
    });
    assert.equal(result.readiness, 'REVIEW_REQUIRED');
    assert.equal(result.reasonCode, 'MATCHING_WINDOW_INVARIANCE_MISMATCH');
    assert.equal(await snapshot(pool), before);
  } finally { await pool.end(); }
});

integration('read-only runner rejects a mutation at the PostgreSQL boundary and rolls back', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const fixture = await createFixture(pool, 'preview-runner-rollback');
    const before = await snapshot(pool);
    await assert.rejects(() => runReadOnlyMatchedPurchasePreview(pool, {
      scopeKey: fixture.scopeKey,
      from: '2026-10-06T00:00:00.000Z',
      to: '2026-10-07T00:00:00.000Z',
      preview: async (client) => {
        await client.query('INSERT INTO receipts DEFAULT VALUES');
        return null;
      },
    }), /read-only|25006/i);
    assert.equal(await snapshot(pool), before);
  } finally { await pool.end(); }
});

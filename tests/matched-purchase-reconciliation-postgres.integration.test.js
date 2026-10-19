import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { createBankSource, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { createBankDeviceCredential } from '../src/bank-device-auth.js';
import { createBankIngestionServer } from '../src/bank-ingestion-http.js';
import { bindBankSourceProviderAccount } from '../src/bank-source-provider-binding.js';
import { createBankAccountReference, createFinancialAccount, createPaymentInstrument, relateFinancialAccountPerson } from '../src/bank-account-resolution.js';
import { ReceiptRepository, migrate } from '../src/database.js';
import { normalizeAndStoreReceipt } from '../src/fiscal-normalization.js';
import { analyticsSummary } from '../src/analytics.js';
import { loadBankCashFlowProjection } from '../src/bank-cash-flow-projection.js';
import { BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES, loadBankReceiptMatching } from '../src/bank-receipt-matching.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';
import { syncReceipts } from '../src/sync.js';
import { previewMatchedPurchaseOrchestration } from '../src/matched-purchase-orchestration.js';
import { MATCHED_PURCHASE_AUTO_POLICY } from '../src/matched-purchase-orchestration.js';
import { persistMatchedPurchaseForTest } from '../src/matched-purchase-persistence.js';
import {
  matchedPurchaseReconciliationWindow,
  runAccountingCatchupsWithMatchedPurchaseCanary,
  runBoundedMatchedPurchaseReconciliation,
} from '../src/matched-purchase-reconciliation.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const quietLogger = { info() {}, warn() {}, error() {} };
let pool;
let sequence = 0;

async function resetSchema() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(pool);
}

before(async () => { pool = new pg.Pool({ connectionString: databaseUrl, max: 12 }); });
beforeEach(async () => resetSchema());
after(async () => { await pool?.end(); });

function receiptRaw(fixture, { amount = '12.34', dateTime = fixture.dateTime, suffix = 'receipt', merchant = 'Synthetic merchant' } = {}) {
  const numeric = Number(amount);
  return {
    key: `${fixture.prefix}-${suffix}`,
    dateTime,
    totalSum: numeric,
    currency: 'RUB',
    user: merchant,
    userInn: '7700000000',
    operationType: 1,
    fiscalDocumentFormatVer: '4',
    fiscalDriveNumber: `synthetic-fd-${fixture.prefix}-${suffix}`,
    fiscalDocumentNumber: `synthetic-doc-${fixture.prefix}-${suffix}`,
    fiscalSign: `synthetic-sign-${fixture.prefix}-${suffix}`,
    cashTotalSum: 0,
    ecashTotalSum: numeric,
    prepaidSum: 0,
    creditSum: 0,
    provisionSum: 0,
    items: [{ name: 'Synthetic item', quantity: 1, price: numeric, sum: numeric, paymentType: 4, productType: 4, providerInn: '7700000000' }],
  };
}

async function createFixture(prefix, {
  canaryEnabled = true,
  canaryScopeKey = null,
  approvedMatchKey = null,
  automaticPolicy = null,
  bankIngestedAfter = null,
  reconcileMatchedPurchases,
} = {}) {
  const suffix = `${process.pid}-${Date.now()}-${sequence += 1}`;
  const fixturePrefix = `${prefix}-${suffix}`;
  const scopeKey = `${fixturePrefix}-scope`;
  const personKey = `${fixturePrefix}-person`;
  const bankSourceKey = `${fixturePrefix}-bank`;
  const fnsSourceKey = `${fixturePrefix}-fns`;
  const provider = 'com.yandex.bank';
  const dateTime = new Date(Date.now() - 60_000).toISOString();
  const scope = (await pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, 'Synthetic reconciliation scope'])).rows[0];
  const person = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scope.id, personKey, 'Synthetic person'])).rows[0];
  const account = await createFinancialAccount(pool, { scopeKey, institution: 'Synthetic bank', provider, displayName: `${fixturePrefix} account`, currency: 'RUB' });
  await relateFinancialAccountPerson(pool, { financialAccountId: Number(account.id), personId: Number(person.id), relationType: 'OWNER', provenance: 'SYNTHETIC_TEST', reason: 'Synthetic owner evidence' });
  await createBankSource(pool, { sourceKey: bankSourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic bank source' });
  await linkBankSourcePerson(pool, { sourceKey: bankSourceKey, personId: Number(person.id) });
  await bindBankSourceProviderAccount(pool, { sourceKey: bankSourceKey, provider, financialAccountId: Number(account.id), reason: 'Synthetic explicit source/provider binding' });
  const repository = new ReceiptRepository(pool);
  const fnsSource = await repository.ensureSource({
    scopeKey,
    sourceKey: fnsSourceKey,
    displayName: 'Synthetic FNS source',
    sessionRef: `synthetic:${fixturePrefix}`,
    deviceRef: `synthetic:${fixturePrefix}`,
    personKey,
    personDisplayName: 'Synthetic person',
  });
  const credential = await createBankDeviceCredential(pool, { sourceKey: bankSourceKey, displayName: 'Synthetic test device' });
  const canary = {
    enabled: canaryEnabled,
    canaryScopeKey: canaryEnabled ? canaryScopeKey ?? scopeKey : null,
    approvedMatchKey,
    automaticPolicy,
    bankIngestedAfter,
  };
  const server = createBankIngestionServer({ pool, logger: quietLogger, matchedPurchaseCanary: canary, reconcileMatchedPurchases });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    prefix: fixturePrefix,
    scopeId: Number(scope.id),
    scopeKey,
    personId: Number(person.id),
    accountId: Number(account.id),
    bankSourceKey,
    fnsSourceKey,
    fnsSourceId: Number(fnsSource.id),
    credential,
    repository,
    dateTime,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    canary,
    receiptIds: [],
  };
}

async function ingestBank(fixture, {
  amount = '12.34',
  id = 'bank-event',
  dateTime = fixture.dateTime,
  merchant = 'Synthetic bank merchant',
  provider = 'com.yandex.bank',
  adapter = 'synthetic-test',
  schemaVersion = '1',
  payload = null,
  sourceKey = fixture.bankSourceKey,
  credential = fixture.credential,
} = {}) {
  const event = {
    sourceKey,
    sourceEventId: `${fixture.prefix}-${id}`,
    observedAt: new Date().toISOString(),
    eventTime: dateTime,
    payload: payload ?? { title: 'Покупка', description: `Покупка на ${amount} RUB синтетический магазин`, merchant },
    ingestionMetadata: { adapter, provider, deviceType: 'test', schemaVersion },
  };
  const response = await fetch(`${fixture.baseUrl}/api/v1/bank/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  return { status: response.status, body: await response.json() };
}

async function createTbankCard(fixture, { referenceValue, label }) {
  const account = await createFinancialAccount(pool, {
    scopeKey: fixture.scopeKey,
    institution: 'Synthetic T-Bank',
    provider: 'com.idamob.tinkoff.android',
    displayName: `${fixture.prefix} ${label} account`,
    currency: 'RUB',
  });
  await relateFinancialAccountPerson(pool, {
    financialAccountId: Number(account.id),
    personId: fixture.personId,
    relationType: 'OWNER',
    provenance: 'SYNTHETIC_TEST',
    reason: 'Synthetic T-Bank card account owner',
  });
  const instrument = await createPaymentInstrument(pool, {
    scopeKey: fixture.scopeKey,
    financialAccountId: Number(account.id),
    instrumentType: 'CARD',
    provider: 'com.idamob.tinkoff.android',
    displayName: `${fixture.prefix} ${label} card`,
  });
  await createBankAccountReference(pool, {
    paymentInstrumentId: Number(instrument.id),
    provider: 'com.idamob.tinkoff.android',
    referenceKind: 'MASKED_CARD',
    referenceValue,
  });
  return { accountId: Number(account.id), paymentInstrumentId: Number(instrument.id), referenceValue };
}

async function insertResolvedTbankPurchase(fixture, card, { id, amount = '12.34', dateTime = fixture.dateTime } = {}) {
  const sourceId = Number((await pool.query('SELECT id FROM bank_sources WHERE source_key=$1', [fixture.bankSourceKey])).rows[0].id);
  const dedupKey = crypto.createHash('sha256').update(`${fixture.prefix}:${id}`).digest('hex');
  const payloadHash = crypto.createHash('sha256').update(`synthetic:${fixture.prefix}:${id}`).digest('hex');
  const observation = (await pool.query(`INSERT INTO bank_event_observations
      (bank_source_id,source_event_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata)
    VALUES($1,$2,$3,NOW(),$4,'{}'::jsonb,$5,$6::jsonb) RETURNING id`, [
    sourceId,
    `${fixture.prefix}:${id}`,
    dedupKey,
    dateTime,
    payloadHash,
    JSON.stringify({ provider: 'com.idamob.tinkoff.android', adapter: 'synthetic-test', schemaVersion: '1' }),
  ])).rows[0];
  const transaction = (await pool.query(`INSERT INTO bank_transactions
      (observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality,account_reference,account_reference_kind)
    VALUES($1,$2,$3,'RUB','DEBIT','PURCHASE','READY','synthetic-tbank-v1','EXACT',$4,'MASKED_CARD') RETURNING id`, [
    observation.id, dateTime, amount, card.referenceValue,
  ])).rows[0];
  await pool.query(`INSERT INTO bank_transaction_account_resolution
      (bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
    VALUES($1,$2,'EXACT','OBSERVED_PROVIDER_REFERENCE','Synthetic exact card-account resolution')`, [transaction.id, card.accountId]);
  await pool.query(`INSERT INTO bank_transaction_payment_instrument_resolution
      (bank_transaction_id,payment_instrument_id,resolution_state,provenance,reason)
    VALUES($1,$2,'EXACT','OBSERVED_PROVIDER_REFERENCE','Synthetic exact card-instrument resolution')`, [transaction.id, card.paymentInstrumentId]);
  return Number(transaction.id);
}

async function createAdditionalBoundBankSource(fixture, provider, label) {
  const sourceKey = `${fixture.prefix}-${label}-bank`;
  await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic second bank source' });
  await linkBankSourcePerson(pool, { sourceKey, personId: fixture.personId });
  const account = await createFinancialAccount(pool, {
    scopeKey: fixture.scopeKey, institution: 'Synthetic second bank', provider,
    displayName: `${fixture.prefix} ${label} account`,
  });
  await relateFinancialAccountPerson(pool, {
    financialAccountId: Number(account.id), personId: fixture.personId,
    relationType: 'OWNER', provenance: 'SYNTHETIC_TEST', reason: 'Synthetic owner evidence',
  });
  await bindBankSourceProviderAccount(pool, {
    sourceKey, provider, financialAccountId: Number(account.id), reason: 'Synthetic explicit source/provider binding',
  });
  const credential = await createBankDeviceCredential(pool, { sourceKey, displayName: 'Synthetic second-bank device' });
  return { sourceKey, credential, accountId: Number(account.id) };
}

async function syncFns(fixture, { receipts = [{ amount: '12.34', suffix: 'receipt' }], canary = fixture.canary } = {}) {
  const raws = receipts.map((item) => receiptRaw(fixture, { ...item }));
  const byKey = new Map(raws.map((raw) => [raw.key, raw]));
  const syncResult = await syncReceipts({
    client: {
      async listReceipts() {
        return { receipts: raws.map((raw) => ({ id: raw.key, dateTime: raw.dateTime, totalSum: raw.totalSum, currency: raw.currency })), hasMore: false };
      },
      async getReceiptRaw(id) { return byKey.get(id); },
    },
    repository: fixture.repository,
    normalizer: (receiptId) => normalizeAndStoreReceipt(pool, receiptId),
    standaloneMatcher: async (receiptId) => {
      const standalone = await persistStandalonePurchases(pool, { scopeKey: fixture.scopeKey, receiptIds: [receiptId] });
      return { examined: 1, created: standalone.purchases.some((item) => Number(item.receiptId) === Number(receiptId) && item.created) ? 1 : 0 };
    },
    accountKey: fixture.fnsSourceKey,
    sourceContext: { sourceId: fixture.fnsSourceId, sourceKey: fixture.fnsSourceKey },
    logger: quietLogger,
  });
  const refs = await pool.query('SELECT receipt_id FROM receipt_source_observations WHERE fns_source_id=$1 ORDER BY receipt_id', [fixture.fnsSourceId]);
  fixture.receiptIds = refs.rows.map((row) => Number(row.receipt_id));
  const accounting = await runAccountingCatchupsWithMatchedPurchaseCanary({
    pool,
    sources: [{ enabled: true, scopeKey: fixture.scopeKey }],
    canary,
    now: new Date(),
    logger: quietLogger,
  });
  return { syncResult, accounting };
}

async function matchedCounts(fixture) {
  return (await pool.query(`SELECT
      (SELECT count(*)::int FROM bank_receipt_matches WHERE scope_id=$1) AS matches,
      (SELECT count(*)::int FROM business_event_bank_evidence WHERE scope_id=$1) AS bank_evidence,
      (SELECT count(*)::int FROM ledger_entries e WHERE e.scope_id=$1 AND e.derivation_rule='LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1') AS matched_entries,
      (SELECT count(*)::int FROM ledger_entries e WHERE e.scope_id=$1 AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id) AND e.derivation_rule IN ('LEDGER_STANDALONE_PURCHASE_V1','LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1')) AS active_purchase_entries,
      (SELECT COALESCE(sum(p.debit),0)::text FROM ledger_entries e JOIN ledger_postings p ON p.ledger_entry_id=e.id JOIN ledger_accounts a ON a.id=p.account_id WHERE e.scope_id=$1 AND a.account_code='UNCLASSIFIED_ACQUISITION' AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)) AS active_purchase_debits`, [fixture.scopeId])).rows[0];
}

async function expenseTotals(fixture) {
  const summary = await analyticsSummary(pool, { scopeKey: fixture.scopeKey });
  return {
    amount: summary.metrics.CONFIRMED_ACQUISITION_VALUE.amount,
    count: summary.metrics.CONFIRMED_ACQUISITION_VALUE.count,
  };
}

async function certificationFacts(fixture) {
  return (await pool.query(`SELECT f.metric_code, f.status, f.amount::text AS amount, f.semantic_key
    FROM certification_facts f
    JOIN ledger_entries e ON e.id=f.ledger_entry_id
    WHERE f.scope_id=$1 AND f.metric_code='CONFIRMED_ACQUISITION_VALUE'
      AND e.derivation_rule IN ('LEDGER_STANDALONE_PURCHASE_V1','LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1')
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)
    ORDER BY f.semantic_key`, [fixture.scopeId])).rows;
}

async function matchingForFixture(fixture, { automatic = false } = {}) {
  return loadBankReceiptMatching(pool, {
    scopeKey: fixture.scopeKey,
    ...matchedPurchaseReconciliationWindow(),
    internalTransferMaxTimeDeltaMs: 5000,
    receiptMaxTimeDeltaMs: 300000,
    ...(automatic ? {
      assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.UNAMBIGUOUS_COMPONENTS,
      requireSourceProviderBinding: true,
      bankIngestedAfter: fixture.canary.bankIngestedAfter,
    } : {}),
  });
}

async function runAutomaticForFixture(fixture) {
  return runBoundedMatchedPurchaseReconciliation(pool, {
    ...matchedPurchaseReconciliationWindow(),
    enabled: true,
    scopeKey: fixture.scopeKey,
    canaryScopeKey: fixture.scopeKey,
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: fixture.canary.bankIngestedAfter,
  });
}

async function closeFixture(fixture) {
  await new Promise((resolve) => fixture.server.close(resolve));
}

integration('bank-first pair stays review-only until exact matchKey approval, then sync persists once', { concurrency: false }, async () => {
  const fixture = await createFixture('bank-first-e2e');
  try {
    const bankCreated = await ingestBank(fixture, { amount: '12.34' });
    assert.equal(bankCreated.status, 201);
    assert.equal(bankCreated.body.status, 'created');
    let totals = await expenseTotals(fixture);
    assert.deepEqual(totals, { amount: '0.00', count: 0 });
    const bankCash = await loadBankCashFlowProjection(pool, { scopeKey: fixture.scopeKey });
    assert.equal(bankCash.projections.filter((row) => row.movementType === 'PURCHASE').length, 1);
    assert.equal(bankCash.projections[0].amount, '12.34');
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 0, bank_evidence: 0, matched_entries: 0, active_purchase_entries: 0, active_purchase_debits: '0',
    });

    const fns = await syncFns(fixture);
    assert.equal(fns.syncResult.normalization_ready_count, 1);
    assert.equal(fns.accounting.reconciliations[0].reasonCode, 'APPROVED_MATCH_KEY_REQUIRED');
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 0, bank_evidence: 0, matched_entries: 0, active_purchase_entries: 1, active_purchase_debits: '12.34',
    });
    const candidate = (await matchingForFixture(fixture)).matches[0];
    const review = await previewMatchedPurchaseOrchestration(pool, {
      scopeKey: fixture.scopeKey,
      ...matchedPurchaseReconciliationWindow(),
      internalTransferMaxTimeDeltaMs: 5000,
      receiptMaxTimeDeltaMs: 300000,
    });
    assert.equal(review.readiness, 'REVIEW_REQUIRED');
    assert.equal(review.decisions[0].reasonCode, 'INDEPENDENT_MATCH_EVIDENCE_REQUIRED');
    fixture.canary.approvedMatchKey = candidate.matchKey;
    const approvedSync = await syncFns(fixture);
    assert.equal(approvedSync.accounting.reconciliations[0].persisted, 1);
    totals = await expenseTotals(fixture);
    assert.deepEqual(totals, { amount: '12.34', count: 1 });
    const certified = await certificationFacts(fixture);
    assert.equal(certified.length, 1);
    assert.equal(certified[0].status, 'CERTIFIED');
    assert.equal(certified[0].amount, '12.34');
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 1, bank_evidence: 1, matched_entries: 1, active_purchase_entries: 1, active_purchase_debits: '12.34',
    });

    const [bankReplay, fnsReplay] = await Promise.all([
      ingestBank(fixture, { amount: '12.34' }),
      syncFns(fixture),
    ]);
    assert.equal(bankReplay.status, 200);
    assert.equal(bankReplay.body.status, 'duplicate');
    assert.equal(Object.hasOwn(bankReplay.body, 'reconciliation'), false);
    assert.equal(fnsReplay.syncResult.inserted, 0);
    assert.equal((await expenseTotals(fixture)).amount, '12.34');
    assert.equal((await expenseTotals(fixture)).count, 1);
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 1, bank_evidence: 1, matched_entries: 1, active_purchase_entries: 1, active_purchase_debits: '12.34',
    });
  } finally { await closeFixture(fixture); }
});

integration('automatic V2 matches only the exact resolved T-Bank debit card without provider-wide binding', { concurrency: false }, async () => {
  const fixture = await createFixture('auto-tbank-card-proof-e2e', {
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  try {
    const debitCard = await createTbankCard(fixture, { referenceValue: '****7268', label: 'confirmed debit' });
    const debitTransactionId = await insertResolvedTbankPurchase(fixture, debitCard, { id: 'debit-7268' });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM bank_source_provider_account_bindings
      WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)
        AND provider='com.idamob.tinkoff.android' AND active`, [fixture.bankSourceKey])).rows[0].count, 0);

    const fns = await syncFns(fixture);
    assert.equal(fns.accounting.reconciliations[0].persisted, 1);
    assert.deepEqual(await expenseTotals(fixture), { amount: '12.34', count: 1 });
    const persisted = (await pool.query(`SELECT financial_account_id,bank_transaction_id
      FROM bank_receipt_matches WHERE scope_id=$1`, [fixture.scopeId])).rows[0];
    assert.equal(Number(persisted.bank_transaction_id), debitTransactionId);
    assert.equal(Number(persisted.financial_account_id), debitCard.accountId);

    const otherCard = await createTbankCard(fixture, { referenceValue: '****1357', label: 'synthetic credit' });
    const otherCardTransactionId = await insertResolvedTbankPurchase(fixture, otherCard, { id: 'other-card-1357' });
    const matching = await matchingForFixture(fixture, { automatic: true });
    const rejected = matching.bankStatuses.find((row) => row.bankTransactionId === otherCardTransactionId);
    assert.equal(rejected.status, 'INELIGIBLE');
    assert.equal(rejected.reasonCode, 'BANK_SOURCE_PROVIDER_BINDING_UNPROVEN');
    assert.equal(matching.matches.length, 1);
    assert.equal(matching.matches[0].bank.bankTransactionId, debitTransactionId);
    assert.deepEqual(await expenseTotals(fixture), { amount: '12.34', count: 1 });
  } finally { await closeFixture(fixture); }
});

integration('new bank-first purchase automatically reuses its receipt expense and survives duplicate delivery and restart', { concurrency: false }, async () => {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const fixture = await createFixture('auto-bank-first-e2e', {
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: cutoff,
  });
  try {
    const bank = await ingestBank(fixture, { amount: '12.34' });
    assert.equal(bank.status, 201);
    assert.equal(bank.body.reconciliation.status, 'COMPLETED');
    assert.equal((await pool.query(`SELECT resolution_state,financial_account_id,provenance
      FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1`, [bank.body.transactionId])).rows.length, 1);
    const accountResolution = (await pool.query(`SELECT resolution_state,financial_account_id,provenance
      FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1`, [bank.body.transactionId])).rows[0];
    assert.equal(accountResolution.resolution_state, 'MANUAL');
    assert.equal(Number(accountResolution.financial_account_id), fixture.accountId);
    assert.equal(accountResolution.provenance, 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT');
    assert.deepEqual(await expenseTotals(fixture), { amount: '0.00', count: 0 });

    const receipt = await syncFns(fixture);
    assert.equal(receipt.syncResult.normalization_ready_count, 1);
    assert.equal(receipt.accounting.reconciliations[0].persisted, 1);
    assert.deepEqual(await expenseTotals(fixture), { amount: '12.34', count: 1 });
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 1, bank_evidence: 1, matched_entries: 1, active_purchase_entries: 1, active_purchase_debits: '12.34',
    });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_entry_supersessions WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
    assert.equal((await certificationFacts(fixture)).length, 1);

    const duplicate = await ingestBank(fixture, { amount: '12.34' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.status, 'duplicate');
    const retry = await syncFns(fixture);
    assert.equal(retry.syncResult.inserted, 0);
    assert.equal(retry.accounting.reconciliations[0].persisted, 0);
    assert.deepEqual(await expenseTotals(fixture), { amount: '12.34', count: 1 });

    await closeFixture(fixture);
    fixture.server = createBankIngestionServer({ pool, logger: quietLogger, matchedPurchaseCanary: fixture.canary });
    await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
    fixture.baseUrl = `http://127.0.0.1:${fixture.server.address().port}`;
    const afterRestart = await syncFns(fixture);
    assert.equal(afterRestart.accounting.reconciliations[0].persisted, 0);
    assert.ok(afterRestart.accounting.reconciliations[0].reused >= 1);
    assert.deepEqual(await expenseTotals(fixture), { amount: '12.34', count: 1 });
    assert.equal((await matchedCounts(fixture)).active_purchase_entries, 1);
  } finally { await closeFixture(fixture); }
});

integration('new FNS-first purchase is automatically linked when its bound bank event arrives later', { concurrency: false }, async () => {
  const fixture = await createFixture('auto-fns-first-e2e', {
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  try {
    const receipt = await syncFns(fixture, { receipts: [{ amount: '45.67', suffix: 'late-bank-receipt' }] });
    assert.equal(receipt.accounting.reconciliations[0].persisted, 0);
    assert.deepEqual(await expenseTotals(fixture), { amount: '45.67', count: 1 });
    assert.equal((await matchedCounts(fixture)).matches, 0);

    const bank = await ingestBank(fixture, { amount: '45.67' });
    assert.equal(bank.status, 201);
    assert.equal(bank.body.reconciliation.status, 'COMPLETED');
    assert.deepEqual(await expenseTotals(fixture), { amount: '45.67', count: 1 });
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 1, bank_evidence: 1, matched_entries: 1, active_purchase_entries: 1, active_purchase_debits: '45.67',
    });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_entry_supersessions WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);
  } finally { await closeFixture(fixture); }
});

integration('new automatic matching processes independent unique pairs across providers and rejects unbound providers', { concurrency: false }, async () => {
  const fixture = await createFixture('auto-global-assignment-e2e', {
    canaryEnabled: false,
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: new Date(Date.now() - 15 * 60_000).toISOString(),
  });
  try {
    const base = Date.now() - 10 * 60_000;
    await syncFns(fixture, { receipts: [
      { amount: '20.00', suffix: 'independent-receipt-yandex', dateTime: new Date(base + 30_000).toISOString() },
      { amount: '22.00', suffix: 'independent-receipt-sber', dateTime: new Date(base + 240_000).toISOString() },
    ] });
    const otherBank = await createAdditionalBoundBankSource(fixture, 'ru.sberbankmobile', 'sber');
    const banks = await Promise.all([
      ingestBank(fixture, { amount: '20.00', id: 'independent-bank-yandex', dateTime: new Date(base).toISOString() }),
      ingestBank(fixture, {
        amount: '22.00', id: 'independent-bank-sber', dateTime: new Date(base + 240_000).toISOString(),
        provider: 'ru.sberbankmobile', adapter: 'android-notification',
        sourceKey: otherBank.sourceKey, credential: otherBank.credential,
        payload: {
          title: 'Покупка СИНТЕТИЧЕСКИЙ МЕРЧАНТ',
          description: '22 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 1357',
          text: '22 ₽ — Баланс: 123,45 ₽ Счёт карты МИР •• 1357',
        },
      }),
    ]);
    assert.ok(banks.every((item) => item.status === 201));
    const matching = await matchingForFixture(fixture, { automatic: true });
    const bankEvidence = (await pool.query(`SELECT count(*)::int AS transactions,
        count(DISTINCT eo.ingestion_metadata->>'provider')::int AS providers,
        count(DISTINCT r.financial_account_id)::int AS resolved_accounts,
        array_agg(DISTINCT concat_ws(':',bt.event_type,bt.direction,bt.normalization_status,r.resolution_state,r.provenance)) AS evidence_shapes
      FROM bank_transactions bt
      JOIN bank_event_observations eo ON eo.id=bt.observation_id
      LEFT JOIN bank_transaction_account_resolution r ON r.bank_transaction_id=bt.id
      WHERE eo.bank_source_id IN (SELECT bs.id FROM bank_sources bs
        JOIN bank_source_person sp ON sp.bank_source_id=bs.id
        WHERE sp.person_id=$1)`, [fixture.personId])).rows[0];
    assert.equal(matching.summary.matchedPairs, 2, JSON.stringify({
      summary: matching.summary,
      bankEvidence,
      banks: matching.bankStatuses.map((item) => ({ status: item.status, reasonCode: item.reasonCode })),
      receipts: matching.receiptStatuses.map((item) => ({ status: item.status, reasonCode: item.reasonCode })),
    }));
    assert.equal((await matchedCounts(fixture)).matches, 0);
    const reconciliation = await runAutomaticForFixture(fixture);
    assert.equal(reconciliation.persisted, 2);
    assert.equal(reconciliation.status, 'COMPLETED');
    assert.equal((await matchedCounts(fixture)).matches, 2);
    assert.deepEqual(await expenseTotals(fixture), { amount: '42.00', count: 2 });
    assert.equal((await matchedCounts(fixture)).active_purchase_entries, 2);
    const providerAssignments = (await pool.query(`SELECT eo.ingestion_metadata->>'provider' AS provider,
        m.financial_account_id,count(DISTINCT m.bank_transaction_id)::int AS banks,
        count(DISTINCT m.receipt_id)::int AS receipts
      FROM bank_receipt_matches m
      JOIN bank_transactions bt ON bt.id=m.bank_transaction_id
      JOIN bank_event_observations eo ON eo.id=bt.observation_id
      WHERE m.scope_id=$1
      GROUP BY eo.ingestion_metadata->>'provider',m.financial_account_id
      ORDER BY provider`, [fixture.scopeId])).rows;
    assert.deepEqual(providerAssignments.map((row) => ({
      provider: row.provider,
      accountId: Number(row.financial_account_id),
      banks: row.banks,
      receipts: row.receipts,
    })), [
      { provider: 'com.yandex.bank', accountId: fixture.accountId, banks: 1, receipts: 1 },
      { provider: 'ru.sberbankmobile', accountId: otherBank.accountId, banks: 1, receipts: 1 },
    ]);

    const unbound = await createFixture('auto-unbound-provider-e2e', {
      automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
      bankIngestedAfter: new Date(Date.now() - 60_000).toISOString(),
    });
    try {
      await syncFns(unbound, { receipts: [{ amount: '31.00', suffix: 'unbound-receipt' }] });
      const event = await ingestBank(unbound, { amount: '31.00', provider: 'com.unbound.bank' });
      assert.equal(event.status, 201);
      const resolution = (await pool.query('SELECT resolution_state,financial_account_id FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [event.body.transactionId])).rows[0];
      assert.equal(resolution.resolution_state, 'UNKNOWN');
      assert.equal(resolution.financial_account_id, null);
      assert.equal((await matchedCounts(unbound)).matches, 0);
      const unboundLedger = await matchedCounts(unbound);
      assert.equal(unboundLedger.active_purchase_entries, 1);
      assert.equal(unboundLedger.active_purchase_debits, '31.00');
    } finally { await closeFixture(unbound); }
  } finally { await closeFixture(fixture); }
});

integration('automatic matching cutoff excludes pre-activation bank observations while allowing the new cohort', { concurrency: false }, async () => {
  const cutoff = new Date(Date.now() + 250).toISOString();
  const fixture = await createFixture('auto-cutoff-e2e', {
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: cutoff,
  });
  try {
    const bank = await ingestBank(fixture, { amount: '8.00', id: 'before-activation-cutoff' });
    assert.equal(bank.status, 201);
    assert.equal(bank.body.reconciliation.status, 'BLOCKED');
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(cutoff) - Date.now() + 50)));
    const receipt = await syncFns(fixture, { receipts: [{ amount: '8.00', suffix: 'after-cutoff-receipt' }] });
    assert.equal(receipt.syncResult.normalization_ready_count, 1);
    assert.equal(receipt.accounting.reconciliations[0].persisted, 0);
    assert.equal((await matchedCounts(fixture)).matches, 0);
    assert.deepEqual(await expenseTotals(fixture), { amount: '8.00', count: 1 });
  } finally { await closeFixture(fixture); }
});

integration('automatic matching rejects old purchases even when their notifications arrive after cutoff', { concurrency: false }, async () => {
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const oldPurchaseAt = new Date(Date.parse(cutoff) - 60_000).toISOString();
  const fixture = await createFixture('auto-old-purchase-new-observation-e2e', {
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: cutoff,
  });
  try {
    const bank = await ingestBank(fixture, { amount: '9.25', id: 'old-purchase-late-notification', dateTime: oldPurchaseAt });
    assert.equal(bank.status, 201);
    const observation = (await pool.query(`SELECT eo.created_at,bt.occurred_at
      FROM bank_transactions bt JOIN bank_event_observations eo ON eo.id=bt.observation_id
      WHERE bt.id=$1`, [bank.body.transactionId])).rows[0];
    assert.ok(new Date(observation.created_at) >= new Date(cutoff));
    assert.ok(new Date(observation.occurred_at) < new Date(cutoff));

    const receipt = await syncFns(fixture, { receipts: [{ amount: '9.25', suffix: 'old-purchase-receipt', dateTime: oldPurchaseAt }] });
    assert.equal(receipt.syncResult.normalization_ready_count, 1);
    assert.equal(receipt.accounting.reconciliations[0].persisted, 0);
    const preview = await matchingForFixture(fixture, { automatic: true });
    assert.equal(preview.summary.matchedPairs, 0);
    const manualPreview = await loadBankReceiptMatching(pool, {
      scopeKey: fixture.scopeKey,
      ...matchedPurchaseReconciliationWindow(),
      bankIngestedAfter: cutoff,
      internalTransferMaxTimeDeltaMs: 5000,
      receiptMaxTimeDeltaMs: 300000,
    });
    assert.equal(manualPreview.summary.matchedPairs, 1);

    const staleCandidate = (await loadBankReceiptMatching(pool, {
      scopeKey: fixture.scopeKey,
      ...matchedPurchaseReconciliationWindow(),
      internalTransferMaxTimeDeltaMs: 5000,
      receiptMaxTimeDeltaMs: 300000,
      assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.UNAMBIGUOUS_COMPONENTS,
      requireSourceProviderBinding: true,
    })).matches[0];
    assert.ok(staleCandidate);
    await assert.rejects(() => persistMatchedPurchaseForTest(pool, {
      scopeKey: fixture.scopeKey,
      ...matchedPurchaseReconciliationWindow(),
      matchKey: staleCandidate.matchKey,
      automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
      assignmentPolicy: BANK_RECEIPT_MATCH_ASSIGNMENT_POLICIES.UNAMBIGUOUS_COMPONENTS,
      requireSourceProviderBinding: true,
      bankIngestedAfter: cutoff,
      internalTransferMaxTimeDeltaMs: 5000,
      receiptMaxTimeDeltaMs: 300000,
      matchingLoader: async () => ({ matches: [staleCandidate] }),
    }), (error) => error.code === 'AUTO_BANK_EVENT_OUTSIDE_COHORT');

    assert.deepEqual(await matchedCounts(fixture), {
      matches: 0, bank_evidence: 0, matched_entries: 0, active_purchase_entries: 1, active_purchase_debits: '9.25',
    });
    assert.deepEqual(await expenseTotals(fixture), { amount: '9.25', count: 1 });
    const replay = await runAutomaticForFixture(fixture);
    assert.equal(replay.persisted, 0);
    assert.equal(replay.reused, 0);
    assert.equal((await matchedCounts(fixture)).matches, 0);
    assert.deepEqual(await expenseTotals(fixture), { amount: '9.25', count: 1 });
  } finally { await closeFixture(fixture); }
});

integration('one purchase with two compatible receipts stays review-only while an independent pair is persisted', { concurrency: false }, async () => {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const fixture = await createFixture('auto-one-bank-two-receipts-e2e', {
    canaryEnabled: false,
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: cutoff,
  });
  try {
    const base = Date.now() - 8 * 60_000;
    await syncFns(fixture, { receipts: [
      { amount: '20.00', suffix: 'ambiguous-a', dateTime: new Date(base).toISOString() },
      { amount: '20.00', suffix: 'ambiguous-b', dateTime: new Date(base + 240_000).toISOString() },
      { amount: '33.00', suffix: 'independent', dateTime: new Date(base + 120_000).toISOString() },
    ] });
    await ingestBank(fixture, { amount: '20.00', id: 'one-bank-two-receipts', dateTime: new Date(base + 120_000).toISOString() });
    await ingestBank(fixture, { amount: '33.00', id: 'independent-pair', dateTime: new Date(base + 120_000).toISOString() });

    const preview = await matchingForFixture(fixture, { automatic: true });
    assert.equal(preview.summary.matchedPairs, 1);
    assert.equal(preview.summary.ambiguousBankPurchases, 1);
    assert.equal(preview.summary.ambiguousReceipts, 2);
    assert.equal(preview.matches[0].amount, '33.00');

    const before = await matchedCounts(fixture);
    assert.equal(before.matches, 0);
    assert.deepEqual(await expenseTotals(fixture), { amount: '73.00', count: 3 });
    const result = await runAutomaticForFixture(fixture);
    assert.equal(result.persisted, 1);
    assert.equal(result.ambiguous, 1);
    assert.equal(result.ambiguousReceipts, 2);
    assert.equal(result.status, 'REVIEW_REQUIRED');
    assert.deepEqual(await expenseTotals(fixture), { amount: '73.00', count: 3 });
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 1, bank_evidence: 1, matched_entries: 1, active_purchase_entries: 3, active_purchase_debits: '73.00',
    });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM bank_receipt_matches
      WHERE scope_id=$1 AND amount=20.00`, [fixture.scopeId])).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM bank_receipt_matches
      WHERE scope_id=$1 AND amount=33.00`, [fixture.scopeId])).rows[0].count, 1);
  } finally { await closeFixture(fixture); }
});

integration('two purchases with one compatible receipt stay review-only without financial matching writes', { concurrency: false }, async () => {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const fixture = await createFixture('auto-two-banks-one-receipt-e2e', {
    canaryEnabled: false,
    automaticPolicy: MATCHED_PURCHASE_AUTO_POLICY,
    bankIngestedAfter: cutoff,
  });
  try {
    const base = Date.now() - 8 * 60_000;
    await syncFns(fixture, { receipts: [
      { amount: '45.00', suffix: 'single-compatible', dateTime: new Date(base + 30_000).toISOString() },
    ] });
    await ingestBank(fixture, { amount: '45.00', id: 'competing-purchase-a', dateTime: new Date(base).toISOString() });
    await ingestBank(fixture, { amount: '45.00', id: 'competing-purchase-b', dateTime: new Date(base + 60_000).toISOString() });

    const preview = await matchingForFixture(fixture, { automatic: true });
    assert.equal(preview.summary.matchedPairs, 0);
    assert.equal(preview.summary.ambiguousBankPurchases, 2);
    assert.equal(preview.summary.ambiguousReceipts, 1);
    assert.ok(preview.bankStatuses.filter((row) => row.status === 'AMBIGUOUS').length >= 2);
    assert.equal(preview.receiptStatuses[0].status, 'AMBIGUOUS');

    const result = await runAutomaticForFixture(fixture);
    assert.equal(result.persisted, 0);
    assert.equal(result.ambiguous, 2);
    assert.equal(result.ambiguousReceipts, 1);
    assert.equal(result.status, 'REVIEW_REQUIRED');
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 0, bank_evidence: 0, matched_entries: 0, active_purchase_entries: 1, active_purchase_debits: '45.00',
    });
    assert.deepEqual(await expenseTotals(fixture), { amount: '45.00', count: 1 });
  } finally { await closeFixture(fixture); }
});

integration('FNS-first standalone expense is refined by later bank ingestion without double counting', { concurrency: false }, async () => {
  const fixture = await createFixture('fns-first-e2e');
  try {
    const fns = await syncFns(fixture, { receipts: [{ amount: '45.67', suffix: 'receipt-a' }] });
    assert.equal(fns.accounting.reconciliations[0].persisted, 0);
    assert.deepEqual(await expenseTotals(fixture), { amount: '45.67', count: 1 });
    assert.equal((await matchedCounts(fixture)).matches, 0);

    const bank = await ingestBank(fixture, { amount: '45.67' });
    assert.equal(bank.status, 201);
    assert.equal(bank.body.status, 'created');
    assert.equal(bank.body.reconciliation.status, 'BLOCKED');
    assert.deepEqual(await expenseTotals(fixture), { amount: '45.67', count: 1 });
    assert.equal((await matchedCounts(fixture)).matches, 0);
    fixture.canary.approvedMatchKey = (await matchingForFixture(fixture)).matches[0].matchKey;
    const trigger = await ingestBank(fixture, { amount: '91.11', id: 'post-review-trigger', dateTime: new Date(Date.parse(fixture.dateTime) + 120_000).toISOString() });
    assert.equal(trigger.status, 201);
    assert.equal(trigger.body.reconciliation.status, 'COMPLETED');
    assert.equal(trigger.body.reconciliation.reasonCode, undefined);
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 1, bank_evidence: 1, matched_entries: 1, active_purchase_entries: 1, active_purchase_debits: '45.67',
    });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_entry_supersessions WHERE scope_id=$1', [fixture.scopeId])).rows[0].count, 1);

    const report = await analyticsSummary(pool, { scopeKey: fixture.scopeKey });
    assert.equal(report.metrics.CONFIRMED_ACQUISITION_VALUE.status, 'CERTIFIED');
    assert.equal(report.metrics.CONFIRMED_ACQUISITION_VALUE.amount, '45.67');
    assert.equal(report.metrics.CONFIRMED_ACQUISITION_VALUE.count, 1);
    const [left, right] = await Promise.all([
      runBoundedMatchedPurchaseReconciliation(pool, { ...matchedPurchaseReconciliationWindow(), enabled: true, scopeKey: fixture.scopeKey, canaryScopeKey: fixture.scopeKey, approvedMatchKey: fixture.canary.approvedMatchKey }),
      runBoundedMatchedPurchaseReconciliation(pool, { ...matchedPurchaseReconciliationWindow(), enabled: true, scopeKey: fixture.scopeKey, canaryScopeKey: fixture.scopeKey, approvedMatchKey: fixture.canary.approvedMatchKey }),
    ]);
    assert.equal(left.persisted + right.persisted, 0);
    assert.equal(left.reused + right.reused, 2);
    assert.deepEqual(await expenseTotals(fixture), { amount: '45.67', count: 1 });
    assert.equal((await matchedCounts(fixture)).active_purchase_entries, 1);
  } finally { await closeFixture(fixture); }
});

integration('concurrent canary invocations recheck the same candidate transactionally and write once', { concurrency: false }, async () => {
  const fixture = await createFixture('concurrent-create-e2e', { canaryEnabled: false });
  try {
    await syncFns(fixture, {
      receipts: [{ amount: '17.25', suffix: 'receipt' }],
      canary: { enabled: false, canaryScopeKey: fixture.scopeKey },
    });
    await ingestBank(fixture, { amount: '17.25' });
    fixture.canary.approvedMatchKey = (await matchingForFixture(fixture)).matches[0].matchKey;

    let previewCalls = 0;
    let releasePreviews;
    let barrierTimeout;
    const bothPreviewsReady = new Promise((resolve, reject) => {
      releasePreviews = resolve;
      barrierTimeout = setTimeout(() => reject(new Error('concurrent preview barrier timed out')), 10_000);
    });
    const gatedPreview = async (client, options) => {
      const result = await previewMatchedPurchaseOrchestration(client, options);
      previewCalls += 1;
      if (previewCalls === 2) {
        clearTimeout(barrierTimeout);
        releasePreviews();
      }
      await bothPreviewsReady;
      return result;
    };
    const reconcile = () => runBoundedMatchedPurchaseReconciliation(pool, {
      ...matchedPurchaseReconciliationWindow(),
      enabled: true,
      scopeKey: fixture.scopeKey,
      canaryScopeKey: fixture.scopeKey,
      approvedMatchKey: fixture.canary.approvedMatchKey,
      preview: gatedPreview,
    });
    const results = await Promise.all([reconcile(), reconcile()]);
    assert.deepEqual(results.map((item) => item.persisted).sort(), [0, 1]);
    assert.deepEqual(results.map((item) => item.reused).sort(), [0, 1]);
    assert.deepEqual(await expenseTotals(fixture), { amount: '17.25', count: 1 });
    assert.deepEqual(await matchedCounts(fixture), {
      matches: 1, bank_evidence: 1, matched_entries: 1, active_purchase_entries: 1, active_purchase_debits: '17.25',
    });
    assert.equal((await certificationFacts(fixture)).length, 1);
  } finally { await closeFixture(fixture); }
});

integration('default-off, ambiguous receipts and writer conflicts never create an unsupported match', { concurrency: false }, async () => {
  const fixture = await createFixture('fail-closed-e2e');
  try {
    await ingestBank(fixture, { amount: '20.00' });
    const noOptIn = await syncFns(fixture, {
      receipts: [{ amount: '20.00', suffix: 'receipt-a' }, { amount: '20.00', suffix: 'receipt-b', dateTime: fixture.dateTime }],
      canary: { enabled: false, canaryScopeKey: fixture.scopeKey },
    });
    assert.deepEqual(noOptIn.accounting.reconciliations, []);
    assert.equal((await matchedCounts(fixture)).matches, 0);
    assert.deepEqual(await expenseTotals(fixture), { amount: '40.00', count: 2 });

    const ambiguous = await runBoundedMatchedPurchaseReconciliation(pool, {
      ...matchedPurchaseReconciliationWindow(), enabled: true, scopeKey: fixture.scopeKey, canaryScopeKey: fixture.scopeKey,
    });
    assert.equal(ambiguous.persisted, 0);
    assert.equal(ambiguous.reasonCode, 'APPROVED_MATCH_KEY_REQUIRED');
    const ambiguousPreview = await previewMatchedPurchaseOrchestration(pool, {
      scopeKey: fixture.scopeKey, ...matchedPurchaseReconciliationWindow(),
      internalTransferMaxTimeDeltaMs: 5000, receiptMaxTimeDeltaMs: 300000,
    });
    assert.equal(ambiguousPreview.readiness, 'REVIEW_REQUIRED');
    assert.ok(ambiguousPreview.summary.ambiguousBankPurchases > 0);
    assert.equal((await matchedCounts(fixture)).matches, 0);

    const fixtureConflict = await createFixture('writer-conflict-e2e', { canaryEnabled: false });
    try {
      await syncFns(fixtureConflict, { receipts: [{ amount: '31.25', suffix: 'receipt' }], canary: { enabled: false, canaryScopeKey: fixtureConflict.scopeKey } });
      await ingestBank(fixtureConflict, { amount: '31.25' });
      const window = matchedPurchaseReconciliationWindow();
      const matching = await loadBankReceiptMatching(pool, {
        scopeKey: fixtureConflict.scopeKey,
        ...window,
        internalTransferMaxTimeDeltaMs: 5000,
        receiptMaxTimeDeltaMs: 300000,
      });
      assert.equal(matching.matches.length, 1);
      const match = matching.matches[0];
      fixtureConflict.canary.approvedMatchKey = match.matchKey;
      await pool.query(`INSERT INTO bank_receipt_matches(
          scope_id,bank_transaction_id,receipt_id,financial_account_id,matcher_version,match_key,
          bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,
          receipt_normalization_version,receipt_normalized_content_sha256,amount,currency,
          bank_occurred_at,receipt_date_time,time_delta_seconds,relationship_type,reason_code,ownership_provenance)
        VALUES($1,$2,$3,$4,'bank-receipt-matching-v1',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'MATCHED_PURCHASE','SYNTHETIC_CONFLICT',$17::jsonb)`, [
        fixtureConflict.scopeId,
        match.bank.bankTransactionId,
        match.receipt.receiptId,
        match.bank.financialAccountId,
        match.matchKey,
        match.bank.ledgerKey,
        match.bank.candidateKey,
        match.bank.journalKey,
        match.receipt.receiptCandidateKey,
        match.receipt.normalizationVersion,
        match.receipt.normalizedContentSha256,
        match.amount,
        match.currency,
        match.bank.occurredAt,
        match.receipt.dateTime,
        (match.timeDeltaMs / 1000).toFixed(6),
        JSON.stringify(match.bankAccountOwnershipProvenance),
      ]);
      const conflict = await runBoundedMatchedPurchaseReconciliation(pool, {
        ...window, enabled: true, scopeKey: fixtureConflict.scopeKey, canaryScopeKey: fixtureConflict.scopeKey, approvedMatchKey: match.matchKey,
      });
      assert.equal(conflict.errors, 1);
      assert.equal(conflict.reasonCode, 'MATCH_PERSISTENCE_CONFLICT');
      assert.equal(conflict.persisted, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM business_event_bank_evidence WHERE scope_id=$1', [fixtureConflict.scopeId])).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger_entries WHERE scope_id=$1 AND derivation_rule='LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1'", [fixtureConflict.scopeId])).rows[0].count, 0);
    } finally { await closeFixture(fixtureConflict); }
  } finally { await closeFixture(fixture); }
});

integration('same amount, time and scope with different sellers stays REVIEW_REQUIRED without an approved key', { concurrency: false }, async () => {
  const fixture = await createFixture('different-sellers-e2e');
  try {
    await ingestBank(fixture, { amount: '20.00', merchant: 'Synthetic seller Alpha' });
    await syncFns(fixture, { receipts: [{ amount: '20.00', suffix: 'seller-beta', merchant: 'Synthetic seller Beta' }] });
    const bankSeller = (await pool.query(`SELECT o.payload->>'merchant' AS seller
      FROM bank_event_observations o JOIN bank_sources s ON s.id=o.bank_source_id WHERE s.source_key=$1`, [fixture.bankSourceKey])).rows[0].seller;
    const receiptSeller = (await pool.query(`SELECT r.seller FROM receipts r
      JOIN receipt_source_observations o ON o.receipt_id=r.id WHERE o.fns_source_id=$1`, [fixture.fnsSourceId])).rows[0].seller;
    assert.equal(bankSeller, 'Synthetic seller Alpha');
    assert.equal(receiptSeller, 'Synthetic seller Beta');
    assert.equal((await matchingForFixture(fixture)).matches.length, 1);
    const review = await previewMatchedPurchaseOrchestration(pool, {
      scopeKey: fixture.scopeKey, ...matchedPurchaseReconciliationWindow(),
      internalTransferMaxTimeDeltaMs: 5000, receiptMaxTimeDeltaMs: 300000,
    });
    assert.equal(review.readiness, 'REVIEW_REQUIRED');
    assert.equal(review.decisions[0].reasonCode, 'INDEPENDENT_MATCH_EVIDENCE_REQUIRED');
    assert.equal((await matchedCounts(fixture)).matches, 0);
    assert.deepEqual(await expenseTotals(fixture), { amount: '20.00', count: 1 });
  } finally { await closeFixture(fixture); }
});

integration('bank reconciliation requires one unambiguous event scope matching the canary', { concurrency: false }, async () => {
  let reconcileCalls = 0;
  const scopeA = await createFixture('scope-a-e2e', { canaryEnabled: false });
  const scopeB = await createFixture('scope-b-e2e', {
    canaryScopeKey: scopeA.scopeKey,
    approvedMatchKey: 'a'.repeat(64),
    reconcileMatchedPurchases: async () => { reconcileCalls += 1; return { status: 'COMPLETED' }; },
  });
  const scopeC = await createFixture('scope-c-e2e', { canaryEnabled: false });
  try {
    const otherScope = await ingestBank(scopeB, { amount: '9.00', id: 'scope-mismatch' });
    assert.equal(otherScope.status, 201);
    assert.deepEqual(otherScope.body.reconciliation, { status: 'BLOCKED', reasonCode: 'CANARY_SCOPE_MISMATCH' });
    assert.equal(reconcileCalls, 0);

    await linkBankSourcePerson(pool, { sourceKey: scopeB.bankSourceKey, personId: scopeC.personId });
    const ambiguousScope = await ingestBank(scopeB, { amount: '9.01', id: 'scope-ambiguous' });
    assert.equal(ambiguousScope.status, 201);
    assert.deepEqual(ambiguousScope.body.reconciliation, { status: 'BLOCKED', reasonCode: 'BANK_EVENT_SCOPE_AMBIGUOUS' });
    assert.equal(reconcileCalls, 0);

    await pool.query('DELETE FROM bank_source_person WHERE bank_source_id=(SELECT id FROM bank_sources WHERE source_key=$1)', [scopeB.bankSourceKey]);
    const unresolvedScope = await ingestBank(scopeB, { amount: '9.02', id: 'scope-unresolved' });
    assert.equal(unresolvedScope.status, 201);
    assert.deepEqual(unresolvedScope.body.reconciliation, { status: 'BLOCKED', reasonCode: 'BANK_EVENT_SCOPE_UNRESOLVED' });
    assert.equal(reconcileCalls, 0);
  } finally {
    await closeFixture(scopeA);
    await closeFixture(scopeB);
    await closeFixture(scopeC);
  }
});

integration('one configured matchKey is the shared canary budget across retries, bank posts and FNS sync', { concurrency: false }, async () => {
  let reconcileCalls = 0;
  const fixture = await createFixture('single-key-budget-e2e', {
    reconcileMatchedPurchases: async (targetPool, options) => {
      reconcileCalls += 1;
      return runBoundedMatchedPurchaseReconciliation(targetPool, options);
    },
  });
  try {
    const secondTime = new Date(Date.now() - 12 * 60_000).toISOString();
    await syncFns(fixture, { receipts: [
      { amount: '10.00', suffix: 'pair-a', dateTime: fixture.dateTime, merchant: 'Synthetic A' },
      { amount: '20.00', suffix: 'pair-b', dateTime: secondTime, merchant: 'Synthetic B' },
    ] });
    await ingestBank(fixture, { amount: '10.00', id: 'pair-a', dateTime: fixture.dateTime });
    await ingestBank(fixture, { amount: '20.00', id: 'pair-b', dateTime: secondTime });
    const candidates = (await matchingForFixture(fixture)).matches;
    assert.equal(candidates.length, 2);
    fixture.canary.approvedMatchKey = candidates[0].matchKey;

    const callsBeforeDuplicate = reconcileCalls;
    const oldReplay = await ingestBank(fixture, { amount: '10.00', id: 'pair-a', dateTime: fixture.dateTime });
    assert.equal(oldReplay.status, 200);
    assert.equal(Object.hasOwn(oldReplay.body, 'reconciliation'), false);
    assert.equal(reconcileCalls, callsBeforeDuplicate);
    assert.equal((await matchedCounts(fixture)).matches, 0);

    const trigger = await ingestBank(fixture, { amount: '77.77', id: 'approved-key-trigger' });
    assert.equal(trigger.status, 201);
    assert.equal(trigger.body.reconciliation.status, 'COMPLETED');
    assert.equal((await matchedCounts(fixture)).matches, 1);
    await syncFns(fixture);
    assert.equal((await matchedCounts(fixture)).matches, 1);

    const triggerReplay = await ingestBank(fixture, { amount: '77.77', id: 'approved-key-trigger' });
    assert.equal(triggerReplay.status, 200);
    assert.equal(Object.hasOwn(triggerReplay.body, 'reconciliation'), false);
    assert.equal((await matchedCounts(fixture)).matches, 1);

    const concurrent = await Promise.all([
      ingestBank(fixture, { amount: '78.01', id: 'concurrent-trigger-a' }),
      ingestBank(fixture, { amount: '78.02', id: 'concurrent-trigger-b' }),
    ]);
    assert.ok(concurrent.every((item) => item.status === 201));
    assert.ok(concurrent.every((item) => item.body.reconciliation.status === 'COMPLETED'));
    assert.equal((await matchedCounts(fixture)).matches, 1);
    const remaining = (await pool.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE scope_id=$1 AND match_key<>$2', [fixture.scopeId, fixture.canary.approvedMatchKey])).rows[0].count;
    assert.equal(remaining, 0);
    assert.equal(reconcileCalls, callsBeforeDuplicate + 3);
  } finally { await closeFixture(fixture); }
});

integration('post-commit reconciliation errors preserve the bank ingestion HTTP result and expose only a safe code', { concurrency: false }, async () => {
  let calls = 0;
  const fixture = await createFixture('post-commit-error-e2e', {
    reconcileMatchedPurchases: async () => {
      calls += 1;
      throw Object.assign(new Error('private financial details must not escape'), { code: 'SYNTHETIC_RECONCILIATION_FAILURE' });
    },
  });
  try {
    const created = await ingestBank(fixture, { amount: '6.25' });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'created');
    assert.deepEqual(created.body.reconciliation, { status: 'ERROR', reasonCode: 'SYNTHETIC_RECONCILIATION_FAILURE' });
    assert.doesNotMatch(JSON.stringify(created.body.reconciliation), /private financial details|6\.25|merchant/i);
    const duplicate = await ingestBank(fixture, { amount: '6.25' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.status, 'duplicate');
    assert.equal(Object.hasOwn(duplicate.body, 'reconciliation'), false);
    assert.equal(calls, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_event_observations')).rows[0].count, 1);
  } finally { await closeFixture(fixture); }
});

integration('cash flow remains separate from certified expenses and certification analytics count one matched purchase', { concurrency: false }, async () => {
  const fixture = await createFixture('separate-totals-e2e');
  try {
    const bank = await ingestBank(fixture, { amount: '8.90' });
    assert.equal(bank.status, 201);
    assert.deepEqual(await expenseTotals(fixture), { amount: '0.00', count: 0 });
    const cashFlow = await loadBankCashFlowProjection(pool, { scopeKey: fixture.scopeKey });
    const purchases = cashFlow.projections.filter((row) => row.movementType === 'PURCHASE');
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].amount, '8.90');

    await syncFns(fixture, { receipts: [{ amount: '8.90', suffix: 'receipt' }] });
    fixture.canary.approvedMatchKey = (await matchingForFixture(fixture)).matches[0].matchKey;
    await syncFns(fixture);
    const summary = await analyticsSummary(pool, { scopeKey: fixture.scopeKey });
    assert.deepEqual({ amount: summary.metrics.CONFIRMED_ACQUISITION_VALUE.amount, count: summary.metrics.CONFIRMED_ACQUISITION_VALUE.count }, { amount: '8.90', count: 1 });
    assert.equal((await matchedCounts(fixture)).active_purchase_debits, '8.90');
    assert.equal(purchases.reduce((sum, row) => sum + Number(row.amount), 0), 8.9);
    assert.equal(summary.metrics.CONFIRMED_ACQUISITION_VALUE.amount, '8.90');
  } finally { await closeFixture(fixture); }
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { assertDisposableLocalTestDatabase } from '../scripts/assert-disposable-local-test-database.js';
import { backfillNormalization } from '../src/fiscal-normalization.js';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { runAccountingCatchup } from '../src/accounting-pipeline.js';
import { runBankOnlyPurchaseCatchup, writeBankOnlyPurchase } from '../src/bank-only-purchase.js';
import { rebuildCertification } from '../src/certification.js';
import { rebuildLedger } from '../src/ledger.js';
import { PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE, PREPAYMENT_BANK_FUNDING_LINK_ROLE } from '../src/prepayment-bank-funding-contract.js';
import { persistPrepaymentSettlementMatches } from '../src/prepayment-settlement-matcher.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  test('prepayment funding PostgreSQL integration environment is required', { skip: 'TEST_DATABASE_URL is not set; use npm run test:integration' }, () => {});
} else {
  assertDisposableLocalTestDatabase(connectionString);
  const admin = new pg.Pool({ connectionString, max: 12 });
  let runtimeRoleCreated = false;
  const runtimePool = {
    query: (...args) => admin.query(...args),
    async connect() {
      const client = await admin.connect();
      await client.query('SET ROLE receipt_collector');
      return {
        query: (...args) => client.query(...args),
        release(error) {
          void client.query('RESET ROLE').then(
            () => client.release(error),
            () => client.release(error ?? true),
          );
        },
      };
    },
  };

  function iso(offsetMs = 0) { return new Date(Date.now() + offsetMs).toISOString(); }
  function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

  async function reset() {
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrate(admin);
    await admin.query('GRANT USAGE ON SCHEMA public TO receipt_collector');
  }

  async function seedBank({ occurredAt, observedAt, count = 1, amount = '100.00' }) {
    const result = [];
    const scopeId = Number((await admin.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0].id);
    const person = Number((await admin.query("SELECT id FROM persons WHERE scope_id=$1 ORDER BY id LIMIT 1", [scopeId])).rows[0].id);
    const provider = 'bank.example';
    for (let index = 0; index < count; index += 1) {
      const suffix = `${process.pid}-${Date.now()}-${index}`;
      const accountId = Number((await admin.query(`INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency)
        VALUES($1,'Synthetic bank',$2,$3,'RUB') RETURNING id`, [scopeId, provider, `Synthetic account ${suffix}`])).rows[0].id);
      await admin.query(`INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason)
        VALUES($1,$2,'OWNER','USER_CONFIRMED','synthetic integration fixture')`, [accountId, person]);
      const sourceId = Number((await admin.query(`INSERT INTO bank_sources(source_key,source_type,display_name)
        VALUES($1,'ANDROID_NOTIFICATION','Synthetic source') RETURNING id`, [`synthetic-source-${suffix}`])).rows[0].id);
      await admin.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [sourceId, person]);
      await admin.query(`INSERT INTO bank_source_provider_account_bindings(bank_source_id,provider,financial_account_id,provenance,reason)
        VALUES($1,$2,$3,'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT','synthetic integration fixture')`, [sourceId, provider, accountId]);
      const observationId = Number((await admin.query(`INSERT INTO bank_event_observations(bank_source_id,source_event_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata,created_at)
        VALUES($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7::jsonb,$4) RETURNING id`, [sourceId, `synthetic-${suffix}`, sha(`dedup-${suffix}`), observedAt, occurredAt,
        sha(`payload-${suffix}`), JSON.stringify({ provider })])).rows[0].id);
      const bankTransactionId = Number((await admin.query(`INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,merchant,event_type,normalization_status,normalization_version,evidence_quality)
        VALUES($1,$2,$3,'RUB','DEBIT','Synthetic merchant','PURCHASE','READY','synthetic-v1','EXACT') RETURNING id`, [observationId, new Date(Date.parse(occurredAt) + index).toISOString(), amount])).rows[0].id);
      await admin.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
        VALUES($1,$2,'MANUAL','USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT','synthetic integration fixture')`, [bankTransactionId, accountId]);
      result.push({ bankTransactionId, accountId, sourceId });
    }
    return result;
  }

  async function seedReceipts({ prepaymentAt, settlementAt, order = 'same', amount = 100 }) {
    const sourceId = Number((await admin.query("SELECT id FROM fns_sources WHERE source_key='legacy-default'")).rows[0].id);
    const repo = new ReceiptRepository(admin);
    const itemA = { name: 'Synthetic product A', quantity: 1, price: 60, sum: 60, paymentType: 1, productType: 1, providerInn: '7700000000' };
    const itemB = { name: 'Synthetic product B', quantity: 1, price: 40, sum: 40, paymentType: 1, productType: 1, providerInn: '7700000000' };
    const itemsPre = amount === 100 ? [itemA, itemB] : [{ ...itemA, price: amount, sum: amount }];
    const itemsSettle = order === 'reversed' ? [...itemsPre].reverse() : itemsPre;
    const raw = (key, dateTime, stage, items) => ({
      key, dateTime, totalSum: amount, user: 'Synthetic merchant', userInn: '7700000000', operationType: 1,
      fiscalDriveNumber: `drive-${key}`, fiscalDocumentNumber: `doc-${key}`, fiscalSign: `sign-${key}`,
      fiscalDocumentFormatVer: '4', cashTotalSum: 0, ecashTotalSum: stage === 'PREPAYMENT_ONLY' ? amount : 0,
      prepaidSum: stage === 'PREPAYMENT_ONLY' ? 0 : amount, creditSum: 0, provisionSum: 0,
      currency: null, items,
    });
    const pre = raw(`pre-${process.pid}-${Date.now()}`, prepaymentAt, 'PREPAYMENT_ONLY', itemsPre);
    const settle = raw(`settle-${process.pid}-${Date.now()}`, settlementAt, 'SETTLEMENT_ONLY', itemsSettle.map((item) => ({ ...item, paymentType: 4 })));
    const normalize = (input) => ({
      id: input.key, dateTime: input.dateTime, seller: input.user, sellerInn: input.userInn,
      totalSum: input.totalSum, currency: null, operationType: input.operationType,
      cashTotalSum: input.cashTotalSum, ecashTotalSum: input.ecashTotalSum,
      prepaidSum: input.prepaidSum, creditSum: input.creditSum, provisionSum: input.provisionSum,
      items: input.items.map((item) => ({ ...item, productCode: null })),
    });
    const receipts = [];
    for (const input of [pre, settle]) {
      const saved = await repo.upsertBundle({ normalized: normalize(input), raw: input });
      await admin.query(`INSERT INTO receipt_source_observations(fns_source_id,receipt_id,source_receipt_id,source_content_sha256)
        VALUES($1,$2,$3,$4)`, [sourceId, saved.id, input.key, sha(`fns-${input.key}`)]);
      receipts.push(saved);
    }
    await backfillNormalization(admin);
    return receipts;
  }

  const optIn = (startAt) => ({ enabled: true, scopeKey: 'default', startAt, alfaStartAt: null, maxWrites: 25 });

  before(async () => {
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='receipt_collector'");
    if (!existing.rowCount) {
      await admin.query('CREATE ROLE receipt_collector NOLOGIN');
      runtimeRoleCreated = true;
    } else assert.equal((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='receipt_collector'")).rows[0].rolcanlogin, false);
    await reset();
  });
  after(async () => {
    try {
      if (runtimeRoleCreated) {
        await admin.query('DROP OWNED BY receipt_collector');
        await admin.query('DROP ROLE receipt_collector');
      }
    } finally { await admin.end(); }
  });

  test('prepayment lifecycle writer remains disabled when cutoff is unset or later than receipt ingestion', { concurrency: false }, async () => {
    await reset();
    const now = Date.now();
    await seedReceipts({
      prepaymentAt: new Date(now - 120_000).toISOString(),
      settlementAt: new Date(now - 30_000).toISOString(), order: 'same',
    });
    const withoutCutoff = await persistPrepaymentSettlementMatches(admin, { startAt: null });
    assert.equal(withoutCutoff.summary.confirmedSettlements, 1);
    assert.equal(withoutCutoff.created.purchases, 0);
    assert.equal(withoutCutoff.blockedByStartAt[0].reason, 'PREPAYMENT_SETTLEMENT_START_AT_UNSET');
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM business_events')).rows[0].count, 0);

    const afterIngestion = await persistPrepaymentSettlementMatches(admin, {
      startAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(afterIngestion.created.purchases, 0);
    assert.equal(afterIngestion.blockedByStartAt[0].reason, 'OUTSIDE_PREPAYMENT_SETTLEMENT_COHORT');
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM business_events')).rows[0].count, 0);
  });

  test('bank-first bank-only expense is refined into one prepayment lifecycle expense and retries are idempotent', { concurrency: false }, async () => {
    await reset();
    const now = Date.now();
    const startAt = new Date(now - 5 * 60_000).toISOString();
    const occurredAt = new Date(now - 130_000).toISOString();
    const observedAt = new Date(now - 120_000).toISOString();
    const [bank] = await seedBank({ occurredAt, observedAt });
    const bankOnly = await runBankOnlyPurchaseCatchup(runtimePool, {
      scopeKey: 'default', optIn: optIn(startAt), now: new Date(now), logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(bankOnly.persisted, 1);
    const priorCertification = await rebuildCertification(runtimePool, { persist: true });

    const [prepaymentReceipt, settlementReceipt] = await seedReceipts({
      prepaymentAt: new Date(now - 140_000).toISOString(),
      settlementAt: new Date(now - 40_000).toISOString(), order: 'reversed',
    });
    const catchup = await runAccountingCatchup(runtimePool, {
      scopeKey: 'default', logger: { info() {}, warn() {}, error() {} },
      bankOnlyPurchaseOptIn: optIn(startAt), prepaymentSettlementStartAt: startAt, now: new Date(now),
    });
    assert.equal(catchup.prepayments.created.purchases, 1);
    assert.equal(catchup.prepaymentBankFunding.persisted, 1);
    assert.equal(catchup.prepaymentBankFunding.superseded, 1);
    assert.notEqual(catchup.certification.runId, priorCertification.runId);
    assert.notEqual(catchup.certification.sourceStateKey, priorCertification.sourceStateKey);
    const snapshots = await admin.query('SELECT id FROM reconciliation_runs WHERE id = ANY($1::bigint[])',
      [[priorCertification.runId, catchup.certification.runId]]);
    assert.equal(snapshots.rowCount, 2);

    const persisted = (await admin.query(`SELECT
      (SELECT count(*)::int FROM business_event_bank_evidence WHERE bank_transaction_id=$1 AND evidence_role=$2) AS evidence,
      (SELECT count(*)::int FROM ledger_source_links WHERE bank_transaction_id=$1 AND link_role=$3) AS funding_links,
      (SELECT count(*)::int FROM ledger_entries e JOIN ledger_source_links l ON l.ledger_entry_id=e.id
        WHERE l.bank_transaction_id=$1 AND l.link_role='BANK_ONLY_PURCHASE'
          AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss WHERE ss.scope_id=e.scope_id AND ss.superseded_ledger_entry_id=e.id)) AS active_bank_only,
      (SELECT count(DISTINCT e.id)::int FROM ledger_entries e JOIN ledger_postings p ON p.ledger_entry_id=e.id
        JOIN ledger_accounts a ON a.id=p.account_id
        WHERE e.scope_id=(SELECT id FROM accounting_scopes WHERE scope_key='default')
          AND a.account_code='UNCLASSIFIED_ACQUISITION' AND p.debit='100.00'
          AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss WHERE ss.scope_id=e.scope_id AND ss.superseded_ledger_entry_id=e.id)) AS active_acquisition_entries`,
    [bank.bankTransactionId, PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE, PREPAYMENT_BANK_FUNDING_LINK_ROLE])).rows[0];
    assert.deepEqual(persisted, { evidence: 1, funding_links: 1, active_bank_only: 0, active_acquisition_entries: 1 });
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE bank_transaction_id=$1', [bank.bankTransactionId])).rows[0].count, 0);
    assert.ok(prepaymentReceipt.id > 0 && settlementReceipt.id > 0);

    await rebuildLedger(runtimePool, { scopeKey: 'default' });
    const replay = await runAccountingCatchup(runtimePool, {
      scopeKey: 'default', logger: { info() {}, warn() {}, error() {} },
      bankOnlyPurchaseOptIn: optIn(startAt), prepaymentSettlementStartAt: startAt, now: new Date(now),
    });
    assert.equal(replay.prepaymentBankFunding.persisted, 0);
    assert.equal(replay.prepaymentBankFunding.reused, 1);
    assert.equal(replay.certification.runId, catchup.certification.runId);
    assert.equal(replay.certification.reused, true);
    const bankRetry = await writeBankOnlyPurchase(runtimePool, { bankTransactionId: bank.bankTransactionId, optIn: optIn(startAt), now: new Date(now) });
    assert.equal(bankRetry.status, 'REUSED');
    assert.equal(bankRetry.reasonCode, 'PREPAYMENT_BANK_FUNDING_ALREADY_ACCOUNTED');
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ledger_entries e
      JOIN ledger_postings p ON p.ledger_entry_id=e.id JOIN ledger_accounts a ON a.id=p.account_id
      WHERE a.account_code='UNCLASSIFIED_ACQUISITION' AND p.debit='100.00'
        AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss WHERE ss.scope_id=e.scope_id AND ss.superseded_ledger_entry_id=e.id)`)).rows[0].count, 1);
  });

  test('FNS-first lifecycle links a later bank event without creating bank-only expense', { concurrency: false }, async () => {
    await reset();
    const now = Date.now();
    const startAt = new Date(now - 5 * 60_000).toISOString();
    const [prepaymentReceipt] = await seedReceipts({
      prepaymentAt: new Date(now - 140_000).toISOString(),
      settlementAt: new Date(now - 40_000).toISOString(), order: 'same',
    });
    const [bank] = await seedBank({ occurredAt: new Date(now - 130_000).toISOString(), observedAt: new Date(now - 20_000).toISOString() });
    const catchup = await runAccountingCatchup(runtimePool, {
      scopeKey: 'default', logger: { info() {}, warn() {}, error() {} },
      bankOnlyPurchaseOptIn: optIn(startAt), prepaymentSettlementStartAt: startAt, now: new Date(now),
    });
    assert.equal(catchup.prepaymentBankFunding.persisted, 1);
    assert.equal(catchup.prepaymentBankFunding.superseded, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM business_events
      WHERE scope_id=(SELECT id FROM accounting_scopes WHERE scope_key='default')
        AND rule_code='BANK_ONLY_PURCHASE_V1'`)).rows[0].count, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ledger_entries e
      JOIN ledger_postings p ON p.ledger_entry_id=e.id JOIN ledger_accounts a ON a.id=p.account_id
      WHERE a.account_code='UNCLASSIFIED_ACQUISITION' AND p.debit='100.00'
        AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss WHERE ss.scope_id=e.scope_id AND ss.superseded_ledger_entry_id=e.id)`)).rows[0].count, 1);
    assert.ok(prepaymentReceipt.id > 0 && bank.bankTransactionId > 0);
  });

  test('historical-shaped 29211.66 lifecycle creates exactly one active expense from an empty ledger and survives replay', { concurrency: false }, async () => {
    await reset();
    const startAt = '2026-10-01T00:00:00.000Z';
    const now = new Date();
    await seedReceipts({ prepaymentAt: '2026-10-29T10:00:00.000Z', settlementAt: '2026-10-29T10:02:00.000Z', amount: 29211.66 });
    const [bank] = await seedBank({ occurredAt: '2026-10-29T10:00:30.000Z', observedAt: '2026-10-29T10:00:40.000Z', amount: '29211.66' });
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n, 0);
    const options = { scopeKey: 'default', logger: { info() {}, warn() {}, error() {} }, bankOnlyPurchaseOptIn: optIn(startAt), prepaymentSettlementStartAt: startAt, now };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runAccountingCatchup(runtimePool, options);
      const active = (await admin.query(`SELECT count(DISTINCT e.id)::int AS n, sum(p.debit)::text AS total
        FROM ledger_entries e JOIN ledger_postings p ON p.ledger_entry_id=e.id
        JOIN ledger_accounts a ON a.id=p.account_id
        WHERE a.account_code='UNCLASSIFIED_ACQUISITION'
        AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss WHERE ss.scope_id=e.scope_id AND ss.superseded_ledger_entry_id=e.id)`)).rows[0];
      assert.deepEqual(active, { n: 1, total: '29211.66' });
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM business_event_bank_evidence WHERE bank_transaction_id=$1 AND evidence_role=$2', [bank.bankTransactionId, PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE])).rows[0].n, 1);
    }
  });

  test('two exact same-time bank purchases stay ambiguous and standalone prepayment stays unlinked', { concurrency: false }, async () => {
    await reset();
    const now = Date.now();
    const startAt = new Date(now - 5 * 60_000).toISOString();
    const [prepaymentReceipt, settlementReceipt] = await seedReceipts({
      prepaymentAt: new Date(now - 140_000).toISOString(),
      settlementAt: new Date(now - 40_000).toISOString(), order: 'same',
    });
    const banks = await seedBank({ occurredAt: new Date(now - 130_000).toISOString(), observedAt: new Date(now - 20_000).toISOString(), count: 2 });
    const catchup = await runAccountingCatchup(runtimePool, {
      scopeKey: 'default', logger: { info() {}, warn() {}, error() {} },
      bankOnlyPurchaseOptIn: optIn(startAt), prepaymentSettlementStartAt: startAt, now: new Date(now),
    });
    assert.equal(catchup.prepaymentBankFunding.persisted, 0);
    assert.equal(catchup.prepaymentBankFunding.ambiguous, 1);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM business_event_bank_evidence
      WHERE evidence_role=$1`, [PREPAYMENT_BANK_FUNDING_EVIDENCE_ROLE])).rows[0].count, 0);
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM ledger_entries WHERE derivation_rule=$1', ['LEDGER_BANK_ONLY_PURCHASE_V1'])).rows[0].count, 0);
    assert.ok(prepaymentReceipt.id > 0 && settlementReceipt.id > 0 && banks.length === 2);
  });
}

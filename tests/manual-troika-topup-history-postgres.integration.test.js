import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createFinancialAccount, createPaymentInstrument } from '../src/bank-account-resolution.js';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { GRAPH_MODEL_VERSION } from '../src/business-event-graph.js';
import { certificationReport } from '../src/certification.js';
import { loadBankCashFlowProjection } from '../src/bank-cash-flow-projection.js';
import {
  SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED,
  attachTroikaTopupReceipt,
  confirmTroikaTopupExpense,
  confirmTroikaTopupExpenseAgainstExistingStandalone,
} from '../src/manual-troika-topup-expense.js';
import { standalonePurchaseCensus } from '../src/standalone-purchase.js';
import { assertDisposableLocalTestDatabase } from '../scripts/assert-disposable-local-test-database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDisposableLocalTestDatabase(databaseUrl);
const integration = databaseUrl ? test : test.skip;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

integration('legacy Troika history remains readable and disabled write APIs do not mutate it', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const seed = (await pool.query(`SELECT s.id AS scope_id,p.id AS person_id,e.id AS event_id,e.amount::text AS amount,
        e.currency,le.event_at,le.id AS original_ledger_id,ev.receipt_id,rf.normalization_version
      FROM accounting_scopes s
      JOIN persons p ON p.scope_id=s.id
      JOIN business_events e ON e.scope_id=s.id AND e.rule_code='STANDALONE_PURCHASE_V1'
      JOIN ledger_entries le ON le.scope_id=e.scope_id AND le.source_event_id=e.id
        AND le.derivation_rule='LEDGER_STANDALONE_PURCHASE_V1'
      JOIN business_event_evidence ev ON ev.event_id=e.id AND ev.receipt_id IS NOT NULL
      JOIN receipt_fiscal_facts rf ON rf.receipt_id=ev.receipt_id
      WHERE s.scope_key='default'
      ORDER BY p.id,e.id,le.id LIMIT 1`)).rows[0];
    assert.ok(seed, 'fixture must include one normalized FNS purchase to represent the old manual adoption case');

    const suffix = crypto.randomUUID().replaceAll('-', '');
    await pool.query(`INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id)
      SELECT $1,id,$2 FROM fns_sources WHERE scope_id=$3
      ON CONFLICT DO NOTHING`, [seed.receipt_id, `legacy-history-${suffix}`, seed.scope_id]);
    const provider = 'ru.alfabank.mobile.android';
    const account = await createFinancialAccount(pool, {
      scopeKey: 'default', institution: 'Synthetic Alfa', provider,
      displayName: `Synthetic legacy fixture ${suffix}`, currency: 'RUB',
    });
    const instrument = await createPaymentInstrument(pool, {
      scopeKey: 'default', financialAccountId: Number(account.id), instrumentType: 'CARD',
      provider, displayName: `Synthetic legacy card ${suffix}`,
    });
    const sourceKey = `legacy-troika-${suffix}`;
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic legacy history fixture' });
    await linkBankSourcePerson(pool, { sourceKey, personId: Number(seed.person_id) });
    const bankEvent = await ingestBankEvent(pool, {
      sourceKey, sourceEventId: `legacy-troika-event-${suffix}`,
      observedAt: new Date(seed.event_at).toISOString(), eventTime: new Date(seed.event_at).toISOString(),
      payload: {}, ingestionMetadata: { adapter: 'integration-test', provider, schemaVersion: '1' },
    });
    assert.equal(bankEvent.status, 'created');

    const rule = 'MANUAL_TROIKA_TOPUP_EXPENSE_V1';
    const version = 'v1';
    await pool.query(`INSERT INTO business_graph_rules(rule_code,rule_version,description)
      VALUES($1,$2,'Historical synthetic Troika compatibility fixture') ON CONFLICT DO NOTHING`, [rule, version]);
    const replacementLedgerId = Number((await pool.query(`INSERT INTO ledger_entries(
        scope_id,source_event_id,currency,event_at,semantic_key,derivation_rule,derivation_version,
        derivation_status,certification_status,origin,reason_code,description)
      VALUES($1,$2,'RUB',$3,$4,$5,$6,'READY','BUSINESS_CONFIRMED','MANUAL',
        'USER_CONFIRMED_TROIKA_TOPUP','Synthetic legacy Troika transport expense') RETURNING id`,
    [seed.scope_id, seed.event_id, seed.event_at, digest(`ledger:${suffix}`), rule, version])).rows[0].id);

    const bankAccount = Number((await pool.query(`INSERT INTO ledger_accounts(
        scope_id,account_code,account_type,description,financial_account_id,account_currency)
      VALUES($1,$2,'ASSET','Synthetic legacy Alfa account',$3,'RUB') RETURNING id`,
    [seed.scope_id, `FINANCIAL_ACCOUNT:${account.id}`, account.id])).rows[0].id);
    await pool.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description)
      VALUES($1,'EXPENSE:PUBLIC_TRANSPORT','EXPENSE','Public transport') ON CONFLICT(scope_id,account_code) DO NOTHING`, [seed.scope_id]);
    const transportAccount = Number((await pool.query(`SELECT id FROM ledger_accounts
      WHERE scope_id=$1 AND account_code='EXPENSE:PUBLIC_TRANSPORT' AND account_type='EXPENSE'`, [seed.scope_id])).rows[0].id);
    await pool.query(`INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit)
      VALUES($1,$2,'RUB',$3,0),($1,$4,'RUB',0,$3)`, [replacementLedgerId, transportAccount, seed.amount, bankAccount]);

    const expense = (await pool.query(`INSERT INTO manual_troika_topup_expenses(
        scope_id,bank_source_id,bank_transaction_id,business_event_id,ledger_entry_id,
        financial_account_id,payment_instrument_id,person_id,provider,category_code,amount,currency,
        occurred_at,provenance,evidence_basis,reason,semantic_key)
      VALUES($1,(SELECT id FROM bank_sources WHERE source_key=$2),$3,$4,$5,$6,$7,$8,$9,'PUBLIC_TRANSPORT',
        $10,'RUB',$11,'USER_CONFIRMED','BANK_DOCUMENT_AND_USER_CONFIRMATION',
        'Synthetic historical record for read-only regression',$12) RETURNING id`,
    [seed.scope_id, sourceKey, bankEvent.transactionId, seed.event_id, replacementLedgerId, account.id,
      instrument.id, seed.person_id, provider, seed.amount, seed.event_at, digest(`expense:${suffix}`)])).rows[0];

    const evidenceId = Number((await pool.query(`INSERT INTO business_event_evidence(
        event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key)
      VALUES($1,$2,$3,'MANUAL_TROIKA_TOPUP_RECEIPT','MANUAL',$4,$5,$6,$7) RETURNING id`,
    [seed.event_id, seed.receipt_id, seed.normalization_version, GRAPH_MODEL_VERSION, rule, version,
      digest(`evidence:${suffix}`)])).rows[0].id);
    await pool.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,link_role,semantic_key,bank_transaction_id)
      VALUES($1,$2,'MANUAL_TROIKA_TOPUP_BANK',$3,$4)`, [replacementLedgerId, seed.event_id, digest(`bank-link:${suffix}`), bankEvent.transactionId]);
    await pool.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,receipt_id,
        normalization_version,link_role,semantic_key)
      VALUES($1,$2,$3,$4,$5,'MANUAL_TROIKA_TOPUP_RECEIPT',$6)`,
    [replacementLedgerId, seed.event_id, evidenceId, seed.receipt_id, seed.normalization_version, digest(`receipt-link:${suffix}`)]);
    await pool.query(`INSERT INTO manual_troika_topup_receipt_links(
        scope_id,manual_troika_topup_expense_id,receipt_id,business_event_evidence_id,provenance,
        payment_stage,confirmation_basis,reason,semantic_key)
      VALUES($1,$2,$3,$4,'USER_CONFIRMED','SETTLEMENT_ONLY',
        'USER_CONFIRMED_SETTLEMENT_TOPUP_RECEIPT','Synthetic historical receipt link',$5)`,
    [seed.scope_id, expense.id, seed.receipt_id, evidenceId, digest(`manual-link:${suffix}`)]);
    await pool.query(`INSERT INTO ledger_entry_supersessions(
        scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,business_event_id,
        enrichment_key,semantic_key,reason_code)
      VALUES($1,$2,$3,$4,$5,$6,'USER_CONFIRMED_TROIKA_TOPUP_RECLASSIFICATION')`,
    [seed.scope_id, seed.original_ledger_id, replacementLedgerId, seed.event_id,
      digest(`enrichment:${suffix}`), digest(`supersession:${suffix}`)]);

    const counts = async () => (await pool.query(`SELECT
        (SELECT count(*)::int FROM manual_troika_topup_expenses WHERE id=$1) AS expense,
        (SELECT count(*)::int FROM manual_troika_topup_receipt_links WHERE manual_troika_topup_expense_id=$1) AS receipt_link,
        (SELECT count(*)::int FROM ledger_entries WHERE source_event_id=$2
          AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=ledger_entries.scope_id
            AND s.superseded_ledger_entry_id=ledger_entries.id)) AS active_entries,
        (SELECT count(*)::int FROM ledger_entry_supersessions WHERE replacement_ledger_entry_id=$3) AS supersessions`,
    [expense.id, seed.event_id, replacementLedgerId])).rows[0];
    const beforeReadOnlyCalls = await counts();
    assert.deepEqual(beforeReadOnlyCalls, { expense: 1, receipt_link: 1, active_entries: 1, supersessions: 1 });

    const report = await certificationReport(pool, { scopeKey: 'default' });
    const historicalFacts = report.proofFacts.filter((fact) => fact.ledgerEntryId === replacementLedgerId);
    assert.deepEqual(historicalFacts.map(({ metricCode, status, reasonCode }) => [metricCode, status, reasonCode]), [
      ['CONFIRMED_ACQUISITION_VALUE', 'CERTIFIED', 'USER_CONFIRMED_TROIKA_TOPUP'],
      ['ACQUISITION_CLASSIFICATION', 'CERTIFIED', 'PUBLIC_TRANSPORT'],
    ]);
    const census = await standalonePurchaseCensus(pool, { scopeKey: 'default' });
    assert.equal(census.buckets.find((bucket) => bucket.category === 'EXCLUDED_MANUAL_TROIKA_TOPUP')?.count, 1);
    const projection = await loadBankCashFlowProjection(pool, { scopeKey: 'default', bankTransactionIds: [bankEvent.transactionId] });
    assert.equal(projection.projections[0].reasonCode, 'MANUAL_TROIKA_TOPUP_ALREADY_ACCOUNTED');

    await assert.rejects(() => confirmTroikaTopupExpense(pool, {}), (error) => error.code === SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED);
    await assert.rejects(() => confirmTroikaTopupExpenseAgainstExistingStandalone(pool, {}), (error) => error.code === SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED);
    await assert.rejects(() => attachTroikaTopupReceipt(pool, {}), (error) => error.code === SPECIAL_TROIKA_TOPUP_EXPENSES_DISABLED);
    assert.deepEqual(await counts(), beforeReadOnlyCalls, 'read paths and disabled old writer APIs preserve the synthetic historical rows and single active expense');
  } finally {
    await pool.end();
  }
});

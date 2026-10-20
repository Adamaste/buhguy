import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { attachTroikaTopupReceipt, confirmTroikaTopupExpense, ALFA_PROVIDER } from '../src/manual-troika-topup-expense.js';
import { loadBankCashFlowProjection } from '../src/bank-cash-flow-projection.js';
import { createBankAccountReference, createFinancialAccount, createPaymentInstrument, relateFinancialAccountPerson, relatePaymentInstrumentPerson } from '../src/bank-account-resolution.js';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { FNS_RECEIPT_CURRENCY_MODEL_VERSION } from '../src/fns-receipt-currency.js';
import { persistMatchedPurchaseForTest } from '../src/matched-purchase-persistence.js';
import { dryRunPrepaymentSettlements, persistPrepaymentSettlementMatches } from '../src/prepayment-settlement-matcher.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';
import { assertDisposableLocalTestDatabase } from '../scripts/assert-disposable-local-test-database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDisposableLocalTestDatabase(databaseUrl);
const integration = databaseUrl ? test : test.skip;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const TEST_ROLE = 'receipt_collector';

async function createPrepaymentReceipt(admin, { fnsSourceId, fnsId, amount, occurredAt }) {
  const receipt = (await admin.query(`INSERT INTO receipts(fns_id,date_time,seller,seller_inn,total_sum,currency,operation_type)
    VALUES($1,$2,'Synthetic transit wallet','7700000000',$3,'RUB',1) RETURNING id`, [fnsId, occurredAt, amount])).rows[0];
  const receiptId = Number(receipt.id);
  await admin.query(`INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id)
    VALUES($1,$2,$3)`, [receiptId, fnsSourceId, `source-${fnsId}`]);
  const item = (await admin.query(`INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum)
    VALUES($1,0,'Synthetic transit wallet top-up',1,$2,$2) RETURNING id`, [receiptId, amount])).rows[0];
  await admin.query(`INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256)
    VALUES($1,'fiscal-normalizer-v1',1,$2)`, [item.id, digest(`item:${fnsId}`)]);
  await admin.query(`INSERT INTO receipt_fiscal_facts(
      receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,
      fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,
      prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,
      payment_components_status,payment_stage,correction_status)
    VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO',$4,'PRESENT_VALUE',
      '0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','PREPAYMENT_ONLY','NORMAL')`,
  [receiptId, digest(`source:${fnsId}`), digest(`normalized:${fnsId}`), amount]);
  return receiptId;
}

async function createSettlementReceipt(admin, { fnsSourceId, fnsId, amount, occurredAt }) {
  const receipt = (await admin.query(`INSERT INTO receipts(fns_id,date_time,seller,seller_inn,total_sum,currency,operation_type)
    VALUES($1,$2,'Synthetic transit wallet','7700000000',$3,'RUB',1) RETURNING id`, [fnsId, occurredAt, amount])).rows[0];
  const receiptId = Number(receipt.id);
  await admin.query(`INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id)
    VALUES($1,$2,$3)`, [receiptId, fnsSourceId, `source-${fnsId}`]);
  const item = (await admin.query(`INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum)
    VALUES($1,0,'Synthetic transit wallet top-up',1,$2,$2) RETURNING id`, [receiptId, amount])).rows[0];
  await admin.query(`INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256)
    VALUES($1,'fiscal-normalizer-v1',4,$2)`, [item.id, digest(`item:${fnsId}`)]);
  await admin.query(`INSERT INTO receipt_fiscal_facts(
      receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,
      fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,
      prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,
      payment_components_status,payment_stage,correction_status)
    VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO',
      $4,'PRESENT_VALUE','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','NORMAL')`,
  [receiptId, digest(`source:${fnsId}`), digest(`normalized:${fnsId}`), amount]);
  return receiptId;
}

integration('confirmed Troika top-ups create exactly two transport expenses totaling 55 RUB and later receipts only enrich them', { concurrency: false }, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  let runtime;
  let rolePrepared = false;
  const password = crypto.randomBytes(24).toString('hex');
  const suffix = `${process.pid}-${Date.now()}`;
  const sourceKey = `synthetic-troika-${suffix}`;
  const eventTimes = ['2026-10-20T09:48:00.000Z', '2026-10-20T10:20:00.000Z'];
  try {
    const role = await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='receipt_collector'");
    assert.equal(role.rowCount, 1, 'integration fixture must create receipt_collector before migrations');
    assert.equal(role.rows[0].rolcanlogin, false, 'runtime role starts without login before the isolated test');
    rolePrepared = true;
    await admin.query(`ALTER ROLE ${TEST_ROLE} LOGIN PASSWORD '${password}'`);
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = TEST_ROLE;
    runtimeUrl.password = password;
    runtime = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 4 });

    const person = (await admin.query(`SELECT p.id,p.scope_id FROM persons p
      JOIN accounting_scopes s ON s.id=p.scope_id WHERE s.scope_key='default' AND p.person_key='legacy-current-user'`)).rows[0];
    assert.ok(person, 'default synthetic owner must exist');
    const account = await createFinancialAccount(admin, {
      scopeKey: 'default', institution: 'Synthetic Alfa', provider: ALFA_PROVIDER,
      displayName: `Synthetic Alfa debit ${suffix}`, currency: 'RUB', active: true,
    });
    const instrument = await createPaymentInstrument(admin, {
      scopeKey: 'default', financialAccountId: Number(account.id), instrumentType: 'CARD',
      provider: ALFA_PROVIDER, displayName: `Synthetic Alfa card ****5580 ${suffix}`,
    });
    await relateFinancialAccountPerson(admin, {
      financialAccountId: Number(account.id), personId: Number(person.id), relationType: 'OWNER',
      provenance: 'SYNTHETIC_TEST', reason: 'Synthetic integration fixture only',
    });
    await relatePaymentInstrumentPerson(admin, {
      paymentInstrumentId: Number(instrument.id), personId: Number(person.id), relationType: 'OWNER',
      provenance: 'SYNTHETIC_TEST', reason: 'Synthetic integration fixture only',
    });
    await createBankAccountReference(admin, {
      paymentInstrumentId: Number(instrument.id), provider: ALFA_PROVIDER,
      referenceKind: 'MASKED_CARD', referenceValue: '****5580',
    });
    await createBankSource(admin, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic Alfa source' });
    await linkBankSourcePerson(admin, { sourceKey, personId: Number(person.id) });

    const transactions = [];
    for (const [index, amount] of ['21.00', '34.00'].entries()) {
      const event = await ingestBankEvent(admin, {
        sourceKey,
        sourceEventId: `synthetic-topup-${amount.replace('.', '-')}-${suffix}`,
        observedAt: new Date(Date.parse(eventTimes[index]) + 1000).toISOString(),
        eventTime: eventTimes[index],
        payload: {},
        ingestionMetadata: { adapter: 'integration-test', provider: ALFA_PROVIDER, deviceType: 'android', schemaVersion: '1' },
      });
      assert.equal(event.status, 'created');
      assert.equal(event.normalization.eventType, 'UNKNOWN');
      assert.equal(event.normalization.direction, 'UNKNOWN');
      assert.equal(event.normalization.amount, null);
      transactions.push({ id: event.transactionId, amount, occurredAt: eventTimes[index] });
    }

    const fnsSourceId = Number((await admin.query(`SELECT f.id FROM fns_sources f JOIN accounting_scopes s ON s.id=f.scope_id
      WHERE s.scope_key='default' AND f.source_key='legacy-default'`)).rows[0].id);
    const lifecyclePrepaymentId = await createPrepaymentReceipt(admin, {
      fnsSourceId, fnsId: `synthetic-lifecycle-prepayment-${suffix}`, amount: '21.00', occurredAt: eventTimes[0],
    });
    const lifecycleSettlementId = await createSettlementReceipt(admin, {
      fnsSourceId, fnsId: `synthetic-lifecycle-settlement-${suffix}`, amount: '21.00',
      occurredAt: new Date(Date.parse(eventTimes[0]) + 60_000).toISOString(),
    });
    const lifecycleDryRunBeforeManualExpense = await dryRunPrepaymentSettlements(admin, { scopeKey: 'default' });
    const staleLifecycleCandidate = lifecycleDryRunBeforeManualExpense.candidates.find((pair) =>
      Number(pair.prepaymentReceiptId) === lifecyclePrepaymentId && Number(pair.settlementReceiptId) === lifecycleSettlementId);
    assert.equal(staleLifecycleCandidate?.confirmed, true, 'synthetic pair is eligible before the manual top-up is recorded');

    const optionsFor = (tx, evidenceBasis) => ({
      bankTransactionId: Number(tx.id), financialAccountId: Number(account.id),
      paymentInstrumentId: Number(instrument.id), personId: Number(person.id), scopeKey: 'default',
      amount: tx.amount, evidenceBasis, reason: 'Synthetic user-confirmed Troika top-up',
    });
    const confirmed21 = await confirmTroikaTopupExpense(runtime, optionsFor(transactions[0], 'BANK_DOCUMENT_AND_USER_CONFIRMATION'));
    assert.equal(confirmed21.created, true);
    const replay21 = await confirmTroikaTopupExpense(runtime, optionsFor(transactions[0], 'BANK_DOCUMENT_AND_USER_CONFIRMATION'));
    assert.equal(replay21.reused, true);
    assert.equal(replay21.ledgerEntryId, confirmed21.ledgerEntryId);
    const receipt21Id = lifecyclePrepaymentId;
    const receipt21Reason = 'Synthetic explicit confirmation that this is the same Troika top-up';
    const receiptLink = await attachTroikaTopupReceipt(runtime, {
      bankTransactionId: Number(transactions[0].id), receiptId: receipt21Id,
      scopeKey: 'default', reason: receipt21Reason,
    });
    assert.equal(receiptLink.created, true);
    const staleLifecyclePersist = await persistPrepaymentSettlementMatches(admin, { scopeKey: 'default', result: lifecycleDryRunBeforeManualExpense });
    assert.equal(staleLifecyclePersist.created.purchases, 0);
    assert.deepEqual(staleLifecyclePersist.blockedManualTopupPairs, [{
      prepaymentReceiptId: lifecyclePrepaymentId,
      settlementReceiptId: lifecycleSettlementId,
      reason: 'RECEIPT_ALREADY_RECORDED_AS_MANUAL_TROIKA_EXPENSE',
    }]);

    const [confirmed34, replay34] = await Promise.all([
      confirmTroikaTopupExpense(runtime, optionsFor(transactions[1], 'USER_CONFIRMATION')),
      confirmTroikaTopupExpense(runtime, optionsFor(transactions[1], 'USER_CONFIRMATION')),
    ]);
    assert.equal([confirmed34.created, replay34.created].filter(Boolean).length, 1);
    assert.equal([confirmed34.reused, replay34.reused].filter(Boolean).length, 1);
    assert.equal(confirmed34.ledgerEntryId, replay34.ledgerEntryId);

    const confirmations = (await admin.query(`SELECT bank_transaction_id,amount::text,financial_account_id,payment_instrument_id,
        person_id,provenance,evidence_basis,currency,category_code
      FROM manual_troika_topup_expenses WHERE bank_transaction_id=ANY($1::bigint[]) ORDER BY amount`, [transactions.map((tx) => tx.id)])).rows;
    assert.deepEqual(confirmations.map((row) => [row.amount, Number(row.financial_account_id), Number(row.payment_instrument_id), Number(row.person_id), row.provenance, row.evidence_basis, row.currency, row.category_code]), [
      ['21.00', Number(account.id), Number(instrument.id), Number(person.id), 'USER_CONFIRMED', 'BANK_DOCUMENT_AND_USER_CONFIRMATION', 'RUB', 'PUBLIC_TRANSPORT'],
      ['34.00', Number(account.id), Number(instrument.id), Number(person.id), 'USER_CONFIRMED', 'USER_CONFIRMATION', 'RUB', 'PUBLIC_TRANSPORT'],
    ]);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ledger_entries
      WHERE id=ANY($1::bigint[]) AND origin='MANUAL' AND derivation_rule='MANUAL_TROIKA_TOPUP_EXPENSE_V1'`, [[confirmed21.ledgerEntryId, confirmed34.ledgerEntryId]])).rows[0].count, 2);
    assert.deepEqual((await admin.query(`SELECT count(*)::int AS entry_count,
        sum(p.debit) FILTER (WHERE a.account_code='EXPENSE:PUBLIC_TRANSPORT')::numeric(18,2)::text AS expense_total,
        sum(p.credit) FILTER (WHERE a.account_code=$2)::numeric(18,2)::text AS bank_total
      FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
      WHERE p.ledger_entry_id=ANY($1::bigint[])`, [[confirmed21.ledgerEntryId, confirmed34.ledgerEntryId], `FINANCIAL_ACCOUNT:${account.id}`])).rows[0], {
      entry_count: 4, expense_total: '55.00', bank_total: '55.00',
    });
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE bank_transaction_id=ANY($1::bigint[])', [transactions.map((tx) => tx.id)])).rows[0].count, 0);

    const unrelatedReceiptId = await createPrepaymentReceipt(admin, {
      fnsSourceId, fnsId: `synthetic-unrelated-prepayment-${suffix}`, amount: '21.00', occurredAt: eventTimes[0],
    });
    const reusedReceiptLink = await attachTroikaTopupReceipt(runtime, {
      bankTransactionId: Number(transactions[0].id), receiptId: receipt21Id,
      scopeKey: 'default', reason: receipt21Reason,
    });
    assert.equal(reusedReceiptLink.reused, true);
    const replayReceiptLink = await attachTroikaTopupReceipt(runtime, {
      bankTransactionId: Number(transactions[0].id), receiptId: receipt21Id,
      scopeKey: 'default', reason: receipt21Reason,
    });
    assert.equal(replayReceiptLink.reused, true);
    await assert.rejects(() => attachTroikaTopupReceipt(runtime, {
      bankTransactionId: Number(transactions[1].id), receiptId: unrelatedReceiptId,
      scopeKey: 'default', reason: 'Synthetic mismatched receipt must fail closed',
    }), (error) => error.code === 'RECEIPT_NOT_EXACT_CONFIRMED_PREPAYMENT');

    const standalone = await persistStandalonePurchases(admin, { scopeKey: 'default', receiptIds: [receipt21Id, unrelatedReceiptId] });
    assert.equal(standalone.candidates, 0, 'linked and unrelated PREPAYMENT_ONLY receipts must not become ordinary standalone expenses');
    assert.equal(standalone.created, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM manual_troika_topup_receipt_links
      WHERE receipt_id=$1 AND manual_troika_topup_expense_id=(SELECT id FROM manual_troika_topup_expenses WHERE bank_transaction_id=$2)`, [receipt21Id, transactions[0].id])).rows[0].count, 1);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM business_event_evidence
      WHERE event_id=$1 AND receipt_id=$2 AND evidence_role='MANUAL_TROIKA_TOPUP_RECEIPT'`, [confirmed21.businessEventId, receipt21Id])).rows[0].count, 1);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ledger_entries
      WHERE id=ANY($1::bigint[]) AND derivation_rule='MANUAL_TROIKA_TOPUP_EXPENSE_V1'`, [[confirmed21.ledgerEntryId, confirmed34.ledgerEntryId]])).rows[0].count, 2,
    'receipt arrival must not create a second expense');
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM manual_troika_topup_receipt_links
      WHERE manual_troika_topup_expense_id=(SELECT id FROM manual_troika_topup_expenses WHERE bank_transaction_id=$1)`, [transactions[1].id])).rows[0].count, 0,
    'the 34 RUB event has no receipt attached');

    await admin.query(`UPDATE bank_transactions SET amount=$2,currency='RUB',direction='DEBIT',event_type='PURCHASE',
        normalization_status='READY',normalization_version='synthetic-alfa-v2',evidence_quality='EXACT'
      WHERE id=$1`, [transactions[0].id, '21.00']);
    await admin.query(`UPDATE bank_transactions SET amount=$2,currency='RUB',direction='DEBIT',event_type='PURCHASE',
        normalization_status='READY',normalization_version='synthetic-alfa-v2',evidence_quality='EXACT'
      WHERE id=$1`, [transactions[1].id, '34.00']);
    const projection = await loadBankCashFlowProjection(admin, { scopeKey: 'default' });
    const projectedById = new Map(projection.projections.map((row) => [Number(row.bankTransactionId), row]));
    for (const tx of transactions) assert.equal(projectedById.get(Number(tx.id)).reasonCode, 'MANUAL_TROIKA_TOPUP_ALREADY_ACCOUNTED');

    const match = {
      scopeKey: 'default', matchKey: digest(`match:${suffix}`), amount: '21.00', currency: 'RUB',
      receiptCurrencyResolution: {
        modelVersion: FNS_RECEIPT_CURRENCY_MODEL_VERSION, sourceFamily: 'FNS_FISCAL_RECEIPT',
        status: 'RESOLVED', currency: 'RUB', basis: 'EXPLICIT_PAYLOAD', reasonCode: 'EXPLICIT_CURRENCY',
      },
      bank: {
        ledgerKey: digest(`bank-ledger:${suffix}`), candidateKey: digest(`bank-candidate:${suffix}`),
        journalKey: digest(`bank-journal:${suffix}`), bankTransactionId: Number(transactions[0].id),
        financialAccountId: Number(account.id), occurredAt: eventTimes[0],
      },
      receipt: {
        receiptCandidateKey: digest(`receipt-candidate:${suffix}`), receiptId: receipt21Id,
        normalizationVersion: 'fiscal-normalizer-v1', normalizedContentSha256: digest(`receipt-content:${suffix}`),
        dateTime: eventTimes[0],
      },
    };
    await assert.rejects(() => persistMatchedPurchaseForTest(runtime, {
      scopeKey: 'default', matchingLoader: async () => ({ matches: [match] }),
    }), (error) => error.code === 'BANK_TRANSACTION_ALREADY_MANUALLY_ACCOUNTED');

    await admin.query(await readFile(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
    const certifiedSpend = (await admin.query(`WITH latest AS (
        SELECT id FROM reconciliation_runs WHERE scope_id=$1 AND model_version='reconciliation-certification-v1'
          AND period_from IS NULL AND period_to IS NULL AND status='READY' ORDER BY id DESC LIMIT 1)
      SELECT count(DISTINCT purchase_id)::int AS purchases, sum(DISTINCT amount)::numeric(18,2)::text AS total
      FROM canonical_spending_purchases_v1 p JOIN latest l ON l.id=p.certification_run_id
      WHERE p.rule_code='MANUAL_TROIKA_TOPUP_EXPENSE_V1' AND p.purchase_id=ANY($2::bigint[])`,
    [Number(person.scope_id), [confirmed21.businessEventId, confirmed34.businessEventId]])).rows[0];
    assert.deepEqual(certifiedSpend, { purchases: 2, total: '55.00' });

    const untouchedNormalizations = (await admin.query(`SELECT count(*)::int AS count FROM bank_transactions
      WHERE id=ANY($1::bigint[]) AND event_type='PURCHASE' AND direction='DEBIT'
        AND normalization_status='READY' AND evidence_quality='EXACT' AND normalization_version='synthetic-alfa-v2'`,
    [transactions.map((tx) => tx.id)])).rows[0].count;
    assert.equal(Number(untouchedNormalizations), 2, 'the manual confirmation path does not overwrite later bank normalization');
    const writePrivileges = (await admin.query(`SELECT
      has_table_privilege($1,'public.manual_troika_topup_expenses','INSERT') AS expense_table_insert,
      has_any_column_privilege($1,'public.manual_troika_topup_expenses','INSERT') AS expense_column_insert,
      has_table_privilege($1,'public.manual_troika_topup_expenses','UPDATE') OR has_any_column_privilege($1,'public.manual_troika_topup_expenses','UPDATE') AS expense_update,
      has_table_privilege($1,'public.manual_troika_topup_expenses','DELETE') AS expense_delete,
      has_table_privilege($1,'public.manual_troika_topup_receipt_links','INSERT') AS receipt_link_table_insert,
      has_any_column_privilege($1,'public.manual_troika_topup_receipt_links','INSERT') AS receipt_link_column_insert,
      has_table_privilege($1,'public.manual_troika_topup_receipt_links','UPDATE') OR has_any_column_privilege($1,'public.manual_troika_topup_receipt_links','UPDATE') AS receipt_link_update,
      has_table_privilege($1,'public.manual_troika_topup_receipt_links','DELETE') AS receipt_link_delete`, [TEST_ROLE])).rows[0];
    assert.deepEqual(writePrivileges, {
      expense_table_insert: false, expense_column_insert: true, expense_update: false, expense_delete: false,
      receipt_link_table_insert: false, receipt_link_column_insert: true, receipt_link_update: false, receipt_link_delete: false,
    });
    const ruleLookupPrivileges = (await admin.query(`SELECT
      has_column_privilege($1,'public.business_graph_rules','rule_code','SELECT') AS rule_code,
      has_column_privilege($1,'public.business_graph_rules','rule_version','SELECT') AS rule_version,
      has_column_privilege($1,'public.business_graph_rules','description','SELECT') AS description,
      has_table_privilege($1,'public.business_graph_rules','UPDATE') AS update_allowed,
      has_table_privilege($1,'public.business_graph_rules','DELETE') AS delete_allowed`, [TEST_ROLE])).rows[0];
    assert.deepEqual(ruleLookupPrivileges, {
      rule_code: true, rule_version: true, description: false,
      update_allowed: false, delete_allowed: false,
    });
  } finally {
    if (runtime) await runtime.end();
    if (rolePrepared) {
      await admin.query(`DROP OWNED BY ${TEST_ROLE}`);
      await admin.query(`DROP ROLE ${TEST_ROLE}`);
    }
    await admin.end();
  }
});

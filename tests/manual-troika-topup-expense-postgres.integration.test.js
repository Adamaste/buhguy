import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { attachTroikaTopupReceipt, confirmTroikaTopupExpense, confirmTroikaTopupExpenseAgainstExistingStandalone, ALFA_PROVIDER } from '../src/manual-troika-topup-expense.js';
import { createBankAccountReference, createFinancialAccount, createPaymentInstrument, relateFinancialAccountPerson, relatePaymentInstrumentPerson } from '../src/bank-account-resolution.js';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { refreshLedgerForReceipt } from '../src/ledger.js';
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

async function createPrepaymentReceipt(admin, { fnsSourceId, fnsId, amount, occurredAt, sellerInn = '7700000000' }) {
  const receipt = (await admin.query(`INSERT INTO receipts(fns_id,date_time,seller,seller_inn,total_sum,currency,operation_type)
    VALUES($1,$2,'Synthetic transit wallet',$3,$4,'RUB',1) RETURNING id`, [fnsId, occurredAt, sellerInn, amount])).rows[0];
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

async function createSettlementReceipt(admin, { fnsSourceId, fnsId, amount, occurredAt, sellerInn = '7700000000' }) {
  const receipt = (await admin.query(`INSERT INTO receipts(fns_id,date_time,seller,seller_inn,total_sum,currency,operation_type)
    VALUES($1,$2,'Synthetic transit wallet',$3,$4,'RUB',1) RETURNING id`, [fnsId, occurredAt, sellerInn, amount])).rows[0];
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

async function createStandaloneEligibleSettlementReceipt(admin, { fnsSourceId, fnsId, amount, occurredAt, sellerInn = '7700000001' }) {
  const receipt = (await admin.query(`INSERT INTO receipts(fns_id,date_time,seller,seller_inn,total_sum,currency,operation_type)
    VALUES($1,$2,'Synthetic ordinary merchant',$3,$4,'RUB',1) RETURNING id`, [fnsId, occurredAt, sellerInn, amount])).rows[0];
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
      '0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','NORMAL')`,
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
      referenceKind: 'MASKED_CARD', referenceValue: '5580',
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
      assert.equal(event.normalization.currency, null);
      assert.equal(event.normalization.normalizationStatus, 'PARTIAL');
      assert.equal(event.normalization.evidenceQuality, 'PARTIAL');
      transactions.push({ id: event.transactionId, amount, occurredAt: eventTimes[index] });
    }

    const fnsSourceId = Number((await admin.query(`SELECT f.id FROM fns_sources f JOIN accounting_scopes s ON s.id=f.scope_id
      WHERE s.scope_key='default' AND f.source_key='legacy-default'`)).rows[0].id);
    const lifecyclePrepaymentId = await createPrepaymentReceipt(admin, {
      fnsSourceId, fnsId: `synthetic-lifecycle-prepayment-${suffix}`, amount: '21.00', occurredAt: eventTimes[0], sellerInn: '7710000001',
    });
    const lifecycleSettlementId = await createSettlementReceipt(admin, {
      fnsSourceId, fnsId: `synthetic-lifecycle-settlement-${suffix}`, amount: '21.00',
      occurredAt: new Date(Date.parse(eventTimes[0]) + 60_000).toISOString(), sellerInn: '7710000001',
    });
    const receipt34Id = await createStandaloneEligibleSettlementReceipt(admin, {
      fnsSourceId, fnsId: `synthetic-standalone-settlement-34-${suffix}`, amount: '34.00', occurredAt: eventTimes[1],
      sellerInn: '7710000002',
    });
    const existingStandalone34 = await persistStandalonePurchases(admin, {
      scopeKey: 'default', receiptIds: [receipt34Id],
      ledgerRefresher: (id) => refreshLedgerForReceipt(admin, { scopeKey: 'default', receiptId: id }),
    });
    assert.equal(existingStandalone34.created, 1, 'the 34 RUB receipt starts as an existing FNS standalone purchase');
    assert.equal(existingStandalone34.propagation.ledger, 1);
    const standalone34 = (await admin.query(`SELECT ev.event_id AS business_event_id,le.id AS ledger_entry_id,
        ev.origin,ev.rule_code,ev.rule_version,le.origin AS ledger_origin,le.derivation_rule,le.derivation_status
      FROM business_event_evidence ev JOIN business_events be ON be.id=ev.event_id
      JOIN ledger_entries le ON le.source_event_id=be.id
      WHERE ev.receipt_id=$1 AND ev.evidence_role='PURCHASE_EVIDENCE'`, [receipt34Id])).rows[0];
    assert.ok(standalone34);
    assert.equal(standalone34.origin, 'SYSTEM_DERIVED');
    assert.equal(standalone34.rule_code, 'STANDALONE_PURCHASE_V1');
    assert.equal(standalone34.rule_version, 'standalone-purchase-v1');
    assert.equal(standalone34.ledger_origin, 'SYSTEM_DERIVED');
    assert.equal(standalone34.derivation_rule, 'LEDGER_STANDALONE_PURCHASE_V1');
    assert.equal(standalone34.derivation_status, 'READY');
    const lifecycleDryRunBeforeManualExpense = await dryRunPrepaymentSettlements(admin, { scopeKey: 'default' });
    const staleLifecycleCandidate = lifecycleDryRunBeforeManualExpense.candidates.find((pair) =>
      Number(pair.prepaymentReceiptId) === lifecyclePrepaymentId && Number(pair.settlementReceiptId) === lifecycleSettlementId);
    assert.equal(staleLifecycleCandidate?.confirmed, true, 'the separate strict lifecycle pair is eligible before manual expense is recorded');
    assert.equal(lifecycleDryRunBeforeManualExpense.candidates.some((pair) =>
      Number(pair.settlementReceiptId) === receipt34Id && pair.confirmed === true), false,
    'the ordinary standalone SETTLEMENT_ONLY receipt is not guessed to be a top-up from amount and time alone');

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
    const receipt21Reason = 'Synthetic explicit confirmation that this exact receipt is the same Troika top-up';
    const receipt21Options = {
      bankTransactionId: Number(transactions[0].id), receiptId: receipt21Id,
      scopeKey: 'default', reason: receipt21Reason, userConfirmedReceiptForTopup: true,
    };
    const sameAmountNearbyReceiptId = await createStandaloneEligibleSettlementReceipt(admin, {
      fnsSourceId, fnsId: `synthetic-unrelated-same-amount-nearby-${suffix}`, amount: '21.00',
      occurredAt: new Date(Date.parse(eventTimes[0]) + 10_000).toISOString(),
    });
    const unrelatedStandalone = await persistStandalonePurchases(admin, { scopeKey: 'default', receiptIds: [sameAmountNearbyReceiptId] });
    assert.equal(unrelatedStandalone.created, 1, 'ordinary unrelated settlement keeps existing standalone behavior');
    await assert.rejects(() => attachTroikaTopupReceipt(runtime, {
      bankTransactionId: Number(transactions[0].id), receiptId: sameAmountNearbyReceiptId,
      scopeKey: 'default', reason: 'Synthetic proximity is not proof',
    }), (error) => error.code === 'TOPUP_RECEIPT_USER_CONFIRMATION_REQUIRED');
    await assert.rejects(() => attachTroikaTopupReceipt(runtime, {
      ...receipt21Options, receiptId: sameAmountNearbyReceiptId,
      settlementOnlyConfirmation: { purpose: 'TROIKA_TOPUP', belongsToSpecificTopup: true },
    }), (error) => error.code === 'RECEIPT_ALREADY_ACCOUNTED');

    const [receiptLink, receiptLinkReplay] = await Promise.all([
      attachTroikaTopupReceipt(runtime, receipt21Options),
      attachTroikaTopupReceipt(runtime, receipt21Options),
    ]);
    assert.equal([receiptLink.created, receiptLinkReplay.created].filter(Boolean).length, 1);
    assert.equal([receiptLink.reused, receiptLinkReplay.reused].filter(Boolean).length, 1);
    assert.equal(receiptLink.paymentStage, 'PREPAYMENT_ONLY');
    assert.equal(receiptLinkReplay.ledgerEntryId, receiptLink.ledgerEntryId);

    const receipt34Reason = 'Synthetic explicit confirmation that this exact FNS receipt is the confirmed Troika top-up';
    const adoption34Options = {
      ...optionsFor(transactions[1], 'USER_CONFIRMATION'), receiptId: receipt34Id, reason: receipt34Reason,
      businessEventId: Number(standalone34.business_event_id),
      standaloneLedgerEntryId: Number(standalone34.ledger_entry_id),
      userConfirmedReceiptForTopup: true,
      settlementOnlyConfirmation: { purpose: 'TROIKA_TOPUP', belongsToSpecificTopup: true },
    };
    await assert.rejects(() => confirmTroikaTopupExpenseAgainstExistingStandalone(runtime, {
      ...adoption34Options, userConfirmedReceiptForTopup: false,
    }), (error) => error.code === 'TOPUP_RECEIPT_USER_CONFIRMATION_REQUIRED');
    await assert.rejects(() => confirmTroikaTopupExpenseAgainstExistingStandalone(runtime, {
      ...adoption34Options, settlementOnlyConfirmation: undefined,
    }), (error) => error.code === 'SETTLEMENT_PURPOSE_CONFIRMATION_REQUIRED');
    await assert.rejects(() => confirmTroikaTopupExpenseAgainstExistingStandalone(runtime, {
      ...adoption34Options, settlementOnlyConfirmation: { purpose: 'TROIKA_TOPUP' },
    }), (error) => error.code === 'SETTLEMENT_TOPUP_LINK_CONFIRMATION_REQUIRED');
    const [confirmed34, replay34] = await Promise.all([
      confirmTroikaTopupExpenseAgainstExistingStandalone(runtime, adoption34Options),
      confirmTroikaTopupExpenseAgainstExistingStandalone(runtime, adoption34Options),
    ]);
    assert.equal([confirmed34.created, replay34.created].filter(Boolean).length, 1);
    assert.equal([confirmed34.reused, replay34.reused].filter(Boolean).length, 1);
    assert.equal(confirmed34.ledgerEntryId, replay34.ledgerEntryId);
    assert.equal(confirmed34.businessEventId, Number(standalone34.business_event_id), 'adoption reuses the existing FNS event');
    assert.equal(confirmed34.supersededLedgerEntryId, Number(standalone34.ledger_entry_id));

    await assert.rejects(() => confirmTroikaTopupExpenseAgainstExistingStandalone(runtime, {
      ...adoption34Options, receiptId: receipt21Id,
    }), (error) => error.code === 'RECEIPT_NOT_EXACT_CONFIRMED_TOPUP');

    const staleLifecyclePersist = await persistPrepaymentSettlementMatches(admin, { scopeKey: 'default', result: lifecycleDryRunBeforeManualExpense });
    assert.equal(staleLifecyclePersist.created.purchases, 0);
    assert.deepEqual(staleLifecyclePersist.blockedManualTopupPairs.map((pair) => [pair.prepaymentReceiptId, pair.settlementReceiptId]).sort((a, b) => a[0] - b[0]), [
      [lifecyclePrepaymentId, lifecycleSettlementId],
    ].sort((a, b) => a[0] - b[0]));

    const confirmations = (await admin.query(`SELECT bank_transaction_id,amount::text,financial_account_id,payment_instrument_id,
        person_id,provenance,evidence_basis,currency,category_code
      FROM manual_troika_topup_expenses WHERE bank_transaction_id=ANY($1::bigint[]) ORDER BY amount`, [transactions.map((tx) => tx.id)])).rows;
    assert.deepEqual(confirmations.map((row) => [row.amount, Number(row.financial_account_id), Number(row.payment_instrument_id), Number(row.person_id), row.provenance, row.evidence_basis, row.currency, row.category_code]), [
      ['21.00', Number(account.id), Number(instrument.id), Number(person.id), 'USER_CONFIRMED', 'BANK_DOCUMENT_AND_USER_CONFIRMATION', 'RUB', 'PUBLIC_TRANSPORT'],
      ['34.00', Number(account.id), Number(instrument.id), Number(person.id), 'USER_CONFIRMED', 'USER_CONFIRMATION', 'RUB', 'PUBLIC_TRANSPORT'],
    ]);
    const linkedReceipts = (await admin.query(`SELECT link.receipt_id,link.payment_stage,link.confirmation_basis,link.provenance
      FROM manual_troika_topup_receipt_links link ORDER BY link.payment_stage`)).rows;
    assert.deepEqual(linkedReceipts.map((row) => [Number(row.receipt_id), row.payment_stage, row.confirmation_basis, row.provenance]), [
      [receipt21Id, 'PREPAYMENT_ONLY', 'USER_CONFIRMED_PREPAYMENT_TOPUP_RECEIPT', 'USER_CONFIRMED'],
      [receipt34Id, 'SETTLEMENT_ONLY', 'USER_CONFIRMED_SETTLEMENT_TOPUP_RECEIPT', 'USER_CONFIRMED'],
    ].sort((a, b) => a[1].localeCompare(b[1])));
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
      scopeKey: 'default', reason: receipt21Reason, userConfirmedReceiptForTopup: true,
    });
    assert.equal(reusedReceiptLink.reused, true);
    const replayReceiptLink = await attachTroikaTopupReceipt(runtime, {
      bankTransactionId: Number(transactions[0].id), receiptId: receipt21Id,
      scopeKey: 'default', reason: receipt21Reason, userConfirmedReceiptForTopup: true,
    });
    assert.equal(replayReceiptLink.reused, true);
    const replaySettlementLink = await confirmTroikaTopupExpenseAgainstExistingStandalone(runtime, adoption34Options);
    assert.equal(replaySettlementLink.reused, true);
    await assert.rejects(() => attachTroikaTopupReceipt(runtime, {
      bankTransactionId: Number(transactions[0].id), receiptId: receipt34Id,
      scopeKey: 'default', reason: 'Attempt to reuse the exact receipt on a second top-up', userConfirmedReceiptForTopup: true,
      settlementOnlyConfirmation: { purpose: 'TROIKA_TOPUP', belongsToSpecificTopup: true },
    }), (error) => error.code === 'RECEIPT_ALREADY_MANUALLY_LINKED');
    await assert.rejects(() => attachTroikaTopupReceipt(runtime, {
      bankTransactionId: Number(transactions[1].id), receiptId: unrelatedReceiptId,
      scopeKey: 'default', reason: 'Synthetic mismatched receipt must fail closed', userConfirmedReceiptForTopup: true,
    }), (error) => error.code === 'MANUAL_TOPUP_LEDGER_CONFLICT');

    const standalone = await persistStandalonePurchases(admin, { scopeKey: 'default', receiptIds: [receipt21Id, receipt34Id, unrelatedReceiptId] });
    assert.equal(standalone.candidates, 0, 'manually linked receipts and unrelated prepayments must not become standalone expenses');
    assert.equal(standalone.created, 0);
    assert.equal(standalone.blockedManualTroikaTopups, 0, 'preselection excludes manually linked receipts; persistCandidate also has an atomic race guard');
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM manual_troika_topup_receipt_links
      WHERE receipt_id=$1 AND manual_troika_topup_expense_id=(SELECT id FROM manual_troika_topup_expenses WHERE bank_transaction_id=$2)`, [receipt21Id, transactions[0].id])).rows[0].count, 1);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM business_event_evidence
      WHERE event_id=$1 AND receipt_id=$2 AND evidence_role='MANUAL_TROIKA_TOPUP_RECEIPT'`, [confirmed21.businessEventId, receipt21Id])).rows[0].count, 1);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ledger_entries
      WHERE id=ANY($1::bigint[]) AND derivation_rule='MANUAL_TROIKA_TOPUP_EXPENSE_V1'`, [[confirmed21.ledgerEntryId, confirmed34.ledgerEntryId]])).rows[0].count, 2,
    'receipt arrival must not create a second expense');
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM manual_troika_topup_receipt_links
      WHERE manual_troika_topup_expense_id=(SELECT id FROM manual_troika_topup_expenses WHERE bank_transaction_id=$1)`, [transactions[1].id])).rows[0].count, 1,
    'the SETTLEMENT_ONLY receipt is attached as evidence to the existing 34 RUB expense');
    const primaryNormalization = (await admin.query(`SELECT count(*)::int AS count FROM bank_transactions
      WHERE id=ANY($1::bigint[]) AND event_type='UNKNOWN' AND direction='UNKNOWN' AND amount IS NULL AND currency IS NULL
        AND normalization_status='PARTIAL' AND evidence_quality='PARTIAL'`, [transactions.map((tx) => tx.id)])).rows[0].count;
    assert.equal(primaryNormalization, 2, 'manual accounting preserves the real UNKNOWN/PARTIAL bank records');
    const reprocessedStandalone = await persistStandalonePurchases(admin, { scopeKey: 'default', receiptIds: [receipt34Id] });
    assert.equal(reprocessedStandalone.created, 0, 'reimporting the FNS receipt cannot create another purchase event');
    assert.equal(reprocessedStandalone.candidates, 0);
    const refreshedStandalone = await refreshLedgerForReceipt(admin, { scopeKey: 'default', receiptId: receipt34Id });
    assert.equal(refreshedStandalone.changed, false, 'ledger refresh cannot resurrect the superseded FNS standalone posting');
    assert.equal(refreshedStandalone.created.entries, 0);
    const ledgerHistory34 = (await admin.query(`SELECT e.id,e.origin,e.derivation_rule,
        EXISTS(SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id) AS superseded
      FROM ledger_entries e WHERE e.source_event_id=$1 ORDER BY e.id`, [standalone34.business_event_id])).rows;
    assert.equal(ledgerHistory34.length, 2, 'the original FNS ledger history is preserved as a superseded predecessor');
    assert.equal(ledgerHistory34.filter((entry) => entry.superseded).length, 1);
    assert.equal(ledgerHistory34.filter((entry) => entry.origin === 'MANUAL' && !entry.superseded).length, 1);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM business_events WHERE id=$1`, [standalone34.business_event_id])).rows[0].count, 1,
      'the FNS standalone business event is reused rather than duplicated');
    const activeExpenseSummary = (await admin.query(`SELECT count(DISTINCT e.source_event_id)::int AS expense_events,
        count(DISTINCT e.id)::int AS active_entries,
        sum(p.debit) FILTER (WHERE a.account_code='EXPENSE:PUBLIC_TRANSPORT')::numeric(18,2)::text AS transport_total
      FROM ledger_entries e JOIN ledger_postings p ON p.ledger_entry_id=e.id JOIN ledger_accounts a ON a.id=p.account_id
      WHERE e.id=ANY($1::bigint[])
        AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)`,
    [[confirmed21.ledgerEntryId, confirmed34.ledgerEntryId]])).rows[0];
    assert.deepEqual(activeExpenseSummary, { expense_events: 2, active_entries: 2, transport_total: '55.00' });

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

    const competingEvent = await ingestBankEvent(admin, {
      sourceKey, sourceEventId: `synthetic-competing-bank-event-${suffix}`,
      observedAt: new Date(Date.parse(eventTimes[1]) + 2_000).toISOString(), eventTime: eventTimes[1], payload: {},
      ingestionMetadata: { adapter: 'integration-test', provider: ALFA_PROVIDER, deviceType: 'android', schemaVersion: '1' },
    });
    await admin.query(`UPDATE bank_transactions SET amount='34.00',currency='RUB',direction='DEBIT',event_type='PURCHASE',
        normalization_status='READY',normalization_version='synthetic-alfa-v2',evidence_quality='EXACT'
      WHERE id=$1`, [competingEvent.transactionId]);
    const competingMatch = {
      ...match, matchKey: digest(`competing-match:${suffix}`), amount: '34.00',
      bank: { ...match.bank, bankTransactionId: competingEvent.transactionId, occurredAt: eventTimes[1] },
      receipt: { ...match.receipt, receiptId: receipt34Id, dateTime: new Date(Date.parse(eventTimes[1]) + 60_000).toISOString() },
    };
    await assert.rejects(() => persistMatchedPurchaseForTest(runtime, {
      scopeKey: 'default', matchingLoader: async () => ({ matches: [competingMatch] }),
    }), (error) => error.code === 'RECEIPT_ALREADY_MANUALLY_LINKED_TO_TROIKA_TOPUP');

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
      WHERE id=ANY($1::bigint[]) AND event_type='UNKNOWN' AND direction='UNKNOWN' AND amount IS NULL AND currency IS NULL
        AND normalization_status='PARTIAL' AND evidence_quality='PARTIAL'`,
    [transactions.map((tx) => tx.id)])).rows[0].count;
    assert.equal(Number(untouchedNormalizations), 2, 'the manual confirmation path does not promote uncertain bank normalization to EXACT');
    const writePrivileges = (await admin.query(`SELECT
      has_table_privilege($1,'public.manual_troika_topup_expenses','INSERT') AS expense_table_insert,
      has_any_column_privilege($1,'public.manual_troika_topup_expenses','INSERT') AS expense_column_insert,
      has_table_privilege($1,'public.manual_troika_topup_expenses','UPDATE') OR has_any_column_privilege($1,'public.manual_troika_topup_expenses','UPDATE') AS expense_update,
      has_table_privilege($1,'public.manual_troika_topup_expenses','DELETE') AS expense_delete,
      has_table_privilege($1,'public.manual_troika_topup_receipt_links','INSERT') AS receipt_link_table_insert,
      has_any_column_privilege($1,'public.manual_troika_topup_receipt_links','INSERT') AS receipt_link_column_insert,
      has_column_privilege($1,'public.manual_troika_topup_receipt_links','payment_stage','INSERT') AS receipt_link_stage_insert,
      has_column_privilege($1,'public.manual_troika_topup_receipt_links','confirmation_basis','INSERT') AS receipt_link_confirmation_insert,
      has_table_privilege($1,'public.manual_troika_topup_receipt_links','UPDATE') OR has_any_column_privilege($1,'public.manual_troika_topup_receipt_links','UPDATE') AS receipt_link_update,
      has_table_privilege($1,'public.manual_troika_topup_receipt_links','DELETE') AS receipt_link_delete,
      has_column_privilege($1,'public.business_event_edges','source_event_id','SELECT') AS edge_source_select,
      has_column_privilege($1,'public.business_event_edges','target_event_id','SELECT') AS edge_target_select,
      has_column_privilege($1,'public.business_event_edges','resolution_status','SELECT') AS edge_status_select,
      has_table_privilege($1,'public.business_event_edges','INSERT') AS edge_insert`, [TEST_ROLE])).rows[0];
    assert.deepEqual(writePrivileges, {
      expense_table_insert: false, expense_column_insert: true, expense_update: false, expense_delete: false,
      receipt_link_table_insert: false, receipt_link_column_insert: true, receipt_link_update: false, receipt_link_delete: false,
      receipt_link_stage_insert: true, receipt_link_confirmation_insert: true,
      edge_source_select: true, edge_target_select: true, edge_status_select: true, edge_insert: false,
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

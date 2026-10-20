import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { createBankAccountReference, createFinancialAccount, createPaymentInstrument, relateFinancialAccountPerson, relatePaymentInstrumentPerson } from '../src/bank-account-resolution.js';
import { createBankSource, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { loadBankReceiptMatching } from '../src/bank-receipt-matching.js';
import { persistMatchedPurchaseForTest } from '../src/matched-purchase-persistence.js';
import { dryRunPrepaymentSettlements, persistPrepaymentSettlementMatches, reconsiderPrepaymentSettlement } from '../src/prepayment-settlement-matcher.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';
import {
  confirmPrepaidWalletRide,
  confirmPrepaidWalletTopup,
  createPrepaidWallet,
  getPrepaidWalletBalanceAt,
  linkPrepaidWalletReceiptEvidence,
  recordPrepaidWalletBalanceSnapshot,
  TROIKA_PREPAID_WALLET_ENABLED_ENV,
} from '../src/prepaid-wallet.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const provider = 'ru.alfabank.mobile.android';
let pool;

before(async () => { if (databaseUrl) pool = new pg.Pool({ connectionString: databaseUrl, max: 8 }); });
after(async () => { await pool?.end(); });

async function createBankTransaction({ sourceId, suffix, amount, occurredAt, eventType = 'UNKNOWN', direction = 'UNKNOWN', normalizationStatus = 'UNKNOWN', evidenceQuality = 'INSUFFICIENT', accountReference = null, exactAccountId = null }) {
  const observation = (await pool.query(`INSERT INTO bank_event_observations
    (bank_source_id,source_event_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata)
    VALUES($1,$2,$3,$4,$4,'{}'::jsonb,$5,$6::jsonb) RETURNING id`, [
    sourceId, `synthetic-troika-${suffix}`, digest(`dedup-${suffix}`), occurredAt, digest(`payload-${suffix}`), JSON.stringify({ provider, adapter: 'synthetic-test', schemaVersion: '1' }),
  ])).rows[0];
  const transaction = (await pool.query(`INSERT INTO bank_transactions
    (observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality,account_reference,account_reference_kind)
    VALUES($1,$2,$3,'RUB',$4,$5,$6,'synthetic-alfa-v1',$7,$8,$9) RETURNING id`, [
    observation.id, occurredAt, amount, direction, eventType, normalizationStatus, evidenceQuality,
    accountReference, accountReference ? 'MASKED_CARD' : null,
  ])).rows[0];
  if (exactAccountId !== null) {
    await pool.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
      VALUES($1,$2,'MANUAL','USER_CONFIRMED','Synthetic matching fixture')`, [transaction.id, exactAccountId]);
  }
  return Number(transaction.id);
}

async function createReceipt({ scopeId, fnsSourceId, suffix, amount, dateTime, stage, storedValueSettlement = false }) {
  const receipt = (await pool.query(`INSERT INTO receipts(fns_id,date_time,seller,seller_inn,total_sum,currency,operation_type)
    VALUES($1,$2,'Synthetic Troika merchant','7700000000',$3,'RUB',1) RETURNING id`, [`synthetic-troika-${suffix}`, dateTime, amount])).rows[0];
  const receiptId = Number(receipt.id);
  await pool.query(`INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id,source_content_sha256)
    VALUES($1,$2,$3,$4)`, [receiptId, fnsSourceId, `synthetic-source-${suffix}`, digest(`receipt-source-${suffix}`)]);
  const item = (await pool.query(`INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum,provider_inn)
    VALUES($1,0,'Synthetic Troika transport value',1,$2,$2,'7700000000') RETURNING id`, [receiptId, amount])).rows[0];
  const paymentTypeCode = stage === 'PREPAYMENT_ONLY' ? 1 : 4;
  await pool.query(`INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,payment_type_semantic,product_type_code,provider_inn,normalized_content_sha256)
    VALUES($1,'fiscal-normalizer-v1',$2,$3,4,'7700000000',$4)`, [item.id, paymentTypeCode, paymentTypeCode === 1 ? 'PREPAYMENT_100' : 'FULL_SETTLEMENT', digest(`receipt-item-${suffix}`)]);
  const prepaid = storedValueSettlement ? amount : '0.00';
  const ecash = storedValueSettlement ? '0.00' : amount;
  await pool.query(`INSERT INTO receipt_fiscal_facts(
      receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,ffd_version_code,ffd_version,
      fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,
      prepaid_sum,prepaid_state,credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status)
    VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY','4','1.2',1,'OUT','0.00','EXPLICIT_ZERO',$4,$5,$6,$7,'0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED',$8,'UNKNOWN')`, [
    receiptId, digest(`receipt-raw-${suffix}`), digest(`receipt-normalized-${suffix}`), ecash, ecash === '0.00' ? 'EXPLICIT_ZERO' : 'PRESENT_VALUE', prepaid,
    prepaid === '0.00' ? 'EXPLICIT_ZERO' : 'PRESENT_VALUE', stage,
  ]);
  return receiptId;
}

integration('Troika topups are append-only transfers, link exact receipts, and stay excluded from expense/reconciliation paths', { concurrency: false }, async () => {
  const previousFlag = process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV];
  process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV] = 'true';
  const suffix = `${process.pid}-${Date.now()}`;
  const scopeKey = `troika-wallet-${suffix}`;
  const sourceKey = `troika-bank-${suffix}`;
  const personKey = `troika-person-${suffix}`;
  try {
    const scope = (await pool.query("INSERT INTO accounting_scopes(scope_key,label) VALUES($1,'Synthetic wallet scope') RETURNING id", [scopeKey])).rows[0];
    const scopeId = Number(scope.id);
    const person = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, personKey, 'Synthetic owner'])).rows[0];
    const personId = Number(person.id);
    const account = await createFinancialAccount(pool, { scopeKey, institution: 'Synthetic Alfa', provider, displayName: `Synthetic debit ${suffix}`, currency: 'RUB' });
    await relateFinancialAccountPerson(pool, { financialAccountId: Number(account.id), personId, relationType: 'OWNER', provenance: 'USER_CONFIRMED', reason: 'Synthetic owner confirmation' });
    const instrument = await createPaymentInstrument(pool, { scopeKey, financialAccountId: Number(account.id), instrumentType: 'CARD', provider, displayName: 'Synthetic debit ****5580' });
    await relatePaymentInstrumentPerson(pool, { paymentInstrumentId: Number(instrument.id), personId, relationType: 'OWNER', provenance: 'USER_CONFIRMED', reason: 'Synthetic owner confirmation' });
    await createBankAccountReference(pool, { paymentInstrumentId: Number(instrument.id), provider, referenceKind: 'MASKED_CARD', referenceValue: '****5580' });
    const source = await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic Alfa Android source' });
    await linkBankSourcePerson(pool, { sourceKey, personId });
    const fnsSource = (await pool.query("INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref) VALUES($1,$2,'Synthetic FNS','synthetic-session','synthetic-device') RETURNING id", [scopeId, `troika-fns-${suffix}`])).rows[0];
    const wallet = await createPrepaidWallet(pool, { scopeKey, ownerPersonId: personId, reason: 'Synthetic confirmed transport wallet' });

    const tx591Like = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-21`, amount: '21.00', occurredAt: '2026-10-20T09:48:00.000Z' });
    const tx594Like = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-34`, amount: '34.00', occurredAt: '2026-10-20T09:52:00.000Z' });
    const topup21 = await confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: tx591Like, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '21.00', evidenceBasis: 'BANK_DOCUMENT_AND_USER_CONFIRMATION', confirmationKey: `confirm-21-${suffix}`, reason: 'Synthetic bank-document and user confirmation',
    });
    const topup34 = await confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: tx594Like, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '34.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `confirm-34-${suffix}`, reason: 'Synthetic user confirmation; no notification-derived exact resolution',
    });
    assert.equal(topup21.created, true);
    assert.equal(topup34.created, true);

    const confirmed = (await pool.query(`SELECT movement_type,amount::text AS amount,source_provider,financial_account_id,payment_instrument_id,
        source_account_provenance,evidence_basis,confirmed_by_person_id,provenance,bank_transaction_id
      FROM prepaid_wallet_movements WHERE wallet_id=$1 ORDER BY amount`, [wallet.walletId])).rows;
    assert.equal(confirmed.length, 2);
    assert.deepEqual(confirmed.map((row) => row.amount), ['21.00', '34.00']);
    assert.ok(confirmed.every((row) => row.movement_type === 'TOPUP' && row.source_provider === provider
      && Number(row.financial_account_id) === Number(account.id) && Number(row.payment_instrument_id) === Number(instrument.id)
      && row.source_account_provenance === 'USER_CONFIRMED' && Number(row.confirmed_by_person_id) === personId && row.provenance === 'USER_CONFIRMED'));
    assert.equal(confirmed.find((row) => Number(row.bank_transaction_id) === tx591Like).evidence_basis, 'BANK_DOCUMENT_AND_USER_CONFIRMATION');
    assert.equal(confirmed.find((row) => Number(row.bank_transaction_id) === tx594Like).evidence_basis, 'USER_CONFIRMATION');
    assert.equal(confirmed.reduce((sum, row) => sum + Number(row.amount), 0), 55);

    const topupEntries = (await pool.query(`SELECT entry.id,entry.source_event_id,event.event_type,count(posting.id)::int AS posting_count,
        count(*) FILTER (WHERE account.account_type='EXPENSE')::int AS expense_postings
      FROM prepaid_wallet_movements movement JOIN ledger_entries entry ON entry.id=movement.ledger_entry_id
      JOIN business_events event ON event.id=entry.source_event_id
      JOIN ledger_postings posting ON posting.ledger_entry_id=entry.id JOIN ledger_accounts account ON account.id=posting.account_id
      WHERE movement.wallet_id=$1 GROUP BY entry.id,event.event_type ORDER BY entry.id`, [wallet.walletId])).rows;
    assert.equal(topupEntries.length, 2);
    assert.ok(topupEntries.every((row) => row.event_type === 'STORED_VALUE_ACQUISITION' && row.posting_count === 2 && row.expense_postings === 0));

    const replay21 = await confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: tx591Like, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '21.00', evidenceBasis: 'BANK_DOCUMENT_AND_USER_CONFIRMATION', confirmationKey: `confirm-21-${suffix}`, reason: 'Synthetic bank-document and user confirmation',
    });
    assert.equal(replay21.replayed, true);
    await assert.rejects(() => confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: tx591Like, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '21.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `conflict-21-${suffix}`, reason: 'Different synthetic confirmation',
    }), (error) => error.code === 'TOPUP_IDEMPOTENCY_CONFLICT');

    const concurrentTx = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-concurrent`, amount: '3.00', occurredAt: '2026-10-20T09:54:00.000Z' });
    const concurrentInput = {
      walletId: wallet.walletId, bankTransactionId: concurrentTx, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '3.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `concurrent-${suffix}`, reason: 'Synthetic concurrent confirmation',
    };
    const concurrent = await Promise.all([confirmPrepaidWalletTopup(pool, concurrentInput), confirmPrepaidWalletTopup(pool, concurrentInput)]);
    assert.equal(concurrent.filter((row) => row.created).length, 1);
    assert.equal(concurrent.filter((row) => row.replayed).length, 1);

    const prepaymentReceiptId = await createReceipt({ scopeId, fnsSourceId: Number(fnsSource.id), suffix: `${suffix}-prepayment`, amount: '21.00', dateTime: '2026-10-20T09:48:30.000Z', stage: 'PREPAYMENT_ONLY' });
    const laterSettlementReceiptId = await createReceipt({ scopeId, fnsSourceId: Number(fnsSource.id), suffix: `${suffix}-later-settlement`, amount: '21.00', dateTime: '2026-10-21T09:48:30.000Z', stage: 'SETTLEMENT_ONLY', storedValueSettlement: true });
    const fnsSourceName = (await pool.query('SELECT source_key FROM fns_sources WHERE id=$1', [fnsSource.id])).rows[0].source_key;
    const exactPair = await dryRunPrepaymentSettlements(pool, { scopeKey, retainDetails: true });
    assert.equal(exactPair.summary.strictMatches, 1);
    assert.equal(exactPair.summary.confirmedSettlements, 1);
    const linkedReceipt = await linkPrepaidWalletReceiptEvidence(pool, {
      walletMovementId: topup21.movementId, receiptId: prepaymentReceiptId, ownerPersonId: personId,
      confirmationKey: `receipt-prepayment-${suffix}`, reason: 'Synthetic exact receipt identity confirmed by user',
    });
    assert.equal(linkedReceipt.created, true);
    assert.equal((await pool.query('SELECT payment_stage FROM receipt_fiscal_facts WHERE receipt_id=$1 AND normalization_version=$2', [prepaymentReceiptId, 'fiscal-normalizer-v1'])).rows[0].payment_stage, 'PREPAYMENT_ONLY');
    const linkedReplay = await linkPrepaidWalletReceiptEvidence(pool, {
      walletMovementId: topup21.movementId, receiptId: prepaymentReceiptId, ownerPersonId: personId,
      confirmationKey: `receipt-prepayment-${suffix}`, reason: 'Synthetic exact receipt identity confirmed by user',
    });
    assert.equal(linkedReplay.replayed, true);
    const lifecycle = await dryRunPrepaymentSettlements(pool, { scopeKey, retainDetails: true });
    assert.equal(lifecycle.summary.confirmedSettlements, 0);
    assert.ok(lifecycle.candidates.every((candidate) => String(candidate.prepaymentReceiptId) !== String(prepaymentReceiptId)));
    const incremental = await reconsiderPrepaymentSettlement(pool, laterSettlementReceiptId, { scopeKey });
    assert.equal(incremental.summary.confirmedSettlements, 0);
    const linkedIncremental = await reconsiderPrepaymentSettlement(pool, prepaymentReceiptId, { scopeKey });
    assert.equal(linkedIncremental.triggerStatus, 'NOT_READY');
    const lifecycleWrite = await persistPrepaymentSettlementMatches(pool, { scopeKey, result: lifecycle });
    assert.equal(lifecycleWrite.confirmedPairs.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM business_event_evidence WHERE receipt_id=$1', [prepaymentReceiptId])).rows[0].count, 0);
    assert.ok(fnsSourceName.startsWith('troika-fns-'));

    const matchTx = await createBankTransaction({
      sourceId: Number(source.id), suffix: `${suffix}-match-race`, amount: '35.00', occurredAt: '2026-10-20T10:00:00.000Z',
      eventType: 'PURCHASE', direction: 'DEBIT', normalizationStatus: 'READY', evidenceQuality: 'EXACT', accountReference: '****5580', exactAccountId: Number(account.id),
    });
    const matchReceiptId = await createReceipt({ scopeId, fnsSourceId: Number(fnsSource.id), suffix: `${suffix}-match-race`, amount: '35.00', dateTime: '2026-10-20T10:00:20.000Z', stage: 'SETTLEMENT_ONLY' });
    const beforeWalletTopup = await loadBankReceiptMatching(pool, { scopeKey, internalTransferMaxTimeDeltaMs: 300_000, receiptMaxTimeDeltaMs: 300_000 });
    assert.equal(beforeWalletTopup.matches.length, 1, JSON.stringify({
      summary: beforeWalletTopup.summary,
      bankStatuses: beforeWalletTopup.bankStatuses,
      receiptStatuses: beforeWalletTopup.receiptStatuses,
    }));
    assert.equal(Number(beforeWalletTopup.matches[0].bank.bankTransactionId), matchTx);
    const matchTopup = await confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: matchTx, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '35.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `match-topup-${suffix}`, reason: 'Synthetic user-confirmed topup for race guard',
    });
    assert.equal(matchTopup.created, true);
    const afterWalletTopup = await loadBankReceiptMatching(pool, { scopeKey, internalTransferMaxTimeDeltaMs: 300_000, receiptMaxTimeDeltaMs: 300_000 });
    assert.equal(afterWalletTopup.matches.length, 0);
    assert.equal(afterWalletTopup.bankStatuses.find((row) => Number(row.bankTransactionId) === matchTx)?.reasonCode, 'PREPAID_WALLET_MOVEMENT_ALREADY_CONFIRMED');
    await assert.rejects(() => persistMatchedPurchaseForTest(pool, {
      scopeKey, matchKey: beforeWalletTopup.matches[0].matchKey, internalTransferMaxTimeDeltaMs: 300_000,
      receiptMaxTimeDeltaMs: 300_000, matchingLoader: async () => beforeWalletTopup,
    }), (error) => error.code === 'PREPAID_WALLET_MATCH_INELIGIBLE');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE bank_transaction_id=$1 OR receipt_id=$2', [matchTx, matchReceiptId])).rows[0].count, 0);

    const wrongMaskAccount = await createFinancialAccount(pool, { scopeKey, institution: 'Synthetic Alfa credit', provider, displayName: `Synthetic credit ${suffix}`, currency: 'RUB' });
    await relateFinancialAccountPerson(pool, { financialAccountId: Number(wrongMaskAccount.id), personId, relationType: 'OWNER', provenance: 'USER_CONFIRMED', reason: 'Synthetic owner confirmation' });
    const wrongMaskInstrument = await createPaymentInstrument(pool, { scopeKey, financialAccountId: Number(wrongMaskAccount.id), instrumentType: 'CARD', provider, displayName: 'Synthetic other card ****8451' });
    await relatePaymentInstrumentPerson(pool, { paymentInstrumentId: Number(wrongMaskInstrument.id), personId, relationType: 'OWNER', provenance: 'USER_CONFIRMED', reason: 'Synthetic owner confirmation' });
    await createBankAccountReference(pool, { paymentInstrumentId: Number(wrongMaskInstrument.id), provider, referenceKind: 'MASKED_CARD', referenceValue: '****8451' });
    const conflictingReferenceTx = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-conflicting-card-reference`, amount: '9.00', occurredAt: '2026-10-20T10:00:45.000Z', accountReference: '****8451' });
    await assert.rejects(() => confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: conflictingReferenceTx, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '9.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `conflicting-card-reference-${suffix}`, reason: 'Synthetic negative case',
    }), (error) => error.code === 'BANK_TRANSACTION_CARD_REFERENCE_CONFLICT');
    const conflictingAccountTx = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-conflicting-account-resolution`, amount: '9.50', occurredAt: '2026-10-20T10:00:50.000Z', exactAccountId: Number(wrongMaskAccount.id) });
    await assert.rejects(() => confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: conflictingAccountTx, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '9.50', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `conflicting-account-resolution-${suffix}`, reason: 'Synthetic negative case',
    }), (error) => error.code === 'BANK_TRANSACTION_ACCOUNT_RESOLUTION_CONFLICT');
    const conflictingInstrumentTx = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-conflicting-instrument-resolution`, amount: '9.75', occurredAt: '2026-10-20T10:00:55.000Z' });
    await pool.query(`INSERT INTO bank_transaction_payment_instrument_resolution(bank_transaction_id,payment_instrument_id,resolution_state,provenance,reason)
      VALUES($1,$2,'EXACT','SYNTHETIC_TEST','Synthetic conflicting instrument')`, [conflictingInstrumentTx, wrongMaskInstrument.id]);
    await assert.rejects(() => confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: conflictingInstrumentTx, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '9.75', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `conflicting-instrument-resolution-${suffix}`, reason: 'Synthetic negative case',
    }), (error) => error.code === 'BANK_TRANSACTION_PAYMENT_INSTRUMENT_CONFLICT');
    const wrongMaskTx = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-wrong-mask`, amount: '5.00', occurredAt: '2026-10-20T10:01:00.000Z' });
    await assert.rejects(() => confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: wrongMaskTx, financialAccountId: Number(wrongMaskAccount.id), paymentInstrumentId: Number(wrongMaskInstrument.id), ownerPersonId: personId,
      amount: '5.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `wrong-mask-${suffix}`, reason: 'Synthetic negative case',
    }), (error) => error.code === 'BANK_ACCOUNT_INSTRUMENT_OWNER_CONFLICT');

    const conflictingInstrument = await createPaymentInstrument(pool, { scopeKey, financialAccountId: Number(account.id), instrumentType: 'CARD', provider, displayName: `Synthetic conflicting card ${suffix}` });
    await relatePaymentInstrumentPerson(pool, { paymentInstrumentId: Number(conflictingInstrument.id), personId, relationType: 'OWNER', provenance: 'USER_CONFIRMED', reason: 'Synthetic owner confirmation' });
    await createBankAccountReference(pool, { paymentInstrumentId: Number(conflictingInstrument.id), provider, referenceKind: 'MASKED_CARD', referenceValue: '****5580' });
    const conflictTx = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-duplicate-mask`, amount: '6.00', occurredAt: '2026-10-20T10:02:00.000Z' });
    await assert.rejects(() => confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: conflictTx, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '6.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `duplicate-mask-${suffix}`, reason: 'Synthetic negative case',
    }), (error) => error.code === 'BANK_ACCOUNT_INSTRUMENT_OWNER_CONFLICT');

    const otherPerson = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, `other-${suffix}`, 'Synthetic other person'])).rows[0];
    const wrongWalletOwnerTx = await createBankTransaction({ sourceId: Number(source.id), suffix: `${suffix}-wrong-wallet-owner`, amount: '7.00', occurredAt: '2026-10-20T10:03:00.000Z' });
    await assert.rejects(() => confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: wrongWalletOwnerTx, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: Number(otherPerson.id),
      amount: '7.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `wrong-wallet-owner-${suffix}`, reason: 'Synthetic negative case',
    }), (error) => error.code === 'WALLET_OWNER_OR_SCOPE_CONFLICT');
    const otherSourceKey = `troika-bank-other-${suffix}`;
    const otherSource = await createBankSource(pool, { sourceKey: otherSourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic other-owner Alfa source' });
    await linkBankSourcePerson(pool, { sourceKey: otherSourceKey, personId: Number(otherPerson.id) });
    const wrongSourceOwnerTx = await createBankTransaction({ sourceId: Number(otherSource.id), suffix: `${suffix}-wrong-source-owner`, amount: '8.00', occurredAt: '2026-10-20T10:03:30.000Z' });
    await assert.rejects(() => confirmPrepaidWalletTopup(pool, {
      walletId: wallet.walletId, bankTransactionId: wrongSourceOwnerTx, financialAccountId: Number(account.id), paymentInstrumentId: Number(instrument.id), ownerPersonId: personId,
      amount: '8.00', evidenceBasis: 'USER_CONFIRMATION', confirmationKey: `wrong-source-owner-${suffix}`, reason: 'Synthetic negative case',
    }), (error) => error.code === 'BANK_SOURCE_OWNER_SCOPE_CONFLICT');

    const snapshot = await recordPrepaidWalletBalanceSnapshot(pool, {
      walletId: wallet.walletId, ownerPersonId: personId, balance: '100.00', currency: 'RUB', observedAt: '2026-10-20T12:00:00.000Z',
      confirmationKey: `baseline-${suffix}`, reason: 'Synthetic user-confirmed balance baseline',
    });
    assert.equal(snapshot.created, true);
    await assert.rejects(() => recordPrepaidWalletBalanceSnapshot(pool, {
      walletId: wallet.walletId, ownerPersonId: personId, balance: '101.00', currency: 'RUB', observedAt: '2026-10-20T12:00:00.000Z',
      confirmationKey: `conflicting-baseline-${suffix}`, reason: 'Synthetic conflicting snapshot',
    }), (error) => error.code === 'BALANCE_SNAPSHOT_CONFLICT');
    const rideReceiptId = await createReceipt({ scopeId, fnsSourceId: Number(fnsSource.id), suffix: `${suffix}-ride`, amount: '12.00', dateTime: '2026-10-20T12:30:10.000Z', stage: 'SETTLEMENT_ONLY', storedValueSettlement: true });
    await assert.rejects(() => confirmPrepaidWalletRide(pool, {
      walletId: wallet.walletId, receiptId: rideReceiptId, ownerPersonId: personId, amount: '101.00', occurredAt: '2026-10-20T12:30:00.000Z',
      confirmationKey: `overdraw-${suffix}`, reason: 'Synthetic insufficient balance case',
    }), (error) => error.code === 'WALLET_INSUFFICIENT_BALANCE');
    const ride = await confirmPrepaidWalletRide(pool, {
      walletId: wallet.walletId, receiptId: rideReceiptId, ownerPersonId: personId, amount: '12.00', occurredAt: '2026-10-20T12:30:00.000Z',
      confirmationKey: `ride-${suffix}`, reason: 'Synthetic user-confirmed Troika ride',
    });
    assert.equal(ride.created, true);
    assert.equal(ride.balance, '88.00');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM prepaid_wallet_receipt_evidence WHERE wallet_movement_id=$1 AND receipt_id=$2', [ride.movementId, rideReceiptId])).rows[0].count, 1);
    const rideEvidence = await linkPrepaidWalletReceiptEvidence(pool, {
      walletMovementId: ride.movementId, receiptId: rideReceiptId, ownerPersonId: personId,
      confirmationKey: `ride-${suffix}`, reason: 'Synthetic user-confirmed Troika ride',
    });
    assert.equal(rideEvidence.replayed, true);
    const standalone = await persistStandalonePurchases(pool, { scopeKey, receiptIds: [rideReceiptId] });
    assert.equal(standalone.created, 0);
    const alreadyAccountedRideReceipt = await createReceipt({ scopeId, fnsSourceId: Number(fnsSource.id), suffix: `${suffix}-already-accounted-ride`, amount: '2.50', dateTime: '2026-10-20T12:31:10.000Z', stage: 'SETTLEMENT_ONLY' });
    const existingStandalone = await persistStandalonePurchases(pool, { scopeKey, receiptIds: [alreadyAccountedRideReceipt] });
    assert.equal(existingStandalone.created, 1);
    await assert.rejects(() => confirmPrepaidWalletRide(pool, {
      walletId: wallet.walletId, receiptId: alreadyAccountedRideReceipt, ownerPersonId: personId, amount: '2.50', occurredAt: '2026-10-20T12:31:00.000Z',
      confirmationKey: `already-accounted-ride-${suffix}`, reason: 'Synthetic double-expense prevention',
    }), (error) => error.code === 'RECEIPT_ALREADY_ACCOUNTED');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM prepaid_wallet_movements WHERE wallet_id=$1 AND confirmation_key=$2", [wallet.walletId, `already-accounted-ride-${suffix}`])).rows[0].count, 0);
    const linkedRideLedger = (await pool.query(`SELECT entry.id,count(*) FILTER (WHERE account.account_type='EXPENSE' AND posting.debit='12.00')::int AS expense_postings
      FROM prepaid_wallet_movements movement JOIN ledger_entries entry ON entry.id=movement.ledger_entry_id
      JOIN ledger_postings posting ON posting.ledger_entry_id=entry.id JOIN ledger_accounts account ON account.id=posting.account_id
      WHERE movement.id=$1 GROUP BY entry.id`, [ride.movementId])).rows[0];
    assert.equal(linkedRideLedger.expense_postings, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM business_event_evidence WHERE receipt_id=$1 AND evidence_role='PURCHASE_EVIDENCE'", [rideReceiptId])).rows[0].count, 0);
    assert.equal((await getPrepaidWalletBalanceAt(pool, { walletId: wallet.walletId, at: '2026-10-20T12:31:00.000Z' })).balance, '88.00');
    const rideReplay = await confirmPrepaidWalletRide(pool, {
      walletId: wallet.walletId, receiptId: rideReceiptId, ownerPersonId: personId, amount: '12.00', occurredAt: '2026-10-20T12:30:00.000Z',
      confirmationKey: `ride-${suffix}`, reason: 'Synthetic user-confirmed Troika ride',
    });
    assert.equal(rideReplay.replayed, true);

    const permissionClient = await pool.connect();
    try {
      await permissionClient.query('BEGIN');
      await permissionClient.query('SET LOCAL ROLE receipt_collector');
      await permissionClient.query('SELECT scope_id,bank_transaction_id FROM prepaid_wallet_movements LIMIT 0');
      await permissionClient.query('SELECT scope_id,receipt_id FROM prepaid_wallet_receipt_evidence LIMIT 0');
      await permissionClient.query('SAVEPOINT denied_column');
      await assert.rejects(() => permissionClient.query('SELECT amount FROM prepaid_wallet_movements LIMIT 0'), /permission denied/);
      await permissionClient.query('ROLLBACK TO SAVEPOINT denied_column');
      await permissionClient.query('SAVEPOINT denied_insert');
      await assert.rejects(() => permissionClient.query("INSERT INTO prepaid_wallets(scope_id,owner_person_id,wallet_key,display_name,currency,provenance,reason) VALUES(1,1,'forbidden','forbidden','RUB','USER_CONFIRMED','forbidden')"), /permission denied/);
      await permissionClient.query('ROLLBACK TO SAVEPOINT denied_insert');
      await permissionClient.query('ROLLBACK');
    } finally { permissionClient.release(); }

    const appendOnlyClient = await pool.connect();
    try {
      await appendOnlyClient.query('BEGIN');
      await appendOnlyClient.query('SAVEPOINT append_only_update');
      await assert.rejects(() => appendOnlyClient.query('UPDATE prepaid_wallets SET display_name=display_name WHERE id=$1', [wallet.walletId]), /append-only/);
      await appendOnlyClient.query('ROLLBACK TO SAVEPOINT append_only_update');
      await appendOnlyClient.query('SAVEPOINT append_only_delete');
      await assert.rejects(() => appendOnlyClient.query('DELETE FROM prepaid_wallet_movements WHERE id=$1', [topup21.movementId]), /append-only/);
      await appendOnlyClient.query('ROLLBACK TO SAVEPOINT append_only_delete');
      await appendOnlyClient.query('ROLLBACK');
    } finally { appendOnlyClient.release(); }

    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_source_provider_account_bindings WHERE bank_source_id=$1 AND provider=$2 AND active', [source.id, provider])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE source_event_id IN (SELECT business_event_id FROM prepaid_wallet_movements WHERE wallet_id=$1) AND derivation_rule=$2', [wallet.walletId, 'STANDALONE_PURCHASE_V1'])).rows[0].count, 0);
  } finally {
    if (previousFlag === undefined) delete process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV];
    else process.env[TROIKA_PREPAID_WALLET_ENABLED_ENV] = previousFlag;
  }
});

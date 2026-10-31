import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { runAccountingCatchup } from '../src/accounting-pipeline.js';
import { loadBankReceiptMatching } from '../src/bank-receipt-matching.js';
import { rebuildCertification } from '../src/certification.js';
import { rebuildLedger } from '../src/ledger.js';
import { persistMatchedPurchase } from '../src/matched-purchase-persistence.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';
import { normalizeBankEvent } from '../src/bank-ingestion.js';
import {
  BANK_ONLY_PURCHASE_LEDGER_ENABLED_ENV,
  readBankOnlyPurchaseLedgerOptIn,
  runBankOnlyPurchaseCatchup,
  writeBankOnlyPurchase,
} from '../src/bank-only-purchase.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
let fixtureSequence = 0;

function optIn(scopeKey, now = new Date(), alfaStartAt = null) {
  return {
    enabled: true,
    scopeKey,
    startAt: new Date(new Date(now).getTime() - 86400000).toISOString(),
    alfaStartAt,
    maxWrites: 25,
  };
}

async function createContext(pool, provider = 'bank.example') {
  const suffix = `${process.pid}-${Date.now()}-${fixtureSequence += 1}`;
  const scopeKey = `bank-only-${suffix}`;
  const scopeId = Number((await pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, 'Synthetic bank-only test'])).rows[0].id);
  const personId = Number((await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, `${scopeKey}-person`, 'Synthetic owner'])).rows[0].id);
  const accountId = Number((await pool.query('INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency) VALUES($1,$2,$2,$3,\'RUB\') RETURNING id', [scopeId, provider, `${scopeKey} account`])).rows[0].id);
  await pool.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES($1,$2,'OWNER','USER_CONFIRMED','synthetic integration fixture')", [accountId, personId]);
  const sourceId = Number((await pool.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,'ANDROID_NOTIFICATION',$2) RETURNING id", [`${scopeKey}-source`, 'Synthetic bank source'])).rows[0].id);
  await pool.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [sourceId, personId]);
  if (provider !== 'com.idamob.tinkoff.android') {
    await pool.query(`INSERT INTO bank_source_provider_account_bindings(bank_source_id,provider,financial_account_id,provenance,reason)
      VALUES($1,$2,$3,'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT','synthetic integration binding')`, [sourceId, provider, accountId]);
  }
  return { suffix, scopeId, scopeKey, personId, accountId, sourceId, provider };
}

async function createTransaction(pool, context, {
  occurredAt = new Date(Date.now() - 60000).toISOString(), observedAt = occurredAt, amount = '83.41', currency = 'RUB',
  eventType = 'PURCHASE', direction = 'DEBIT', normalizationStatus = 'READY', evidenceQuality = 'EXACT',
  merchant = null, accountReference = null, accountReferenceKind = null, accountResolved = true,
  tbankInstrumentId = null, tbankResolutionState = 'EXACT', notificationLifecycleId = null,
} = {}) {
  const dedupKey = digest(`${context.suffix}:${occurredAt}:${eventType}:${direction}:${accountReference ?? ''}:${fixtureSequence += 1}`);
  const observationId = Number((await pool.query(`INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata)
    VALUES($1,$2,$3,$4,'{}'::jsonb,$2,$5::jsonb) RETURNING id`, [context.sourceId, dedupKey, observedAt, occurredAt,
    JSON.stringify({ provider: context.provider, ...(notificationLifecycleId ? { notificationLifecycleId } : {}) })])).rows[0].id);
  const transaction = (await pool.query(`INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,merchant,event_type,normalization_status,normalization_version,evidence_quality,account_reference,account_reference_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthetic-bank-only-v1',$9,$10,$11) RETURNING id`, [observationId, occurredAt, amount, currency, direction, merchant, eventType, normalizationStatus, evidenceQuality, accountReference, accountReferenceKind])).rows[0];
  const bankTransactionId = Number(transaction.id);
  if (accountResolved) {
    await pool.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
      VALUES($1,$2,'EXACT',$3,'synthetic exact account fixture')`, [bankTransactionId, context.accountId,
      context.provider === 'com.idamob.tinkoff.android' ? 'OBSERVED_PROVIDER_REFERENCE' : 'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT']);
  } else {
    await pool.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
      VALUES($1,NULL,'UNKNOWN','INSUFFICIENT_EVIDENCE','synthetic unresolved account fixture')`, [bankTransactionId]);
  }
  if (context.provider === 'com.idamob.tinkoff.android') {
    await pool.query(`INSERT INTO bank_transaction_payment_instrument_resolution(bank_transaction_id,payment_instrument_id,resolution_state,provenance,reason)
      VALUES($1,$2,$3,$4,'synthetic card-specific fixture')`, [bankTransactionId, accountResolved ? tbankInstrumentId : null,
      accountResolved ? tbankResolutionState : 'UNKNOWN', accountResolved ? 'OBSERVED_PROVIDER_REFERENCE' : 'INSUFFICIENT_EVIDENCE']);
  }
  return { bankTransactionId, observationId, occurredAt };
}

async function createReceipt(pool, context, { amount = '83.41', dateTime, suffix = context.suffix, paymentStage = 'SETTLEMENT_ONLY' } = {}) {
  const receiptId = Number((await pool.query(`INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency,operation_type)
    VALUES($1,$2,'Synthetic merchant',$3,'RUB',1) RETURNING id`, [`${context.scopeKey}-receipt-${suffix}`, dateTime, amount])).rows[0].id);
  const sourceId = Number((await pool.query(`INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref)
    VALUES($1,$2,'Synthetic FNS source','fixture-session','fixture-device') RETURNING id`, [context.scopeId, `${context.scopeKey}-fns-${suffix}`])).rows[0].id);
  await pool.query('INSERT INTO fns_source_person(fns_source_id,person_id) VALUES($1,$2)', [sourceId, context.personId]);
  await pool.query('INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,$3)', [receiptId, sourceId, `${context.scopeKey}-source-receipt-${suffix}`]);
  const itemId = Number((await pool.query(`INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum)
    VALUES($1,0,'Synthetic item','1',$2,$2) RETURNING id`, [receiptId, amount])).rows[0].id);
  await pool.query(`INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256)
    VALUES($1,'fiscal-normalizer-v1',4,$2)`, [itemId, digest(`${context.scopeKey}:item:${suffix}`)]);
  await pool.query(`INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,
      fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,
      credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status)
    VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO',$4,'PRESENT_VALUE','0.00','EXPLICIT_ZERO',
      '0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED',$5,'UNKNOWN')`, [receiptId,
    digest(`${context.scopeKey}:receipt-source:${suffix}`), digest(`${context.scopeKey}:receipt-normalized:${suffix}`), amount, paymentStage]);
  return receiptId;
}

async function writeStandaloneReceipt(pool, context, receiptId) {
  const standalone = await persistStandalonePurchases(pool, { scopeKey: context.scopeKey, receiptIds: [receiptId] });
  assert.equal(standalone.purchases.some((item) => Number(item.receiptId) === Number(receiptId)), true);
  const eventId = Number((await pool.query(`SELECT ev.event_id FROM business_event_evidence ev
    JOIN business_events e ON e.id=ev.event_id
    WHERE ev.receipt_id=$1 AND e.scope_id=$2 AND ev.evidence_role='PURCHASE_EVIDENCE'`, [receiptId, context.scopeId])).rows[0].event_id);
  await rebuildLedger(pool, { scopeKey: context.scopeKey, eventIds: [eventId] });
  return eventId;
}

async function latestCanonicalPurchases(pool, context) {
  return (await pool.query(`SELECT purchase_id,amount::text AS amount,currency FROM canonical_spending_purchases_v1
    WHERE scope_id=$1 AND certification_run_id=(SELECT max(id) FROM reconciliation_runs WHERE scope_id=$1 AND status='READY')
    ORDER BY purchase_id`, [context.scopeId])).rows.map((row) => ({ ...row, purchase_id: Number(row.purchase_id) }));
}

async function activePurchaseLedgerCount(pool, context) {
  return Number((await pool.query(`SELECT count(*)::int AS count FROM ledger_entries e
    WHERE e.scope_id=$1 AND e.derivation_rule IN ('LEDGER_BANK_ONLY_PURCHASE_V1','LEDGER_STANDALONE_PURCHASE_V1','LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1')
      AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions s WHERE s.scope_id=e.scope_id AND s.superseded_ledger_entry_id=e.id)`, [context.scopeId])).rows[0].count);
}

integration('bank-only purchase uses ACTIVE ledger, defers receipt candidates, and merges either arrival order without duplicate spending', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  try {
    await pool.query(await readFile(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
    const now = new Date();

    const bankOnly = await createContext(pool, 'bank.example');
    const bankOnlyTx = await createTransaction(pool, bankOnly, { amount: '83.41', merchant: 'Synthetic bank merchant' });
    const saved = await writeBankOnlyPurchase(pool, { bankTransactionId: bankOnlyTx.bankTransactionId, optIn: optIn(bankOnly.scopeKey, now) });
    assert.equal(saved.status, 'PERSISTED');
    const merchantProjection = (await pool.query(`SELECT seller, bank_merchant, bank_merchant_source,
        merchant_display, merchant_display_source, receipt_id
      FROM analytics_purchases WHERE purchase_id=$1`, [saved.eventId])).rows;
    assert.deepEqual(merchantProjection, [{
      seller: null,
      bank_merchant: 'Synthetic bank merchant',
      bank_merchant_source: 'ANDROID_NOTIFICATION',
      merchant_display: 'Synthetic bank merchant',
      merchant_display_source: 'ANDROID_NOTIFICATION',
      receipt_id: null,
    }]);
    const replay = await writeBankOnlyPurchase(pool, { bankTransactionId: bankOnlyTx.bankTransactionId, optIn: optIn(bankOnly.scopeKey, now) });
    assert.equal(replay.status, 'REUSED');
    const catchupReplay = await runBankOnlyPurchaseCatchup(pool, { scopeKey: bankOnly.scopeKey, optIn: optIn(bankOnly.scopeKey, now), now, logger: { info() {} } });
    assert.equal(catchupReplay.persisted, 0);
    assert.equal(catchupReplay.examined, 0);
    assert.equal(await activePurchaseLedgerCount(pool, bankOnly), 1);
    assert.deepEqual(await latestCanonicalPurchases(pool, bankOnly), [{ purchase_id: saved.eventId, amount: '83.41', currency: 'RUB' }]);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM certification_facts WHERE business_event_id=$1
      AND metric_code='CONFIRMED_ACQUISITION_VALUE' AND status='CERTIFIED'`, [saved.eventId])).rows[0].count, 1);

    const receiptFirst = await createContext(pool, 'bank.example');
    const receiptFirstTime = new Date(Date.now() - 90000).toISOString();
    const receiptFirstId = await createReceipt(pool, receiptFirst, { amount: '31.00', dateTime: receiptFirstTime });
    const receiptFirstEvent = await writeStandaloneReceipt(pool, receiptFirst, receiptFirstId);
    await rebuildCertification(pool, { scopeKey: receiptFirst.scopeKey, persist: true, replace: true });
    assert.equal(await activePurchaseLedgerCount(pool, receiptFirst), 1);
    assert.equal((await latestCanonicalPurchases(pool, receiptFirst)).length, 1);
    const receiptFirstTx = await createTransaction(pool, receiptFirst, { amount: '31.00', occurredAt: receiptFirstTime });
    const receiptFirstSaved = await writeBankOnlyPurchase(pool, { bankTransactionId: receiptFirstTx.bankTransactionId, optIn: optIn(receiptFirst.scopeKey, now) });
    assert.equal(receiptFirstSaved.status, 'PERSISTED', JSON.stringify(receiptFirstSaved));
    assert.equal(receiptFirstSaved.diagnosticCode, 'UNIQUE_RECEIPT_CANDIDATE_PENDING');
    assert.equal(await activePurchaseLedgerCount(pool, receiptFirst), 2);
    assert.equal((await latestCanonicalPurchases(pool, receiptFirst)).length, 2);
    assert.equal((await pool.query(`SELECT evidence_snapshot->>'receiptMatchStatusAtWrite' AS status
      FROM business_event_bank_evidence WHERE bank_transaction_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'`, [receiptFirstTx.bankTransactionId])).rows[0].status, 'MATCHED');
    const receiptFirstMatches = await loadBankReceiptMatching(pool, {
      scopeKey: receiptFirst.scopeKey,
      from: new Date(Date.parse(receiptFirstTime) - 300000).toISOString(),
      to: new Date(Date.parse(receiptFirstTime) + 300001).toISOString(),
      internalTransferMaxTimeDeltaMs: 300000,
      receiptMaxTimeDeltaMs: 300000,
    });
    const receiptFirstMatch = receiptFirstMatches.matches.find((item) => item.bank.bankTransactionId === receiptFirstTx.bankTransactionId);
    assert.ok(receiptFirstMatch);
    const receiptFirstPersisted = await persistMatchedPurchase(pool, {
      scopeKey: receiptFirst.scopeKey, matchKey: receiptFirstMatch.matchKey,
      from: new Date(Date.parse(receiptFirstTime) - 300000).toISOString(),
      to: new Date(Date.parse(receiptFirstTime) + 300001).toISOString(),
      internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000,
    });
    assert.equal(receiptFirstPersisted.outcome, 'PERSISTED');
    assert.equal(Number((await pool.query('SELECT source_event_id FROM ledger_entries WHERE id=$1', [receiptFirstPersisted.ledgerEntryId])).rows[0].source_event_id), receiptFirstEvent);
    assert.equal(await activePurchaseLedgerCount(pool, receiptFirst), 1);
    assert.equal((await latestCanonicalPurchases(pool, receiptFirst)).length, 1);

    const bankFirst = await createContext(pool, 'bank.example');
    const bankFirstTime = new Date(Date.now() - 80000).toISOString();
    const bankFirstTx = await createTransaction(pool, bankFirst, { amount: '37.62', occurredAt: bankFirstTime });
    const bankFirstSaved = await writeBankOnlyPurchase(pool, { bankTransactionId: bankFirstTx.bankTransactionId, optIn: optIn(bankFirst.scopeKey, now) });
    assert.equal(bankFirstSaved.status, 'PERSISTED');
    assert.equal((await pool.query(`SELECT evidence_snapshot->>'receiptMatchStatusAtWrite' AS status
      FROM business_event_bank_evidence WHERE bank_transaction_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'`, [bankFirstTx.bankTransactionId])).rows[0].status, 'UNMATCHED');
    assert.deepEqual(await latestCanonicalPurchases(pool, bankFirst), [{ purchase_id: bankFirstSaved.eventId, amount: '37.62', currency: 'RUB' }]);
    const bankFirstReceiptId = await createReceipt(pool, bankFirst, { amount: '37.62', dateTime: bankFirstTime });
    await writeStandaloneReceipt(pool, bankFirst, bankFirstReceiptId);
    await rebuildCertification(pool, { scopeKey: bankFirst.scopeKey, persist: true, replace: true });
    assert.equal(await activePurchaseLedgerCount(pool, bankFirst), 2);
    assert.equal((await latestCanonicalPurchases(pool, bankFirst)).length, 2);
    const bankFirstMatches = await loadBankReceiptMatching(pool, {
      scopeKey: bankFirst.scopeKey,
      from: new Date(Date.parse(bankFirstTime) - 300000).toISOString(),
      to: new Date(Date.parse(bankFirstTime) + 300001).toISOString(),
      internalTransferMaxTimeDeltaMs: 300000,
      receiptMaxTimeDeltaMs: 300000,
    });
    const bankFirstMatch = bankFirstMatches.matches.find((item) => item.bank.bankTransactionId === bankFirstTx.bankTransactionId);
    assert.ok(bankFirstMatch);
    const bankFirstPersisted = await persistMatchedPurchase(pool, {
      scopeKey: bankFirst.scopeKey, matchKey: bankFirstMatch.matchKey,
      from: new Date(Date.parse(bankFirstTime) - 300000).toISOString(),
      to: new Date(Date.parse(bankFirstTime) + 300001).toISOString(),
      internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000,
    });
    assert.ok(['PERSISTED', 'REUSED'].includes(bankFirstPersisted.outcome));
    assert.equal(await activePurchaseLedgerCount(pool, bankFirst), 1);
    assert.equal((await latestCanonicalPurchases(pool, bankFirst)).length, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger_entry_supersessions s
      JOIN ledger_entries old_entry ON old_entry.id=s.superseded_ledger_entry_id
      WHERE s.scope_id=$1 AND old_entry.derivation_rule='LEDGER_BANK_ONLY_PURCHASE_V1'`, [bankFirst.scopeId])).rows[0].count, 1);

    const concurrentMatch = await createContext(pool, 'bank.example');
    const concurrentMatchTime = new Date(Date.now() - 65000).toISOString();
    const concurrentMatchReceipt = await createReceipt(pool, concurrentMatch, { amount: '27.00', dateTime: concurrentMatchTime });
    const concurrentMatchTx = await createTransaction(pool, concurrentMatch, { amount: '27.00', occurredAt: concurrentMatchTime });
    const concurrentMatches = await loadBankReceiptMatching(pool, {
      scopeKey: concurrentMatch.scopeKey,
      from: new Date(Date.parse(concurrentMatchTime) - 300000).toISOString(),
      to: new Date(Date.parse(concurrentMatchTime) + 300001).toISOString(),
      internalTransferMaxTimeDeltaMs: 300000,
      receiptMaxTimeDeltaMs: 300000,
    });
    const concurrentCandidate = concurrentMatches.matches.find((item) => item.bank.bankTransactionId === concurrentMatchTx.bankTransactionId);
    assert.ok(concurrentCandidate);
    const [concurrentBankResult, concurrentFnsResult, concurrentMatchResult] = await Promise.all([
      writeBankOnlyPurchase(pool, { bankTransactionId: concurrentMatchTx.bankTransactionId, optIn: optIn(concurrentMatch.scopeKey, now) }),
      persistStandalonePurchases(pool, { scopeKey: concurrentMatch.scopeKey, receiptIds: [concurrentMatchReceipt] }),
      persistMatchedPurchase(pool, {
        scopeKey: concurrentMatch.scopeKey, matchKey: concurrentCandidate.matchKey,
        from: new Date(Date.parse(concurrentMatchTime) - 300000).toISOString(),
        to: new Date(Date.parse(concurrentMatchTime) + 300001).toISOString(),
        internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000,
      }),
    ]);
    assert.equal(concurrentFnsResult.candidates, 1);
    assert.equal(concurrentFnsResult.purchases.length, 1);
    assert.ok(['PERSISTED', 'BLOCKED'].includes(concurrentBankResult.status));
    if (concurrentBankResult.status === 'BLOCKED') assert.equal(concurrentBankResult.reasonCode, 'ALREADY_MATCHED');
    assert.ok(['PERSISTED', 'REUSED'].includes(concurrentMatchResult.outcome));
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_event_evidence
      WHERE receipt_id=$1 AND evidence_role='PURCHASE_EVIDENCE'`, [concurrentMatchReceipt])).rows[0].count, 1);
    assert.equal(await activePurchaseLedgerCount(pool, concurrentMatch), 1);
    assert.equal((await latestCanonicalPurchases(pool, concurrentMatch)).length, 1);

    const ambiguous = await createContext(pool, 'bank.example');
    const ambiguousTime = new Date(Date.now() - 70000).toISOString();
    const ambiguousReceipt = await createReceipt(pool, ambiguous, { amount: '19.00', dateTime: ambiguousTime });
    await writeStandaloneReceipt(pool, ambiguous, ambiguousReceipt);
    const ambiguousA = await createTransaction(pool, ambiguous, { amount: '19.00', occurredAt: ambiguousTime });
    const ambiguousB = await createTransaction(pool, ambiguous, { amount: '19.00', occurredAt: ambiguousTime });
    for (const item of [ambiguousA, ambiguousB]) {
      const result = await writeBankOnlyPurchase(pool, { bankTransactionId: item.bankTransactionId, optIn: optIn(ambiguous.scopeKey, now) });
      assert.equal(result.status, 'PERSISTED');
      assert.equal(result.diagnosticCode, 'AMBIGUOUS_RECEIPT_CANDIDATE_AT_WRITE');
    }
    assert.equal(await activePurchaseLedgerCount(pool, ambiguous), 3);
    assert.equal((await latestCanonicalPurchases(pool, ambiguous)).length, 3);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_event_bank_evidence
      WHERE scope_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'
        AND evidence_snapshot->>'receiptMatchStatusAtWrite'='AMBIGUOUS'`, [ambiguous.scopeId])).rows[0].count, 2);
    const ambiguousMatches = await loadBankReceiptMatching(pool, {
      scopeKey: ambiguous.scopeKey,
      from: new Date(Date.parse(ambiguousTime) - 300000).toISOString(),
      to: new Date(Date.parse(ambiguousTime) + 300001).toISOString(),
      internalTransferMaxTimeDeltaMs: 300000,
      receiptMaxTimeDeltaMs: 300000,
    });
    assert.equal(ambiguousMatches.matches.length, 0);
    assert.equal(ambiguousMatches.summary.ambiguousBankPurchases, 2);

    const disallowed = await createContext(pool, 'bank.example');
    const transfer = await createTransaction(pool, disallowed, { eventType: 'OUTGOING_TRANSFER', direction: 'DEBIT' });
    const partial = await createTransaction(pool, disallowed, { normalizationStatus: 'PARTIAL', evidenceQuality: 'PARTIAL' });
    const credit = await createTransaction(pool, disallowed, { direction: 'CREDIT' });
    const refund = await createTransaction(pool, disallowed, { eventType: 'RETURN', direction: 'DEBIT' });
    const canceled = await createTransaction(pool, disallowed, { eventType: 'CANCELLED', direction: 'DEBIT' });
    const topup = await createTransaction(pool, disallowed, { eventType: 'TOP_UP', direction: 'DEBIT' });
    const unknown = await createTransaction(pool, disallowed, { eventType: 'UNKNOWN', normalizationStatus: 'UNKNOWN', evidenceQuality: 'INSUFFICIENT' });
    for (const item of [transfer, partial, credit, refund, canceled, topup, unknown]) {
      const result = await writeBankOnlyPurchase(pool, { bankTransactionId: item.bankTransactionId, optIn: optIn(disallowed.scopeKey, now) });
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.reasonCode, 'PURCHASE_PROOF_INCOMPLETE');
    }
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM business_event_bank_evidence WHERE scope_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'", [disallowed.scopeId])).rows[0].count, 0);

    const tbank = await createContext(pool, 'com.idamob.tinkoff.android');
    const otherCard = await createTransaction(pool, tbank, {
      amount: '17.00', accountReference: '****9999', accountReferenceKind: 'MASKED_CARD', accountResolved: false,
    });
    const otherCardResult = await writeBankOnlyPurchase(pool, { bankTransactionId: otherCard.bankTransactionId, optIn: optIn(tbank.scopeKey, now) });
    assert.deepEqual({ status: otherCardResult.status, reasonCode: otherCardResult.reasonCode }, { status: 'BLOCKED', reasonCode: 'PURCHASE_PROOF_INCOMPLETE' });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM business_event_bank_evidence WHERE scope_id=$1 AND evidence_role=$2', [tbank.scopeId, 'BANK_ONLY_PURCHASE'])).rows[0].count, 0);

    const independent = await createContext(pool, 'bank.example');
    const sameAmountA = await createTransaction(pool, independent, { amount: '12.34', occurredAt: new Date(Date.now() - 180000).toISOString() });
    const sameAmountB = await createTransaction(pool, independent, { amount: '12.34', occurredAt: new Date(Date.now() - 90000).toISOString() });
    const independentA = await writeBankOnlyPurchase(pool, { bankTransactionId: sameAmountA.bankTransactionId, optIn: optIn(independent.scopeKey, now) });
    const independentB = await writeBankOnlyPurchase(pool, { bankTransactionId: sameAmountB.bankTransactionId, optIn: optIn(independent.scopeKey, now) });
    assert.equal(independentA.status, 'PERSISTED');
    assert.equal(independentB.status, 'PERSISTED');
    assert.equal(await activePurchaseLedgerCount(pool, independent), 2);
    assert.equal((await latestCanonicalPurchases(pool, independent)).reduce((sum, row) => sum + Number(row.amount), 0), 24.68);

    const delayed = await createContext(pool, 'bank.example');
    const cutoff = new Date(Date.now() - 30000);
    const delayedTx = await createTransaction(pool, delayed, {
      amount: '8.00', occurredAt: new Date(cutoff.getTime() - 3600000).toISOString(),
      observedAt: new Date(cutoff.getTime() + 1000).toISOString(),
    });
    const delayedSaved = await writeBankOnlyPurchase(pool, {
      bankTransactionId: delayedTx.bankTransactionId,
      optIn: { ...optIn(delayed.scopeKey, now), startAt: cutoff.toISOString() },
    });
    assert.equal(delayedSaved.status, 'PERSISTED');
    assert.equal((await latestCanonicalPurchases(pool, delayed)).length, 1);

    const rollback = await createContext(pool, 'bank.example');
    const rollbackTx = await createTransaction(pool, rollback);
    await assert.rejects(writeBankOnlyPurchase(pool, {
      bankTransactionId: rollbackTx.bankTransactionId, optIn: optIn(rollback.scopeKey, now), failAfter: 'evidence',
    }), { code: 'INJECTED_BANK_ONLY_WRITER_FAILURE' });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_events e
      WHERE e.scope_id=$1 AND e.rule_code='BANK_ONLY_PURCHASE_V1'`, [rollback.scopeId])).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_event_bank_evidence
      WHERE scope_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'`, [rollback.scopeId])).rows[0].count, 0);
    assert.equal(await activePurchaseLedgerCount(pool, rollback), 0);

    const concurrent = await createContext(pool, 'bank.example');
    const concurrentTx = await createTransaction(pool, concurrent);
    const concurrentResults = await Promise.all([
      writeBankOnlyPurchase(pool, { bankTransactionId: concurrentTx.bankTransactionId, optIn: optIn(concurrent.scopeKey, now) }),
      writeBankOnlyPurchase(pool, { bankTransactionId: concurrentTx.bankTransactionId, optIn: optIn(concurrent.scopeKey, now) }),
    ]);
    assert.deepEqual(concurrentResults.map((item) => item.status).sort(), ['PERSISTED', 'REUSED']);
    assert.equal(await activePurchaseLedgerCount(pool, concurrent), 1);

    const privilege = (await pool.query(`SELECT
      has_column_privilege('receipt_collector','public.business_event_bank_evidence','bank_transaction_id','SELECT') AS can_select_new_source,
      has_column_privilege('receipt_collector','public.business_event_bank_evidence','bank_transaction_id','INSERT') AS can_insert_new_source,
      has_column_privilege('receipt_collector','public.business_event_bank_evidence','bank_transaction_id','UPDATE') AS can_update_new_source`)).rows[0];
    assert.equal(privilege.can_select_new_source, true);
    assert.equal(privilege.can_insert_new_source, true);
    assert.equal(privilege.can_update_new_source, false);
  } finally {
    await pool.end();
  }
});

integration('bank-only writer blocks an ordinary expense when a scoped PREPAYMENT_ONLY receipt is a nearby exact-amount candidate', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const now = new Date();
    const context = await createContext(pool, 'yandex-bank.example');
    const occurredAt = new Date(now.getTime() - 30000).toISOString();
    const amount = '29211.66';
    const transaction = await createTransaction(pool, context, { occurredAt, observedAt: occurredAt, amount });
    await createReceipt(pool, context, { amount, dateTime: new Date(Date.parse(occurredAt) + 60000).toISOString(), suffix: 'nearby-prepayment', paymentStage: 'PREPAYMENT_ONLY' });

    const result = await writeBankOnlyPurchase(pool, { bankTransactionId: transaction.bankTransactionId, optIn: optIn(context.scopeKey, now) });
    assert.deepEqual({ status: result.status, reasonCode: result.reasonCode }, {
      status: 'BLOCKED', reasonCode: 'PREPAYMENT_RECEIPT_CANDIDATE',
    });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_event_bank_evidence
      WHERE bank_transaction_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'`, [transaction.bankTransactionId])).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger_source_links
      WHERE bank_transaction_id=$1`, [transaction.bankTransactionId])).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_events
      WHERE scope_id=$1 AND rule_code='BANK_ONLY_PURCHASE_V1'`, [context.scopeId])).rows[0].count, 0);
  } finally {
    await pool.end();
  }
});

integration('bank-only catch-up pages past a full batch of blocked candidates', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  try {
    const context = await createContext(pool, 'bank.example');
    const now = new Date(Date.now() + 120000);
    for (let index = 0; index < 250; index += 1) {
      const occurredAt = new Date(now.getTime() - 60000 + index).toISOString();
      await createTransaction(pool, context, {
        occurredAt,
        observedAt: occurredAt,
        amount: (10 + index / 100).toFixed(2),
        accountResolved: false,
      });
    }
    const eligible = await createTransaction(pool, context, {
      occurredAt: new Date(now.getTime() - 30000).toISOString(),
      observedAt: new Date(now.getTime() - 30000).toISOString(),
      amount: '999.99',
    });
    const itemLogs = [];
    const result = await runBankOnlyPurchaseCatchup(pool, {
      scopeKey: context.scopeKey,
      optIn: optIn(context.scopeKey, now),
      now,
      logger: {
        info: (event, fields) => itemLogs.push({ event, fields }),
        warn: (event, fields) => itemLogs.push({ event, fields }),
        error: (event, fields) => itemLogs.push({ event, fields }),
      },
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.examined, 251);
    assert.equal(result.blocked, 250);
    assert.equal(result.persisted, 1);
    assert.equal(result.candidatePages, 2);
    assert.equal(await activePurchaseLedgerCount(pool, context), 1);
    assert.ok(itemLogs.some(({ event, fields }) => event === 'bank_only_purchase_catchup_item'
      && fields.bankTransactionId === eligible.bankTransactionId && fields.status === 'PERSISTED'));
  } finally {
    await pool.end();
  }
});

integration('disabling bank-only stops new writes while existing ledger, FNS-only, and matched accounting remain usable', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  try {
    await pool.query(await readFile(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
    const now = new Date();
    const bank = await createContext(pool, 'bank.example');
    const occurredAt = new Date(Date.now() - 60000).toISOString();
    const existingTx = await createTransaction(pool, bank, { amount: '83.41', occurredAt });
    const existingExpense = await writeBankOnlyPurchase(pool, {
      bankTransactionId: existingTx.bankTransactionId,
      optIn: optIn(bank.scopeKey, now),
    });
    assert.equal(existingExpense.status, 'PERSISTED');

    const disabled = readBankOnlyPurchaseLedgerOptIn({ [BANK_ONLY_PURCHASE_LEDGER_ENABLED_ENV]: 'false' });
    assert.deepEqual(disabled, { enabled: false, reasonCode: 'DISABLED' });
    const afterStopTx = await createTransaction(pool, bank, {
      amount: '19.25', occurredAt: new Date(Date.parse(occurredAt) + 10000).toISOString(),
    });
    assert.equal((await writeBankOnlyPurchase(pool, {
      bankTransactionId: afterStopTx.bankTransactionId, optIn: disabled,
    })).status, 'DISABLED');
    const stoppedCatchup = await runAccountingCatchup(pool, {
      scopeKey: bank.scopeKey, bankOnlyPurchaseOptIn: disabled, now, logger: { info() {} },
    });
    assert.equal(stoppedCatchup.bankOnlyPurchases.status, 'DISABLED');
    assert.equal(await activePurchaseLedgerCount(pool, bank), 1);
    assert.deepEqual(await latestCanonicalPurchases(pool, bank), [
      { purchase_id: existingExpense.eventId, amount: '83.41', currency: 'RUB' },
    ]);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_event_bank_evidence
      WHERE scope_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'`, [bank.scopeId])).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_events
      WHERE scope_id=$1 AND rule_code='BANK_ONLY_PURCHASE_V1'`, [bank.scopeId])).rows[0].count, 1);

    const fnsOnly = await createContext(pool, 'fns-only.example');
    const fnsReceipt = await createReceipt(pool, fnsOnly, { amount: '7.20', dateTime: occurredAt });
    const fnsCatchup = await runAccountingCatchup(pool, {
      scopeKey: fnsOnly.scopeKey, bankOnlyPurchaseOptIn: disabled, now, logger: { info() {} },
    });
    assert.equal(fnsCatchup.bankOnlyPurchases.status, 'DISABLED');
    assert.equal(await activePurchaseLedgerCount(pool, fnsOnly), 1);
    assert.deepEqual(await latestCanonicalPurchases(pool, fnsOnly), [
      { purchase_id: Number((await pool.query(`SELECT event_id FROM business_event_evidence
        WHERE receipt_id=$1 AND evidence_role='PURCHASE_EVIDENCE'`, [fnsReceipt])).rows[0].event_id), amount: '7.20', currency: 'RUB' },
    ]);

    const lateReceipt = await createReceipt(pool, bank, { amount: '83.41', dateTime: occurredAt, suffix: 'after-stop' });
    await runAccountingCatchup(pool, {
      scopeKey: bank.scopeKey, bankOnlyPurchaseOptIn: disabled, now, logger: { info() {} },
    });
    const from = new Date(Date.parse(occurredAt) - 300000).toISOString();
    const to = new Date(Date.parse(occurredAt) + 300001).toISOString();
    const matching = await loadBankReceiptMatching(pool, {
      scopeKey: bank.scopeKey, from, to,
      internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000,
    });
    const candidate = matching.matches.find(item => item.bank.bankTransactionId === existingTx.bankTransactionId
      && item.receipt.receiptId === lateReceipt);
    assert.ok(candidate);

    await assert.rejects(() => persistMatchedPurchase(pool, {
      scopeKey: bank.scopeKey, matchKey: candidate.matchKey, from, to,
      internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000, failAfter: 'ledger',
    }), error => error.code === 'INJECTED_WRITER_FAILURE');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bank_receipt_matches WHERE scope_id=$1', [bank.scopeId])).rows[0].count, 0);
    assert.equal(await activePurchaseLedgerCount(pool, bank), 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM business_event_bank_evidence
      WHERE scope_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'`, [bank.scopeId])).rows[0].count, 1);

    const matched = await persistMatchedPurchase(pool, {
      scopeKey: bank.scopeKey, matchKey: candidate.matchKey, from, to,
      internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000,
    });
    assert.ok(['PERSISTED', 'REUSED'].includes(matched.outcome));
    assert.equal(await activePurchaseLedgerCount(pool, bank), 1);
    assert.deepEqual((await latestCanonicalPurchases(pool, bank)).map(row => row.amount), ['83.41']);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger_entry_supersessions
      WHERE scope_id=$1 AND reason_code='BANK_ONLY_PURCHASE_MATCHED_REFINEMENT'`, [bank.scopeId])).rows[0].count, 1);
  } finally {
    await pool.end();
  }
});

integration('confirmed Alfa Troika card purchases use the ordinary bank-only path once per lifecycle and match FNS without a second active expense', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  try {
    await pool.query(await readFile(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
    const now = new Date(Date.now() + 5000);
    const context = await createContext(pool, 'ru.alfabank.mobile.android');
    const lifecycleId = crypto.randomUUID();
    const occurredAt = new Date(now.getTime() - 90000).toISOString();
    const alfaStartAt = new Date(now.getTime() - 120000).toISOString();
    const withoutAlfaCutoff = await createTransaction(pool, context, {
      occurredAt: new Date(now.getTime() - 130000).toISOString(),
      observedAt: new Date(now.getTime() - 125000).toISOString(), amount: null, eventType: 'UNKNOWN', direction: 'UNKNOWN',
      normalizationStatus: 'PARTIAL', evidenceQuality: 'PARTIAL', merchant: 'Тройка', accountReference: '****5580',
      accountReferenceKind: 'MASKED_CARD', notificationLifecycleId: crypto.randomUUID(),
    });
    await pool.query(`UPDATE bank_event_observations SET created_at=$2
      WHERE id=(SELECT observation_id FROM bank_transactions WHERE id=$1)`, [withoutAlfaCutoff.bankTransactionId, new Date(now.getTime() - 125000)]);
    const cutoffMissing = await writeBankOnlyPurchase(pool, {
      bankTransactionId: withoutAlfaCutoff.bankTransactionId, optIn: optIn(context.scopeKey, now), now,
    });
    assert.equal(cutoffMissing.status, 'BLOCKED');
    assert.equal(cutoffMissing.reasonCode, 'ALFA_PURCHASE_CUTOFF_REQUIRED');
    const preCutoff = await createTransaction(pool, context, {
      occurredAt: new Date(now.getTime() - 900000).toISOString(),
      observedAt: new Date(now.getTime() - 125000).toISOString(), amount: '17.00',
      merchant: 'Тройка', accountReference: '****5580', accountReferenceKind: 'MASKED_CARD',
      notificationLifecycleId: crypto.randomUUID(),
    });
    await pool.query(`UPDATE bank_event_observations SET created_at=$2
      WHERE id=(SELECT observation_id FROM bank_transactions WHERE id=$1)`, [preCutoff.bankTransactionId, new Date(now.getTime() - 125000)]);
    const first = await createTransaction(pool, context, {
      occurredAt, observedAt: new Date(Date.parse(occurredAt) + 11000).toISOString(), amount: '17.00',
      merchant: 'Тройка', accountReference: '****5580', accountReferenceKind: 'MASKED_CARD',
      notificationLifecycleId: lifecycleId,
    });
    const update = await createTransaction(pool, context, {
      occurredAt: new Date(Date.parse(occurredAt) + 1000).toISOString(),
      observedAt: new Date(Date.parse(occurredAt) + 12000).toISOString(), amount: '17.00',
      merchant: 'Тройка', accountReference: '****5580', accountReferenceKind: 'MASKED_CARD',
      notificationLifecycleId: lifecycleId,
    });
    const optInValue = optIn(context.scopeKey, now, alfaStartAt);
    const caughtUp = await runBankOnlyPurchaseCatchup(pool, {
      scopeKey: context.scopeKey, optIn: optInValue, now, logger: { info() {} },
    });
    assert.equal(caughtUp.status, 'COMPLETED');
    assert.equal(caughtUp.examined, 1, 'only the first exact monetary post in a lifecycle is eligible');
    assert.equal(caughtUp.persisted, 1);
    const oldCohort = await writeBankOnlyPurchase(pool, { bankTransactionId: preCutoff.bankTransactionId, optIn: optInValue, now });
    assert.equal(oldCohort.status, 'BLOCKED');
    assert.equal(oldCohort.reasonCode, 'OUTSIDE_COHORT');
    assert.equal((await writeBankOnlyPurchase(pool, { bankTransactionId: first.bankTransactionId, optIn: optInValue, now })).status, 'REUSED');
    const replay = await writeBankOnlyPurchase(pool, { bankTransactionId: update.bankTransactionId, optIn: optInValue, now });
    assert.equal(replay.status, 'REUSED');
    assert.equal(replay.reasonCode, 'ALFA_NOTIFICATION_LIFECYCLE_ALREADY_ACCOUNTED');
    assert.equal(await activePurchaseLedgerCount(pool, context), 1);
    const evidence = (await pool.query(`SELECT evidence_snapshot->>'merchant' AS merchant,
        evidence_snapshot->>'accountReference' AS account_reference,
        evidence_snapshot->>'accountReferenceKind' AS account_reference_kind,
        evidence_snapshot->>'notificationLifecycleId' AS lifecycle_id
      FROM business_event_bank_evidence WHERE bank_transaction_id=$1 AND evidence_role='BANK_ONLY_PURCHASE'`, [first.bankTransactionId])).rows[0];
    assert.equal(evidence.merchant, 'Тройка');
    assert.equal(evidence.account_reference, '****5580');
    assert.equal(evidence.account_reference_kind, 'MASKED_CARD');
    assert.equal(evidence.lifecycle_id, lifecycleId);

    const receiptId = await createReceipt(pool, context, { amount: '17.00', dateTime: occurredAt, suffix: 'alfa-troika' });
    await writeStandaloneReceipt(pool, context, receiptId);
    assert.equal(await activePurchaseLedgerCount(pool, context), 2, 'bank and receipt evidence temporarily have separate entries before matching');
    const from = new Date(Date.parse(occurredAt) - 300000).toISOString();
    const to = new Date(Date.parse(occurredAt) + 300001).toISOString();
    const matching = await loadBankReceiptMatching(pool, {
      scopeKey: context.scopeKey, from, to,
      internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000,
    });
    const candidate = matching.matches.find((item) => item.bank.bankTransactionId === first.bankTransactionId
      && item.receipt.receiptId === receiptId);
    const updateStatus = matching.bankStatuses.find((item) => item.bankTransactionId === update.bankTransactionId);
    assert.equal(updateStatus.status, 'INELIGIBLE');
    assert.equal(updateStatus.reasonCode, 'DUPLICATE_ALFA_NOTIFICATION_LIFECYCLE');
    assert.ok(candidate, JSON.stringify({
      summary: matching.summary,
      bankStatuses: matching.bankStatuses.map(({ bankTransactionId, status, reasonCode }) => ({ bankTransactionId, status, reasonCode })),
      receiptStatuses: matching.receiptStatuses.map(({ receiptId: id, status, reasonCode }) => ({ receiptId: id, status, reasonCode })),
    }));
    const matched = await persistMatchedPurchase(pool, {
      scopeKey: context.scopeKey, matchKey: candidate.matchKey, from, to,
      internalTransferMaxTimeDeltaMs: 300000, receiptMaxTimeDeltaMs: 300000,
    });
    assert.ok(['PERSISTED', 'REUSED'].includes(matched.outcome));
    assert.equal(await activePurchaseLedgerCount(pool, context), 1);

    const secondLifecycleId = crypto.randomUUID();
    const secondOccurredAt = new Date(now.getTime() - 30000).toISOString();
    const secondNotification = normalizeBankEvent({
      sourceKey: 'synthetic-alfa-bank-source',
      sourceEventId: `synthetic-alfa-${secondLifecycleId}`,
      observedAt: secondOccurredAt,
      eventTime: secondOccurredAt,
      ingestionMetadata: {
        adapter: 'android-notification', provider: 'ru.alfabank.mobile.android',
        deviceType: 'android', schemaVersion: '1', sourcePackage: 'ru.alfabank.mobile.android',
        notificationLifecycleId: secondLifecycleId,
      },
      payload: {
        title: '- 17 ₽. Пятёрочка',
        description: 'Пятёрочка: 17,00 ₽; •• 5580',
        text: 'Пятёрочка: 17,00 ₽; •• 5580',
      },
    });
    assert.equal(secondNotification.eventType, 'PURCHASE');
    assert.equal(secondNotification.merchant, 'Пятёрочка');
    const secondPurchase = await createTransaction(pool, context, {
      occurredAt: secondOccurredAt, observedAt: secondOccurredAt,
      amount: secondNotification.amount, currency: secondNotification.currency,
      eventType: secondNotification.eventType, direction: secondNotification.direction,
      normalizationStatus: secondNotification.normalizationStatus, evidenceQuality: secondNotification.evidenceQuality,
      merchant: secondNotification.merchant, accountReference: secondNotification.accountReference,
      accountReferenceKind: secondNotification.accountReferenceKind,
      notificationLifecycleId: secondLifecycleId,
    });
    assert.equal((await writeBankOnlyPurchase(pool, { bankTransactionId: secondPurchase.bankTransactionId, optIn: optInValue, now })).status, 'PERSISTED');
    assert.equal(await activePurchaseLedgerCount(pool, context), 2, 'same-amount purchases with different lifecycle ids remain separate expenses');
    const secondUpdate = await createTransaction(pool, context, {
      occurredAt: new Date(Date.parse(secondOccurredAt) + 1000).toISOString(),
      observedAt: new Date(Date.parse(secondOccurredAt) + 12000).toISOString(), amount: '17.00',
      merchant: 'Пятёрочка', accountReference: '****5580', accountReferenceKind: 'MASKED_CARD',
      notificationLifecycleId: secondLifecycleId,
    });
    const secondReplay = await writeBankOnlyPurchase(pool, { bankTransactionId: secondUpdate.bankTransactionId, optIn: optInValue, now });
    assert.equal(secondReplay.status, 'REUSED');
    assert.equal(await activePurchaseLedgerCount(pool, context), 2, 'an update in the same lifecycle does not create another active expense');

    const unknown = await createTransaction(pool, context, {
      occurredAt: new Date(Date.parse(occurredAt) + 30000).toISOString(), amount: null,
      merchant: 'Тройка', eventType: 'UNKNOWN', direction: 'UNKNOWN',
      normalizationStatus: 'PARTIAL', evidenceQuality: 'PARTIAL',
      notificationLifecycleId: crypto.randomUUID(),
    });
    const unknownResult = await writeBankOnlyPurchase(pool, { bankTransactionId: unknown.bankTransactionId, optIn: optInValue, now });
    assert.equal(unknownResult.status, 'BLOCKED');
    assert.equal(unknownResult.reasonCode, 'PURCHASE_PROOF_INCOMPLETE');
    const transfer = await createTransaction(pool, context, {
      occurredAt: new Date(Date.parse(occurredAt) + 40000).toISOString(), amount: '17.00',
      eventType: 'OUTGOING_TRANSFER', direction: 'DEBIT', merchant: null,
      notificationLifecycleId: crypto.randomUUID(),
    });
    const transferResult = await writeBankOnlyPurchase(pool, { bankTransactionId: transfer.bankTransactionId, optIn: optInValue, now });
    assert.equal(transferResult.status, 'BLOCKED');
    assert.equal(transferResult.reasonCode, 'PURCHASE_PROOF_INCOMPLETE');
    assert.equal(await activePurchaseLedgerCount(pool, context), 2);
  } finally {
    await pool.end();
  }
});

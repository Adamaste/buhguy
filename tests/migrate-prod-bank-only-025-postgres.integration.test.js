import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { assertDisposableLocalTestDatabase } from '../scripts/assert-disposable-local-test-database.js';
import { BANK_ONLY_MIGRATION_025, migrateBankOnly025 } from '../scripts/migrate-prod-bank-only-025.mjs';
import { migrate } from '../src/database.js';
import { persistStandalonePurchases } from '../src/standalone-purchase.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDisposableLocalTestDatabase(databaseUrl);
const integration = databaseUrl ? test : test.skip;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
let fixtureSequence = 0;

async function migrationsThrough024() {
  const source = new URL('../db/migrations/', import.meta.url);
  const names = (await readdir(source)).filter(name => name.endsWith('.sql') && name < BANK_ONLY_MIGRATION_025).sort();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buhguy-bank-only-025-stage-'));
  for (const name of names) await copyFile(new URL(name, source), path.join(directory, name));
  return directory;
}

async function migrationsThrough025() {
  const source = new URL('../db/migrations/', import.meta.url);
  const names = (await readdir(source)).filter(name => name.endsWith('.sql') && name <= BANK_ONLY_MIGRATION_025).sort();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buhguy-bank-only-025-runner-'));
  for (const name of names) await copyFile(new URL(name, source), path.join(directory, name));
  return directory;
}

async function createFixture(pool, prefix, { amount, standalone = false }) {
  const suffix = `${process.pid}-${Date.now()}-${fixtureSequence += 1}`;
  const scopeKey = `${prefix}-scope-${suffix}`;
  const client = await pool.connect();
  let fixture;
  try {
    await client.query('BEGIN');
    const scopeId = Number((await client.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, prefix])).rows[0].id);
    const personId = Number((await client.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, `${scopeKey}-person`, 'Synthetic person'])).rows[0].id);
    const accountId = Number((await client.query("INSERT INTO financial_accounts(scope_id,institution,display_name,currency) VALUES($1,'Synthetic bank',$2,'RUB') RETURNING id", [scopeId, `${scopeKey}-account`])).rows[0].id);
    const sourceId = Number((await client.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,'ANDROID_NOTIFICATION',$2) RETURNING id", [`${scopeKey}-bank-source`, prefix])).rows[0].id);
    await client.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [sourceId, personId]);
    await client.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES($1,$2,'OWNER','SYNTHETIC_TEST','synthetic migration fixture')", [accountId, personId]);
    const observationId = Number((await client.query(`INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256)
      VALUES($1,$2,NOW(),NOW(),'{}',$3) RETURNING id`, [sourceId, digest(`${scopeKey}:dedup`), digest(`${scopeKey}:payload`)])).rows[0].id);
    const bankTransactionId = Number((await client.query(`INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,event_type,normalization_status,normalization_version,evidence_quality)
      VALUES($1,NOW(),$2,'RUB','DEBIT','PURCHASE','READY','synthetic-v1','EXACT') RETURNING id`, [observationId, amount])).rows[0].id);
    await client.query("INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES($1,$2,'EXACT','SYNTHETIC_TEST','synthetic account proof')", [bankTransactionId, accountId]);
    const receiptId = Number((await client.query(`INSERT INTO receipts(fns_id,date_time,seller,total_sum,currency,operation_type)
      VALUES($1,NOW(),'Synthetic merchant',$2,'RUB',1) RETURNING id`, [`${scopeKey}-receipt`, amount])).rows[0].id);
    const fnsSourceId = Number((await client.query(`INSERT INTO fns_sources(scope_id,source_key,display_name,session_ref,device_ref)
      VALUES($1,$2,'Synthetic FNS source','synthetic','synthetic') RETURNING id`, [scopeId, `${scopeKey}-fns-source`])).rows[0].id);
    await client.query('INSERT INTO fns_source_person(fns_source_id,person_id) VALUES($1,$2)', [fnsSourceId, personId]);
    await client.query('INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id) VALUES($1,$2,$3)', [receiptId, fnsSourceId, `${scopeKey}-source-receipt`]);
    const itemId = Number((await client.query(`INSERT INTO receipt_items(receipt_id,position,name,quantity,price,item_sum)
      VALUES($1,0,'Synthetic item','1',$2,$2) RETURNING id`, [receiptId, amount])).rows[0].id);
    await client.query(`INSERT INTO receipt_item_fiscal_facts(receipt_item_id,normalization_version,payment_type_code,normalized_content_sha256)
      VALUES($1,'fiscal-normalizer-v1',4,$2)`, [itemId, digest(`${scopeKey}:item`)]);
    await client.query(`INSERT INTO receipt_fiscal_facts(receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,normalization_status,
      fiscal_operation_type,household_cash_direction,cash_total_sum,cash_total_state,ecash_total_sum,ecash_total_state,prepaid_sum,prepaid_state,
      credit_sum,credit_state,provision_sum,provision_state,payment_components_status,payment_stage,correction_status)
      VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY',1,'OUT','0.00','EXPLICIT_ZERO',$4,'PRESENT_VALUE','0.00','EXPLICIT_ZERO',
      '0.00','EXPLICIT_ZERO','0.00','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','UNKNOWN')`, [receiptId, digest(`${scopeKey}:source`), digest(`${scopeKey}:normalized`), amount]);
    await client.query('COMMIT');
    fixture = { scopeId, scopeKey, accountId, receiptId, bankTransactionId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (standalone) {
    await createStandaloneEvent(pool, fixture);
    await seedLegacyStandaloneLedger(pool, fixture, amount);
  }
  return fixture;
}

async function createStandaloneEvent(pool, fixture) {
  await persistStandalonePurchases(pool, { scopeKey: fixture.scopeKey, receiptIds: [fixture.receiptId] });
  fixture.eventId = Number((await pool.query(`SELECT ev.event_id FROM business_event_evidence ev
    JOIN business_events e ON e.id=ev.event_id
    WHERE ev.receipt_id=$1 AND e.scope_id=$2 AND ev.evidence_role='PURCHASE_EVIDENCE'`, [fixture.receiptId, fixture.scopeId])).rows[0].event_id);
}

async function seedLegacyStandaloneLedger(pool, fixture, amount) {
  const accountCodes = ['UNCLASSIFIED_ACQUISITION', 'FISCAL_PAYMENT_CLEARING'];
  const accountIds = [];
  for (const [index, accountCode] of accountCodes.entries()) {
    const account = (await pool.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description)
      VALUES($1,$2,'CONTROL',$3) ON CONFLICT(scope_id,account_code) DO UPDATE SET description=EXCLUDED.description
      RETURNING id`, [fixture.scopeId, accountCode, `Synthetic legacy ledger account ${index + 1}`])).rows[0];
    accountIds.push(Number(account.id));
  }
  const evidence = (await pool.query(`SELECT id,receipt_id,normalization_version FROM business_event_evidence
    WHERE event_id=$1 AND receipt_id=$2 ORDER BY id LIMIT 1`, [fixture.eventId, fixture.receiptId])).rows[0];
  assert.ok(evidence, 'legacy FNS standalone evidence exists before migration 025');
  const semanticKey = digest(`legacy-fns-ledger:${fixture.scopeKey}:${fixture.eventId}`);
  const entry = (await pool.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,
    derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description)
    VALUES($1,$2,'RUB',NOW(),$3,'LEDGER_STANDALONE_PURCHASE_V1','ledger-v1','READY','FUNDING_UNRECONCILED',
      'SYSTEM_DERIVED','SYNTHETIC_LEGACY_FNS_STANDALONE','Synthetic pre-025 standalone purchase') RETURNING id`,
  [fixture.scopeId, fixture.eventId, semanticKey])).rows[0];
  await pool.query(`INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit,source_receipt_id)
    VALUES($1,$2,'RUB',$3,'0.00',$4),($1,$5,'RUB','0.00',$3,$4)`,
  [entry.id, accountIds[0], amount, fixture.receiptId, accountIds[1]]);
  await pool.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,receipt_id,
    normalization_version,link_role,semantic_key)
    VALUES($1,$2,$3,$4,$5,'FISCAL_EVIDENCE',$6)`,
  [entry.id, fixture.eventId, evidence.id, fixture.receiptId, evidence.normalization_version,
    digest(`legacy-fns-ledger-link:${fixture.scopeKey}:${fixture.eventId}`)]);
  fixture.ledgerEntryId = Number(entry.id);
}

async function seedLegacyMatchedPurchase(pool, fixture, amount) {
  const matchKey = digest(`legacy-match:${fixture.scopeKey}`);
  const candidateKeys = ['bank-ledger', 'bank-candidate', 'bank-journal', 'receipt-candidate'];
  const match = (await pool.query(`INSERT INTO bank_receipt_matches(scope_id,bank_transaction_id,receipt_id,financial_account_id,
    matcher_version,match_key,bank_ledger_key,bank_candidate_key,bank_journal_key,receipt_candidate_key,
    receipt_normalization_version,receipt_normalized_content_sha256,amount,currency,bank_occurred_at,receipt_date_time,
    time_delta_seconds,relationship_type,reason_code,ownership_provenance)
    VALUES($1,$2,$3,$4,'bank-receipt-matching-v1',$5,$6,$7,$8,$9,'fiscal-normalizer-v1',$10,$11,'RUB',NOW(),NOW(),
      0,'MATCHED_PURCHASE','SYNTHETIC_LEGACY_MATCH','{}'::jsonb) RETURNING id`,
  [fixture.scopeId, fixture.bankTransactionId, fixture.receiptId, fixture.accountId, matchKey,
    ...candidateKeys.map(key => digest(`${fixture.scopeKey}:${key}`)), digest(`${fixture.scopeKey}:receipt-content`), amount])).rows[0];
  const evidence = (await pool.query(`SELECT id,normalization_version FROM business_event_evidence
    WHERE event_id=$1 AND receipt_id=$2 ORDER BY id LIMIT 1`, [fixture.eventId, fixture.receiptId])).rows[0];
  const enrichmentKey = digest(`legacy-match-enrichment:${fixture.scopeKey}`);
  await pool.query(`INSERT INTO business_event_bank_evidence(scope_id,business_event_id,bank_receipt_match_id,enrichment_key,
    evidence_role,rule_version,semantic_key)
    VALUES($1,$2,$3,$4,'BANK_PURCHASE_MATCH','matched-purchase-enrichment-v1',$5)`,
  [fixture.scopeId, fixture.eventId, match.id, enrichmentKey, digest(`legacy-match-evidence:${fixture.scopeKey}`)]);

  const mappedCode = `FINANCIAL_ACCOUNT:${fixture.accountId}`;
  const mapped = (await pool.query(`INSERT INTO ledger_accounts(scope_id,account_code,account_type,description,financial_account_id,account_currency)
    VALUES($1,$2,'ASSET','Synthetic mapped bank account',$3,'RUB') ON CONFLICT(scope_id,account_code) DO UPDATE SET description=EXCLUDED.description
    RETURNING id`, [fixture.scopeId, mappedCode, fixture.accountId])).rows[0];
  const bankEntry = (await pool.query(`INSERT INTO ledger_entries(scope_id,source_event_id,currency,event_at,semantic_key,
    derivation_rule,derivation_version,derivation_status,certification_status,origin,reason_code,description)
    VALUES($1,$2,'RUB',NOW(),$3,'LEDGER_MATCHED_PURCHASE_BANK_FUNDING_V1','v1','READY','FUNDING_UNRECONCILED',
      'SYSTEM_DERIVED','MATCHED_PURCHASE_BANK_FUNDING','Synthetic pre-025 matched purchase') RETURNING id`,
  [fixture.scopeId, fixture.eventId, digest(`legacy-matched-ledger:${fixture.scopeKey}`)])).rows[0];
  const acquisition = (await pool.query(`SELECT id FROM ledger_accounts WHERE scope_id=$1 AND account_code='UNCLASSIFIED_ACQUISITION'`, [fixture.scopeId])).rows[0];
  await pool.query(`INSERT INTO ledger_postings(ledger_entry_id,account_id,currency,debit,credit,source_receipt_id)
    VALUES($1,$2,'RUB',$3,'0.00',$4),($1,$5,'RUB','0.00',$3,$4)`,
  [bankEntry.id, acquisition.id, amount, fixture.receiptId, mapped.id]);
  const bankLinkKey = digest(`legacy-matched-bank-link:${fixture.scopeKey}`);
  await pool.query(`INSERT INTO ledger_source_links(ledger_entry_id,business_event_id,graph_evidence_id,receipt_id,
    normalization_version,link_role,semantic_key,bank_receipt_match_id,bank_transaction_id)
    VALUES($1,$2,$3,$4,$5,'MATCHED_PURCHASE_BANK_FUNDING',$6,$7,$8)`,
  [bankEntry.id, fixture.eventId, evidence.id, fixture.receiptId, evidence.normalization_version,
    bankLinkKey, match.id, fixture.bankTransactionId]);
  await pool.query(`INSERT INTO ledger_entry_supersessions(scope_id,superseded_ledger_entry_id,replacement_ledger_entry_id,
    business_event_id,enrichment_key,semantic_key,reason_code)
    VALUES($1,$2,$3,$4,$5,$6,'MATCHED_PURCHASE_REFINEMENT')`,
  [fixture.scopeId, fixture.ledgerEntryId, bankEntry.id, fixture.eventId, enrichmentKey,
    digest(`legacy-matched-supersession:${fixture.scopeKey}`)]);
}

async function snapshotScope(pool, scopeId) {
  const rows = {};
  rows.events = (await pool.query('SELECT * FROM business_events WHERE scope_id=$1 ORDER BY id', [scopeId])).rows;
  rows.receiptEvidence = (await pool.query('SELECT ev.* FROM business_event_evidence ev JOIN business_events e ON e.id=ev.event_id WHERE e.scope_id=$1 ORDER BY ev.id', [scopeId])).rows;
  rows.matches = (await pool.query('SELECT * FROM bank_receipt_matches WHERE scope_id=$1 ORDER BY id', [scopeId])).rows;
  rows.bankEvidence = (await pool.query(`SELECT id,scope_id,business_event_id,bank_receipt_match_id,enrichment_key,evidence_role,rule_version,semantic_key,created_at
    FROM business_event_bank_evidence WHERE scope_id=$1 ORDER BY id`, [scopeId])).rows;
  rows.ledgerEntries = (await pool.query('SELECT * FROM ledger_entries WHERE scope_id=$1 ORDER BY id', [scopeId])).rows;
  rows.ledgerPostings = (await pool.query(`SELECT p.* FROM ledger_postings p JOIN ledger_entries e ON e.id=p.ledger_entry_id WHERE e.scope_id=$1 ORDER BY p.id`, [scopeId])).rows;
  rows.ledgerLinks = (await pool.query(`SELECT l.* FROM ledger_source_links l JOIN ledger_entries e ON e.id=l.ledger_entry_id WHERE e.scope_id=$1 ORDER BY l.id`, [scopeId])).rows;
  rows.supersessions = (await pool.query('SELECT * FROM ledger_entry_supersessions WHERE scope_id=$1 ORDER BY id', [scopeId])).rows;
  rows.certificationFacts = (await pool.query('SELECT * FROM certification_facts WHERE scope_id=$1 ORDER BY id', [scopeId])).rows;
  return rows;
}

integration('strict migration 025 preserves existing synthetic FNS-only and matched-purchase accounting data', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const migrationsDir = await migrationsThrough024();
  let runnerMigrations;
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrate(pool, migrationsDir);

    const standalone = await createFixture(pool, 'migration-025-fns-only', { amount: '14.25', standalone: true });
    const matched = await createFixture(pool, 'migration-025-matched', { amount: '27.80', standalone: true });
    await seedLegacyMatchedPurchase(pool, matched, '27.80');
    const beforeStandalone = await snapshotScope(pool, standalone.scopeId);
    const beforeMatched = await snapshotScope(pool, matched.scopeId);
    assert.equal(beforeStandalone.ledgerEntries.some(row => row.derivation_rule === 'LEDGER_STANDALONE_PURCHASE_V1'), true);
    assert.equal(beforeMatched.matches.length, 1);
    assert.equal(beforeMatched.bankEvidence.length, 1);

    runnerMigrations = await migrationsThrough025();
    const result = await migrateBankOnly025(pool, runnerMigrations);
    assert.deepEqual(result.applied, [BANK_ONLY_MIGRATION_025]);
    assert.deepEqual(await snapshotScope(pool, standalone.scopeId), beforeStandalone);
    assert.deepEqual(await snapshotScope(pool, matched.scopeId), beforeMatched);
    const expandedEvidence = (await pool.query(`SELECT bank_transaction_id,financial_account_id,evidence_snapshot,evidence_sha256
      FROM business_event_bank_evidence WHERE scope_id=$1 AND bank_receipt_match_id IS NOT NULL`, [matched.scopeId])).rows;
    assert.equal(expandedEvidence.length, 1);
    assert.deepEqual(expandedEvidence[0], {
      bank_transaction_id: null,
      financial_account_id: null,
      evidence_snapshot: null,
      evidence_sha256: null,
    });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations WHERE filename=$1', [BANK_ONLY_MIGRATION_025])).rows[0].count, 1);
  } finally {
    await pool.end();
    await rm(migrationsDir, { recursive: true, force: true });
    if (runnerMigrations) await rm(runnerMigrations, { recursive: true, force: true });
  }
});

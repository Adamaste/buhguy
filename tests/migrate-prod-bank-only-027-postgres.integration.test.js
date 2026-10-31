import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { assertDisposableLocalTestDatabase } from '../scripts/assert-disposable-local-test-database.js';
import { BANK_ONLY_MIGRATION_027, migrateBankOnly027 } from '../scripts/migrate-prod-bank-only-027.mjs';
import { migrate } from '../src/database.js';
import { runBankOnlyPurchaseCatchup } from '../src/bank-only-purchase.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDisposableLocalTestDatabase(databaseUrl);
const integration = databaseUrl ? test : test.skip;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function migrationsThrough025() {
  const source = new URL('../db/migrations/', import.meta.url);
  const names = (await readdir(source)).filter(name => name.endsWith('.sql') && name < BANK_ONLY_MIGRATION_027).sort();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buhguy-bank-only-027-stage-'));
  for (const name of names) await copyFile(new URL(name, source), path.join(directory, name));
  return directory;
}

function runtimeRolePool(adminPool) {
  return {
    query: (...args) => adminPool.query(...args),
    async connect() {
      const client = await adminPool.connect();
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
}

async function seedEligiblePurchase(pool) {
  const suffix = `${process.pid}-${Date.now()}`;
  const scopeKey = `bank-only-027-${suffix}`;
  const scopeId = Number((await pool.query('INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id', [scopeKey, 'Synthetic migration regression'])).rows[0].id);
  const personId = Number((await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scopeId, `${scopeKey}-person`, 'Synthetic owner'])).rows[0].id);
  const accountId = Number((await pool.query("INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency) VALUES($1,'Synthetic bank','bank.example',$2,'RUB') RETURNING id", [scopeId, `${scopeKey}-account`])).rows[0].id);
  await pool.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES($1,$2,'OWNER','USER_CONFIRMED','synthetic integration fixture')", [accountId, personId]);
  const sourceId = Number((await pool.query("INSERT INTO bank_sources(source_key,source_type,display_name) VALUES($1,'ANDROID_NOTIFICATION','Synthetic bank source') RETURNING id", [`${scopeKey}-source`])).rows[0].id);
  await pool.query("INSERT INTO bank_source_person(bank_source_id,person_id,relation_type) VALUES($1,$2,'OWNER')", [sourceId, personId]);
  await pool.query(`INSERT INTO bank_source_provider_account_bindings(bank_source_id,provider,financial_account_id,provenance,reason)
    VALUES($1,'bank.example',$2,'USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT','synthetic integration fixture')`, [sourceId, accountId]);
  const now = new Date();
  const observedAt = new Date(now.getTime() - 20000).toISOString();
  const occurredAt = new Date(now.getTime() - 30000).toISOString();
  const observationId = Number((await pool.query(`INSERT INTO bank_event_observations(bank_source_id,dedup_key,observed_at,event_time,payload,payload_sha256,ingestion_metadata,created_at)
    VALUES($1,$2,$3,$4,'{}',$5,$6::jsonb,$3) RETURNING id`, [sourceId, digest(`${scopeKey}:dedup`), observedAt, occurredAt,
    digest(`${scopeKey}:payload`), JSON.stringify({ provider: 'bank.example' })])).rows[0].id);
  const bankTransactionId = Number((await pool.query(`INSERT INTO bank_transactions(observation_id,occurred_at,amount,currency,direction,merchant,event_type,normalization_status,normalization_version,evidence_quality)
    VALUES($1,$2,'83.41','RUB','DEBIT','Synthetic merchant','PURCHASE','READY','synthetic-v1','EXACT') RETURNING id`, [observationId, occurredAt])).rows[0].id);
  await pool.query(`INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason)
    VALUES($1,$2,'MANUAL','USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT','synthetic integration fixture')`, [bankTransactionId, accountId]);
  return { bankTransactionId, scopeId, scopeKey, now };
}

integration('027 grants only required columns and lets bounded catch-up retry a previously failed bank-only purchase', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const previousMigrations = await migrationsThrough025();
  try {
    const role = await pool.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='receipt_collector'");
    if (!role.rowCount) await pool.query('CREATE ROLE receipt_collector NOLOGIN');
    else assert.equal(role.rows[0].rolcanlogin, false);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO receipt_collector');
    await migrate(pool, previousMigrations);
    const before = (await pool.query(`SELECT has_column_privilege('receipt_collector','public.bank_transactions','merchant','SELECT') AS merchant,
      has_column_privilege('receipt_collector','public.business_events','created_at','SELECT') AS event_created_at,
      has_column_privilege('receipt_collector','public.business_event_edges','relation_type','SELECT') AS edge_relation_type,
      has_column_privilege('receipt_collector','public.business_event_allocations','allocated_amount','SELECT') AS allocation_amount,
      has_column_privilege('receipt_collector','public.ledger_source_links','graph_allocation_id','INSERT') AS graph_allocation_insert,
      has_table_privilege('receipt_collector','public.bank_transactions','SELECT') AS transactions_table_select,
      has_table_privilege('receipt_collector','public.business_events','SELECT') AS events_table_select`)).rows[0];
    assert.deepEqual(before, { merchant: false, event_created_at: false, edge_relation_type: false, allocation_amount: false, graph_allocation_insert: false, transactions_table_select: false, events_table_select: false });

    const fixture = await seedEligiblePurchase(pool);
    const runtime = runtimeRolePool(pool);
    const optIn = {
      enabled: true,
      scopeKey: fixture.scopeKey,
      startAt: new Date(fixture.now.getTime() - 60000).toISOString(),
      alfaStartAt: null,
      maxWrites: 25,
    };
    const itemLogs = [];
    const failed = await runBankOnlyPurchaseCatchup(runtime, {
      scopeKey: fixture.scopeKey, optIn, now: fixture.now,
      logger: {
        info: (event, fields) => itemLogs.push({ event, fields }),
        warn: (event, fields) => itemLogs.push({ event, fields }),
        error: (event, fields) => itemLogs.push({ event, fields }),
      },
    });
    assert.equal(failed.status, 'ERROR', JSON.stringify({ failed, itemLogs }));
    assert.equal(failed.examined, 1);
    assert.equal(failed.errors, 1);
    const failedItem = itemLogs.find(item => item.event === 'bank_only_purchase_catchup_item');
    assert.deepEqual(failedItem.fields, { bankTransactionId: fixture.bankTransactionId, status: 'ERROR', reasonCode: '42501' });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM business_event_bank_evidence WHERE bank_transaction_id=$1', [fixture.bankTransactionId])).rows[0].count, 0);

    const applied = await migrateBankOnly027(pool);
    assert.deepEqual(applied.applied, [BANK_ONLY_MIGRATION_027]);
    const after = (await pool.query(`SELECT has_column_privilege('receipt_collector','public.bank_transactions','merchant','SELECT') AS merchant,
      has_column_privilege('receipt_collector','public.bank_transactions','counterparty','SELECT') AS counterparty,
      has_column_privilege('receipt_collector','public.business_events','created_at','SELECT') AS event_created_at,
      has_column_privilege('receipt_collector','public.business_event_edges','relation_type','SELECT') AS edge_relation_type,
      has_column_privilege('receipt_collector','public.business_event_allocations','allocated_amount','SELECT') AS allocation_amount,
      has_column_privilege('receipt_collector','public.ledger_source_links','graph_allocation_id','INSERT') AS graph_allocation_insert,
      has_table_privilege('receipt_collector','public.bank_transactions','SELECT') AS transactions_table_select,
      has_table_privilege('receipt_collector','public.business_events','SELECT') AS events_table_select,
      has_table_privilege('receipt_collector','public.business_event_edges','SELECT') AS edges_table_select,
      has_table_privilege('receipt_collector','public.business_event_allocations','SELECT') AS allocations_table_select,
      has_column_privilege('receipt_collector','public.ledger_entries','derivation_status','UPDATE') AS ledger_update,
      has_column_privilege('receipt_collector','public.ledger_postings','source_allocation_id','INSERT') AS posting_source_allocation_insert`)).rows[0];
    assert.deepEqual(after, { merchant: true, counterparty: false, event_created_at: true, edge_relation_type: true, allocation_amount: true, graph_allocation_insert: true,
      transactions_table_select: false, events_table_select: false, edges_table_select: false, allocations_table_select: false, ledger_update: false, posting_source_allocation_insert: false });

    const recoveredLogs = [];
    const recovered = await runBankOnlyPurchaseCatchup(runtime, {
      scopeKey: fixture.scopeKey, optIn, now: fixture.now,
      logger: {
        info: (event, fields) => recoveredLogs.push({ event, fields }),
        warn: (event, fields) => recoveredLogs.push({ event, fields }),
        error: (event, fields) => recoveredLogs.push({ event, fields }),
      },
    });
    assert.equal(recovered.status, 'COMPLETED', JSON.stringify({ recovered, recoveredLogs }));
    assert.equal(recovered.persisted, 1);
    assert.equal(recovered.errors, 0);
    const replay = await runBankOnlyPurchaseCatchup(runtime, {
      scopeKey: fixture.scopeKey, optIn, now: fixture.now, logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(replay.examined, 0);
    const ledger = await pool.query(`SELECT count(*)::int AS count FROM ledger_entries entry
      JOIN ledger_source_links link ON link.ledger_entry_id=entry.id
      WHERE link.bank_transaction_id=$1 AND entry.derivation_rule='LEDGER_BANK_ONLY_PURCHASE_V1'
        AND NOT EXISTS (SELECT 1 FROM ledger_entry_supersessions ss
          WHERE ss.scope_id=entry.scope_id AND ss.superseded_ledger_entry_id=entry.id)`, [fixture.bankTransactionId]);
    assert.equal(ledger.rows[0].count, 1);
  } finally {
    await rm(previousMigrations, { recursive: true, force: true });
    await pool.end();
  }
});

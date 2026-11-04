import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { assertDisposableLocalTestDatabase } from '../scripts/assert-disposable-local-test-database.js';
import { PREPAYMENT_MIGRATION_028, PREPAYMENT_MIGRATION_028_SHA256, migratePrepayment028 } from '../scripts/migrate-prod-prepayment-028.mjs';
import { migrate } from '../src/database.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  test('PostgreSQL integration environment is required', { skip: 'TEST_DATABASE_URL is not set; use npm run test:integration' }, () => {});
} else {
  assertDisposableLocalTestDatabase(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const migrationsDir = path.resolve('db/migrations');
  let priorOnlyDir;
  let conflictDir;
  let createdRole = false;

  async function stagePriorMigrations() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'buhguy-prepayment-028-prior-'));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql') && file < PREPAYMENT_MIGRATION_028).sort();
    for (const file of files) await copyFile(path.join(migrationsDir, file), path.join(directory, file));
    return directory;
  }

  async function resetTo027() {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrate(pool, priorOnlyDir);
    await pool.query('GRANT USAGE ON SCHEMA public TO receipt_collector');
  }

  before(async () => {
    const role = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='receipt_collector'");
    if (!role.rowCount) {
      await pool.query('CREATE ROLE receipt_collector NOLOGIN');
      createdRole = true;
    }
    priorOnlyDir = await stagePriorMigrations();
  });

  after(async () => {
    try {
      if (createdRole) {
        await pool.query('DROP OWNED BY receipt_collector');
        await pool.query('DROP ROLE receipt_collector');
      }
    } finally {
      await Promise.all([priorOnlyDir, conflictDir].filter(Boolean).map((directory) => rm(directory, { recursive: true, force: true })));
      await pool.end();
    }
  });

  test('028 applies when 026 is absent, grants only required columns, and rejects an unexpected 026 gap', { concurrency: false }, async () => {
    const migrationBytes = await readFile(path.join(migrationsDir, PREPAYMENT_MIGRATION_028));
    const canonical = Buffer.from(migrationBytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
    assert.equal(createHash('sha256').update(canonical).digest('hex'), PREPAYMENT_MIGRATION_028_SHA256);

    await resetTo027();
    const applied = await migratePrepayment028(pool, migrationsDir);
    assert.deepEqual(applied.applied, [PREPAYMENT_MIGRATION_028]);
    const grants = (await pool.query(`SELECT
      has_column_privilege('receipt_collector','public.receipts','operation_type','SELECT') AS receipt_operation_type,
      has_column_privilege('receipt_collector','public.receipt_source_observations','observed_at','SELECT') AS receipt_observed_at,
      has_column_privilege('receipt_collector','public.receipts','seller_inn','SELECT') AS receipt_seller,
      has_column_privilege('receipt_collector','public.receipt_items','position','SELECT') AS item_position,
      has_column_privilege('receipt_collector','public.receipt_item_fiscal_facts','raw_product_code','SELECT') AS item_code,
      has_column_privilege('receipt_collector','public.business_event_bank_evidence','evidence_snapshot','INSERT') AS evidence_insert,
      has_column_privilege('receipt_collector','public.business_event_bank_evidence','evidence_snapshot','UPDATE') AS evidence_update,
      has_column_privilege('receipt_collector','public.business_graph_rules','rule_code','SELECT') AS graph_rule_key_select,
      has_column_privilege('receipt_collector','public.business_graph_rules','description','UPDATE') AS graph_rule_description_update,
      has_column_privilege('receipt_collector','public.business_graph_rules','rule_code','UPDATE') AS graph_rule_key_update,
      has_column_privilege('receipt_collector','public.business_events','description','UPDATE') AS event_description_update,
      has_column_privilege('receipt_collector','public.business_events','semantic_key','UPDATE') AS event_key_update,
      has_column_privilege('receipt_collector','public.business_event_edges','id','SELECT') AS edge_id_select,
      has_column_privilege('receipt_collector','public.business_event_edges','semantic_key','SELECT') AS edge_key_select,
      has_column_privilege('receipt_collector','public.business_event_edges','explanation','INSERT') AS edge_insert,
      has_column_privilege('receipt_collector','public.business_event_evidence','receipt_item_id','INSERT') AS evidence_item_insert,
      has_column_privilege('receipt_collector','public.business_event_allocations','id','SELECT') AS allocation_id_select,
      has_column_privilege('receipt_collector','public.business_event_allocations','semantic_key','SELECT') AS allocation_key_select,
      has_column_privilege('receipt_collector','public.business_event_allocations','explanation','INSERT') AS allocation_insert,
      has_column_privilege('receipt_collector','public.ledger_entries','description','UPDATE') AS ledger_description_update,
      has_column_privilege('receipt_collector','public.ledger_entries','derivation_status','UPDATE') AS ledger_status_update,
      has_column_privilege('receipt_collector','public.ledger_postings','source_allocation_id','INSERT') AS posting_allocation_insert,
      has_table_privilege('receipt_collector','public.business_event_edges','UPDATE') AS edge_table_update,
      has_table_privilege('receipt_collector','public.business_event_allocations','UPDATE') AS allocation_table_update,
      has_table_privilege('receipt_collector','public.ledger_entries','UPDATE') AS ledger_table_update,
      has_sequence_privilege('receipt_collector','public.business_event_edges_id_seq','USAGE') AS edge_sequence_usage,
      has_sequence_privilege('receipt_collector','public.business_event_allocations_id_seq','USAGE') AS allocation_sequence_usage,
      has_table_privilege('receipt_collector','public.receipts','SELECT') AS receipts_table_select`)).rows[0];
    assert.deepEqual(grants, { receipt_operation_type: true, receipt_observed_at: true, receipt_seller: true,
      item_position: true, item_code: true, evidence_insert: true, evidence_update: false,
      graph_rule_key_select: true, graph_rule_description_update: true, graph_rule_key_update: false,
      event_description_update: true, event_key_update: false,
      edge_id_select: true, edge_key_select: true, edge_insert: true,
      evidence_item_insert: true,
      allocation_id_select: true, allocation_key_select: true, allocation_insert: true,
      ledger_description_update: true, ledger_status_update: true,
      posting_allocation_insert: true,
      edge_table_update: false, allocation_table_update: false, ledger_table_update: false,
      edge_sequence_usage: true, allocation_sequence_usage: true, receipts_table_select: false });
    const ledger = (await pool.query('SELECT filename FROM schema_migrations WHERE filename=$1', [PREPAYMENT_MIGRATION_028])).rows;
    assert.equal(ledger.length, 1);

    await resetTo027();
    conflictDir = await mkdtemp(path.join(os.tmpdir(), 'buhguy-prepayment-028-gap-'));
    for (const file of await readdir(priorOnlyDir)) await copyFile(path.join(priorOnlyDir, file), path.join(conflictDir, file));
    await copyFile(path.join(migrationsDir, PREPAYMENT_MIGRATION_028), path.join(conflictDir, PREPAYMENT_MIGRATION_028));
    await writeFile(path.join(conflictDir, '026_unmerged_history.sql'), 'SELECT 1;\n', 'utf8');
    await assert.rejects(() => migratePrepayment028(pool, conflictDir), (error) => error.code === 'MIGRATION_PENDING_SET_MISMATCH');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations WHERE filename=$1', [PREPAYMENT_MIGRATION_028])).rows[0].count, 0);
  });
}

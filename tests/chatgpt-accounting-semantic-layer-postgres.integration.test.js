import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration('Bank Assistant semantic views are transaction-grain and read-only', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const semanticSql = await fs.readFile(new URL('../db/analytics/010_chatgpt_accounting_semantic_layer.sql', import.meta.url), 'utf8');
  let sourceId;
  let observationIds = [];
  let accountIds = [];
  try {
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chatgpt_reader') THEN
        CREATE ROLE chatgpt_reader NOLOGIN;
      END IF;
    END $$`);
    await pool.query(semanticSql);

    const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
    const persons = (await pool.query(
      "INSERT INTO persons(scope_id, person_key, display_name) VALUES ($1,'semantic-test-person-a','Synthetic A'),($1,'semantic-test-person-b','Synthetic B') RETURNING id",
      [scope.id],
    )).rows;
    sourceId = (await pool.query(
      "INSERT INTO bank_sources(source_key, source_type, display_name) VALUES ('semantic-test-sber-source','ANDROID_NOTIFICATION','Synthetic Sber semantic source') RETURNING id",
    )).rows[0].id;
    await pool.query("INSERT INTO bank_source_person(bank_source_id, person_id, relation_type) VALUES ($1,$2,'OWNER'),($1,$3,'OWNER')", [sourceId, persons[0].id, persons[1].id]);

    for (const [amount, resolution] of [['100.00', 'EXACT'], ['50.00', 'UNKNOWN']]) {
      const observation = (await pool.query(
        `INSERT INTO bank_event_observations
          (bank_source_id, source_event_id, dedup_key, observed_at, event_time, payload, payload_sha256, ingestion_metadata)
         VALUES ($1, $2, repeat('a', 64), NOW(), NOW(), '{}'::jsonb, repeat('a',64), '{"adapter":"android-notification","provider":"ru.sberbankmobile","schemaVersion":"1"}')
         RETURNING id`, [sourceId, `semantic-${amount}`],
      )).rows[0];
      observationIds.push(observation.id);
      const tx = (await pool.query(
        `INSERT INTO bank_transactions
          (observation_id, occurred_at, amount, currency, direction, normalization_status, normalization_version, evidence_quality, event_type)
         VALUES ($1, NOW(), $2, 'RUB', 'CREDIT', $3, 'sber-bank-normalizer-v3', 'EXACT', 'INCOMING_TRANSFER')
         RETURNING id`, [observation.id, amount, resolution === 'EXACT' ? 'READY' : 'UNKNOWN'],
      )).rows[0];
      if (resolution === 'EXACT') {
        const account = (await pool.query(
          "INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency) VALUES ($1,'Synthetic Bank','synthetic.test','Synthetic account','RUB') RETURNING id",
          [scope.id],
        )).rows[0];
        accountIds.push(account.id);
        await pool.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES ($1,$2,'OWNER','SYNTHETIC','Synthetic semantic test')", [account.id, persons[0].id]);
        await pool.query("INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES ($1,$2,'EXACT','OBSERVED_PROVIDER_REFERENCE','Synthetic semantic test')", [tx.id, account.id]);
      }
    }

    const rows = (await pool.query("SELECT id, provider, adapter, schema_version, normalization_version, event_type, direction, amount, currency, account_resolution_state, financial_account_id, source_context_person_ids FROM chatgpt_accounting.bank_transactions WHERE source_key='semantic-test-sber-source' ORDER BY id")).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].account_resolution_state, 'EXACT');
    assert.ok(rows[0].financial_account_id);
    assert.equal(rows[0].provider, 'ru.sberbankmobile');
    assert.equal(rows[0].adapter, 'android-notification');
    assert.equal(rows[0].schema_version, '1');
    assert.equal(rows[0].normalization_version, 'sber-bank-normalizer-v3');
    assert.equal(rows[0].event_type, 'INCOMING_TRANSFER');
    assert.equal(rows[0].direction, 'CREDIT');
    assert.equal(rows[0].currency, 'RUB');
    assert.deepEqual(rows[0].source_context_person_ids.map(Number).sort((a, b) => a - b), persons.map((p) => Number(p.id)).sort((a, b) => a - b));
    assert.equal(rows[1].account_resolution_state, 'UNKNOWN');
    assert.equal(rows[1].financial_account_id, null);

    const grants = (await pool.query(`SELECT
      has_table_privilege('chatgpt_reader','chatgpt_accounting.bank_transactions','SELECT') AS semantic_select,
      has_table_privilege('chatgpt_reader','public.bank_transactions','SELECT') AS source_select,
      has_table_privilege('chatgpt_reader','public.bank_transactions','INSERT') AS source_insert`)).rows[0];
    assert.equal(grants.semantic_select, true);
    assert.equal(grants.source_select, false);
    assert.equal(grants.source_insert, false);
  } finally {
    await pool.query('DROP SCHEMA IF EXISTS chatgpt_accounting CASCADE').catch(() => {});
    if (observationIds.length) await pool.query('DELETE FROM bank_transactions WHERE observation_id = ANY($1::bigint[])', [observationIds]).catch(() => {});
    if (observationIds.length) await pool.query('DELETE FROM bank_event_observations WHERE id = ANY($1::bigint[])', [observationIds]).catch(() => {});
    if (accountIds.length) await pool.query('DELETE FROM financial_accounts WHERE id = ANY($1::bigint[])', [accountIds]).catch(() => {});
    if (sourceId) await pool.query('DELETE FROM bank_sources WHERE id=$1', [sourceId]).catch(() => {});
    await pool.query("DELETE FROM persons WHERE person_key IN ('semantic-test-person-a','semantic-test-person-b')").catch(() => {});
    await pool.end();
  }
});

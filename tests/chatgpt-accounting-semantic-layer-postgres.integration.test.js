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
  let instrumentIds = [];
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

    for (const [amount, resolution, direction] of [['100.00', 'EXACT', 'CREDIT'], ['50.00', 'UNKNOWN', 'DEBIT']]) {
      const observation = (await pool.query(
        `INSERT INTO bank_event_observations
          (bank_source_id, source_event_id, dedup_key, observed_at, event_time, payload, payload_sha256, ingestion_metadata)
         VALUES ($1, $2, md5($2) || md5($2), NOW(), NOW(), '{}'::jsonb, repeat('a',64), '{"adapter":"android-notification","provider":"ru.sberbankmobile","schemaVersion":"1"}')
         RETURNING id`, [sourceId, `semantic-${amount}`],
      )).rows[0];
      observationIds.push(observation.id);
      const tx = (await pool.query(
        `INSERT INTO bank_transactions
          (observation_id, occurred_at, amount, currency, direction, normalization_status, normalization_version, evidence_quality, event_type)
       VALUES ($1, NOW(), $2, 'RUB', $4, $3, 'sber-bank-normalizer-v3', 'EXACT', 'INCOMING_TRANSFER')
         RETURNING id`, [observation.id, amount, resolution === 'EXACT' ? 'READY' : 'UNKNOWN', direction],
      )).rows[0];
      if (resolution === 'EXACT') {
        const account = (await pool.query(
          "INSERT INTO financial_accounts(scope_id,institution,provider,display_name,currency) VALUES ($1,'Synthetic Bank','synthetic.test','Synthetic account','RUB') RETURNING id",
          [scope.id],
        )).rows[0];
        accountIds.push(account.id);
        await pool.query("INSERT INTO financial_account_person_relations(financial_account_id,person_id,relation_type,provenance,reason) VALUES ($1,$2,'OWNER','SYNTHETIC','Synthetic semantic test'),($1,$3,'AUTHORIZED_USER','SYNTHETIC','Synthetic semantic test')", [account.id, persons[0].id, persons[1].id]);
        await pool.query("INSERT INTO bank_transaction_account_resolution(bank_transaction_id,financial_account_id,resolution_state,provenance,reason) VALUES ($1,$2,'EXACT','OBSERVED_PROVIDER_REFERENCE','Synthetic semantic test')", [tx.id, account.id]);
      }
    }

    const instrument = (await pool.query(
      "INSERT INTO payment_instruments(scope_id,financial_account_id,instrument_type,provider,display_name) VALUES ($1,NULL,'CARD','ru.sberbankmobile','Synthetic standalone card') RETURNING id",
      [scope.id],
    )).rows[0];
    instrumentIds.push(instrument.id);
    const cardObservation = (await pool.query(
      `INSERT INTO bank_event_observations
        (bank_source_id, source_event_id, dedup_key, observed_at, event_time, payload, payload_sha256, ingestion_metadata)
       VALUES ($1, 'semantic-card', md5('semantic-card') || md5('semantic-card'), NOW(), NOW(), '{}'::jsonb, repeat('b',64), '{"adapter":"android-notification","provider":"ru.sberbankmobile","schemaVersion":"1"}')
       RETURNING id`, [sourceId],
    )).rows[0];
    observationIds.push(cardObservation.id);
    const cardTransaction = (await pool.query(
      `INSERT INTO bank_transactions
        (observation_id, occurred_at, amount, currency, direction, normalization_status, normalization_version, evidence_quality, event_type)
       VALUES ($1, NOW(), 10.00, 'RUB', 'DEBIT', 'UNKNOWN', 'sber-bank-normalizer-v3', 'EXACT', 'UNKNOWN')
       RETURNING id`, [cardObservation.id],
    )).rows[0];
    await pool.query("INSERT INTO payment_instrument_person_relations(payment_instrument_id,person_id,relation_type,provenance,reason) VALUES ($1,$2,'OWNER','SYNTHETIC','Synthetic card-only test'),($1,$3,'AUTHORIZED_USER','SYNTHETIC','Synthetic card-only test')", [instrument.id, persons[0].id, persons[1].id]);
    await pool.query("INSERT INTO bank_transaction_payment_instrument_resolution(bank_transaction_id,payment_instrument_id,resolution_state,provenance,reason) VALUES ($1,$2,'EXACT','OBSERVED_PROVIDER_REFERENCE','Synthetic card-only test')", [cardTransaction.id, instrument.id]);

    const rows = (await pool.query("SELECT id, provider, adapter, schema_version, normalization_version, event_type, direction, amount, currency, account_resolution_state, financial_account_id, financial_account_owner_person_ids, financial_account_authorized_user_person_ids, payment_instrument_resolution_state, payment_instrument_id, payment_instrument_owner_person_ids, payment_instrument_authorized_user_person_ids, source_context_person_ids FROM chatgpt_accounting.bank_transactions WHERE source_display_name='Synthetic Sber semantic source' ORDER BY id")).rows;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].account_resolution_state, 'EXACT');
    assert.ok(rows[0].financial_account_id);
    assert.equal(rows[0].provider, 'ru.sberbankmobile');
    assert.equal(rows[0].adapter, 'android-notification');
    assert.equal(rows[0].schema_version, '1');
    assert.equal(rows[0].normalization_version, 'sber-bank-normalizer-v3');
    assert.equal(rows[0].event_type, 'INCOMING_TRANSFER');
    assert.equal(rows[0].direction, 'CREDIT');
    assert.equal(rows[0].currency, 'RUB');
    assert.deepEqual(rows[0].financial_account_owner_person_ids.map(Number), [Number(persons[0].id)]);
    assert.deepEqual(rows[0].financial_account_authorized_user_person_ids.map(Number), [Number(persons[1].id)]);
    assert.deepEqual(rows[0].source_context_person_ids.map(Number).sort((a, b) => a - b), persons.map((p) => Number(p.id)).sort((a, b) => a - b));
    assert.equal(rows[1].account_resolution_state, 'UNKNOWN');
    assert.equal(rows[1].financial_account_id, null);
    assert.equal(rows[1].direction, 'DEBIT');
    assert.equal(rows[2].account_resolution_state, 'UNKNOWN');
    assert.equal(rows[2].financial_account_id, null);
    assert.equal(rows[2].payment_instrument_resolution_state, 'EXACT');
    assert.ok(rows[2].payment_instrument_id);
    assert.deepEqual(rows[2].payment_instrument_owner_person_ids.map(Number), [Number(persons[0].id)]);
    assert.deepEqual(rows[2].payment_instrument_authorized_user_person_ids.map(Number), [Number(persons[1].id)]);

    const grants = (await pool.query(`SELECT
      has_table_privilege('chatgpt_reader','chatgpt_accounting.bank_transactions','SELECT') AS semantic_select,
      object_name,
      has_table_privilege('chatgpt_reader', object_name, 'SELECT') AS source_select,
      has_table_privilege('chatgpt_reader', object_name, 'INSERT') AS source_insert,
      has_table_privilege('chatgpt_reader', object_name, 'UPDATE') AS source_update,
      has_table_privilege('chatgpt_reader', object_name, 'DELETE') AS source_delete
      FROM unnest(ARRAY[
        'public.bank_event_observations','public.bank_transactions','public.bank_sources',
        'public.bank_source_person','public.bank_transaction_account_resolution',
        'public.bank_transaction_payment_instrument_resolution','public.financial_accounts',
        'public.financial_account_person_relations','public.payment_instruments',
        'public.payment_instrument_person_relations','public.bank_account_references'
      ]::text[]) AS object_name`)).rows;
    assert.equal(grants.every((row) => row.semantic_select === true), true);
    assert.equal(grants.every((row) => row.source_select === false && row.source_insert === false && row.source_update === false && row.source_delete === false), true);
  } finally {
    await pool.query('DROP SCHEMA IF EXISTS chatgpt_accounting CASCADE').catch(() => {});
    if (observationIds.length) await pool.query('DELETE FROM bank_transactions WHERE observation_id = ANY($1::bigint[])', [observationIds]).catch(() => {});
    if (observationIds.length) await pool.query('DELETE FROM bank_event_observations WHERE id = ANY($1::bigint[])', [observationIds]).catch(() => {});
    if (instrumentIds.length) await pool.query('DELETE FROM payment_instruments WHERE id = ANY($1::bigint[])', [instrumentIds]).catch(() => {});
    if (accountIds.length) await pool.query('DELETE FROM financial_accounts WHERE id = ANY($1::bigint[])', [accountIds]).catch(() => {});
    if (sourceId) await pool.query('DELETE FROM bank_sources WHERE id=$1', [sourceId]).catch(() => {});
    await pool.query("DELETE FROM persons WHERE person_key IN ('semantic-test-person-a','semantic-test-person-b')").catch(() => {});
    await pool.end();
  }
});

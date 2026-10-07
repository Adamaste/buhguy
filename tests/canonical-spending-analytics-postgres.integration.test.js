import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
let pool;
const minorUnits = (value) => {
  const text = String(value);
  const negative = text.startsWith('-');
  const absolute = negative ? text.slice(1) : text;
  const [whole, fraction = '00'] = absolute.split('.');
  const units = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -units : units;
};
const money = (minor) => {
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};

async function applyAnalyticsArtifact() {
  await pool.query(await fs.readFile(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
}

before(async () => {
  if (databaseUrl) pool = new pg.Pool({ connectionString: databaseUrl });
});

after(async () => { await pool?.end(); });

integration('canonical spending analytics is fan-out-safe, snapshot-qualified, and exactly reconcilable', async () => {
  await applyAnalyticsArtifact();
  const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
  const initial = (await pool.query(`SELECT f.*, r.model_version
    FROM certification_facts f JOIN reconciliation_runs r ON r.id=f.run_id
    WHERE f.scope_id=$1 AND f.metric_code='CONFIRMED_ACQUISITION_VALUE' AND f.status='CERTIFIED'
    ORDER BY f.id LIMIT 1`, [scope.id])).rows[0];
  assert.ok(initial);
  const receipt = (await pool.query(`SELECT receipt_id
    FROM business_event_evidence
    WHERE event_id=$1 AND receipt_id IS NOT NULL
    ORDER BY id LIMIT 1`, [initial.business_event_id])).rows[0];
  assert.ok(receipt);

  const secondPerson = (await pool.query(`INSERT INTO persons(scope_id,person_key,display_name)
    VALUES($1,'analytics-fanout-person','Analytics Fanout Person') RETURNING id`, [scope.id])).rows[0];
  const source = (await pool.query("SELECT id FROM fns_sources WHERE scope_id=$1 ORDER BY id LIMIT 1", [scope.id])).rows[0];
  await pool.query(`INSERT INTO receipt_source_observations(receipt_id,fns_source_id,source_receipt_id)
    VALUES($1,$2,'canonical-spending-fanout-source')
    ON CONFLICT DO NOTHING`, [receipt.receipt_id, source.id]);
  await pool.query('INSERT INTO fns_source_person(fns_source_id,person_id) VALUES($1,$2)', [source.id, secondPerson.id]);
  const provenance = await pool.query(`SELECT count(*)::int AS rows, count(DISTINCT p.person_id)::int AS persons
    FROM receipt_source_observations o JOIN fns_source_person p ON p.fns_source_id=o.fns_source_id
    WHERE o.receipt_id=$1`, [receipt.receipt_id]);
  assert.ok(provenance.rows[0].rows >= 2);
  assert.ok(provenance.rows[0].persons >= 2);

  const snapshotKey = 'b'.repeat(64);
  const secondRun = (await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,finished_at)
    VALUES($1,$2,$3,'READY',NOW()) RETURNING id`, [scope.id, initial.model_version, snapshotKey])).rows[0];
  await pool.query(`INSERT INTO certification_facts(
      run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key)
    SELECT $1,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,
      repeat(md5(semantic_key || 'snapshot-b'),2),$2
    FROM certification_facts WHERE id=$3`, [secondRun.id, snapshotKey, initial.id]);

  const rule = (await pool.query('SELECT rule_code,rule_version FROM business_graph_rules ORDER BY rule_code,rule_version LIMIT 1')).rows[0];
  const returnEvent = (await pool.query(`INSERT INTO business_events(
      scope_id,event_type,resolution_status,origin,graph_model_version,rule_code,rule_version,semantic_key,amount,currency,description)
    VALUES($1,'RETURN','CONFIRMED','SYSTEM_DERIVED','canonical-analytics-v1',$2,$3,$4,0.10,'RUB','unlinked certified return fixture') RETURNING id`, [scope.id, rule.rule_code, rule.rule_version, 'r'.repeat(64)])).rows[0];
  await pool.query(`INSERT INTO certification_facts(
      run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,business_event_id,semantic_key,source_state_key)
    VALUES($1,$2,'BUSINESS_EVENT',$3,'CONFIRMED_RETURN_VALUE','BUSINESS_CERTIFICATION','CERTIFIED',0.10,'RUB',NOW(),
      'BUSINESS_GRAPH_CONFIRMED',$4,$5,$3,$6,$7)`, [secondRun.id, scope.id, returnEvent.id, rule.rule_code, rule.rule_version, 'c'.repeat(64), snapshotKey]);

  await pool.query(`INSERT INTO business_event_evidence(
      event_id,receipt_id,normalization_version,evidence_role,origin,graph_model_version,rule_code,rule_version,semantic_key)
    VALUES($1,$2,'fiscal-normalizer-v1','MATCHED_PURCHASE_EVIDENCE','SYSTEM_DERIVED','canonical-analytics-v1',$3,$4,$5)`,
  [initial.business_event_id, receipt.receipt_id, rule.rule_code, rule.rule_version, 'e'.repeat(64)]);

  const snapshots = (await pool.query(`SELECT source_state_key,count(*)::int AS count
    FROM canonical_spending_purchases_v1 WHERE scope_id=$1 GROUP BY source_state_key ORDER BY source_state_key`, [scope.id])).rows;
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map((row) => row.count), [1, 1]);
  const chosenPurchase = (await pool.query(`SELECT * FROM canonical_spending_purchases_v1
    WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, snapshotKey])).rows;
  assert.equal(chosenPurchase.length, 1);
  const household = (await pool.query(`SELECT gross_spend::text,confirmed_returns::text,net_spend::text
    FROM canonical_spending_household_summary_v1 WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, snapshotKey])).rows[0];
  assert.equal(household.gross_spend, chosenPurchase[0].amount);
  assert.equal(household.confirmed_returns, '0.10');
  assert.equal(household.net_spend, money(minorUnits(chosenPurchase[0].amount) - 10n));

  const category = (await pool.query(`SELECT category_code,gross_spend::text,confirmed_returns::text,net_spend::text
    FROM canonical_spending_category_summary_v1 WHERE scope_id=$1 AND source_state_key=$2 ORDER BY category_code`, [scope.id, snapshotKey])).rows;
  assert.ok(category.some((row) => row.category_code === 'UNCLASSIFIED' && row.gross_spend === chosenPurchase[0].amount));
  assert.ok(category.some((row) => row.category_code === 'UNRESOLVED_RETURN' && row.confirmed_returns === '0.10'));
  assert.equal(money(category.reduce((sum, row) => sum + minorUnits(row.gross_spend), 0n)), household.gross_spend);
  assert.equal(money(category.reduce((sum, row) => sum + minorUnits(row.confirmed_returns), 0n)), household.confirmed_returns);
  assert.equal(money(category.reduce((sum, row) => sum + minorUnits(row.net_spend), 0n)), household.net_spend);

  const person = (await pool.query(`SELECT person_id,gross_spend::text,confirmed_returns::text,net_spend::text
    FROM canonical_spending_person_summary_v1 WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, snapshotKey])).rows;
  assert.equal(person.length, 2);
  const unattributed = person.find((row) => row.person_id === null);
  assert.equal(unattributed.gross_spend, household.gross_spend);
  assert.equal(unattributed.confirmed_returns, household.confirmed_returns);
  assert.equal(money(person.reduce((sum, row) => sum + minorUnits(row.gross_spend), 0n)), household.gross_spend);
  assert.equal(money(person.reduce((sum, row) => sum + minorUnits(row.confirmed_returns), 0n)), household.confirmed_returns);
  assert.equal(money(person.reduce((sum, row) => sum + minorUnits(row.net_spend), 0n)), household.net_spend);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM canonical_spending_purchases_v1
    WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, snapshotKey])).rows[0].count, 1);

  const exactDecimal = (await pool.query(`SELECT
      (0.10::numeric(18,2) + 0.20::numeric(18,2) + 0.01::numeric(18,2))::text AS total,
      (0.20::numeric(18,2) - 0.10::numeric(18,2))::text AS partial_return`)).rows[0];
  assert.equal(exactDecimal.total, '0.31');
  assert.equal(exactDecimal.partial_return, '0.10');

  const categoryId = (await pool.query(`SELECT id FROM spending_categories
    WHERE category_code='UNCLASSIFIED' LIMIT 1`)).rows[0].id;
  const expectConstraint = async (query, params, codes) => {
    await assert.rejects(() => pool.query(query, params), (error) => {
      assert.ok(codes.includes(error.code), `unexpected SQLSTATE ${error.code}`);
      return true;
    });
  };
  await expectConstraint(`INSERT INTO spending_category_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key)
    VALUES($1,$2,$3,'PURCHASE',$4,$5,-0.01,'RUB','ALLOCATED',$6)`,
  [scope.id, secondRun.id, snapshotKey, initial.business_event_id, categoryId, 'n'.repeat(64)], ['23514']);
  await expectConstraint(`INSERT INTO spending_category_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key)
    VALUES($1,$2,$3,'PURCHASE',$4,$5,0.01,'usd','ALLOCATED',$6)`,
  [scope.id, secondRun.id, snapshotKey, initial.business_event_id, categoryId, 'm'.repeat(64)], ['23514']);
  await expectConstraint(`INSERT INTO spending_category_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key)
    VALUES($1,$2,$3,'PURCHASE',$4,999999,0.01,'RUB','ALLOCATED',$5)`,
  [scope.id, secondRun.id, snapshotKey, initial.business_event_id, 'f'.repeat(64)], ['23503']);
  await expectConstraint(`INSERT INTO spending_classification_decisions(
      scope_id,taxonomy_id,subject_type,subject_id,category_id,decision_status,decision_source,rule_or_model_version,provenance_key,semantic_key)
    VALUES($1,(SELECT id FROM spending_taxonomies LIMIT 1),'PURCHASE',$2,$3,'CLASSIFIED','CHATGPT','v1',$4,$5)`,
  [scope.id, initial.business_event_id, categoryId, 'p'.repeat(64), 'q'.repeat(64)], ['23514']);
  await expectConstraint(`INSERT INTO spending_person_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,amount,currency,allocation_status,provenance_key,semantic_key)
    VALUES($1,$2,$3,'PURCHASE',$4,0.01,'RUB','ALLOCATED',$5,$6)`,
  [scope.id, secondRun.id, snapshotKey, initial.business_event_id, 'u'.repeat(64), 'v'.repeat(64)], ['23514']);

  const validDecision = (await pool.query(`INSERT INTO spending_classification_decisions(
      scope_id,taxonomy_id,subject_type,subject_id,category_id,decision_status,decision_source,rule_or_model_version,provenance_key,semantic_key)
    VALUES($1,(SELECT id FROM spending_taxonomies LIMIT 1),'PURCHASE',$2,$3,'CLASSIFIED','MANUAL','v1',$4,$5) RETURNING id`,
  [scope.id, initial.business_event_id, categoryId, 'w'.repeat(64), 'x'.repeat(64)])).rows[0];
  const decisionClient = await pool.connect();
  try {
    await decisionClient.query('BEGIN');
    await assert.rejects(() => decisionClient.query('UPDATE spending_classification_decisions SET supersedes_decision_id=id WHERE id=$1', [validDecision.id]), /spending_classification_decisions/);
    await decisionClient.query('ROLLBACK');
  } finally { decisionClient.release(); }

  const afterSettlement = (await pool.query(`SELECT gross_spend::text,confirmed_returns::text,net_spend::text
    FROM canonical_spending_household_summary_v1 WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, snapshotKey])).rows[0];
  assert.deepEqual(afterSettlement, household);
});

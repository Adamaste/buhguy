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
    FROM certification_facts f JOIN reconciliation_runs r ON r.scope_id=f.scope_id AND r.id=f.run_id
    WHERE f.scope_id=$1 AND r.status='READY' AND f.source_state_key=r.source_state_key
      AND f.metric_code='CONFIRMED_ACQUISITION_VALUE' AND f.status='CERTIFIED'
    ORDER BY f.id LIMIT 1`, [scope.id])).rows[0];
  assert.ok(initial);
  const receipt = (await pool.query(`SELECT receipt_id
    FROM business_event_evidence
    WHERE id=$1 AND event_id=$2 AND receipt_id IS NOT NULL`, [initial.graph_evidence_id, initial.business_event_id])).rows[0];
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

  const returnOnlyKey = 'c'.repeat(64);
  const returnOnlyRun = (await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,finished_at)
    VALUES($1,$2,$3,'READY',NOW()) RETURNING id`, [scope.id, initial.model_version, returnOnlyKey])).rows[0];
  await pool.query(`INSERT INTO certification_facts(
      run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,business_event_id,semantic_key,source_state_key)
    SELECT $1,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,business_event_id,repeat(md5(semantic_key || 'return-only'),2),$2
    FROM certification_facts WHERE id=$3`, [returnOnlyRun.id, returnOnlyKey,
    (await pool.query(`SELECT id FROM certification_facts WHERE run_id=$1 AND metric_code='CONFIRMED_RETURN_VALUE'`, [secondRun.id])).rows[0].id]);

  const chainKey = 'd'.repeat(64);
  const chainRun = (await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status,finished_at)
    VALUES($1,$2,$3,'READY',NOW()) RETURNING id`, [scope.id, initial.model_version, chainKey])).rows[0];
  await pool.query(`INSERT INTO certification_facts(
      run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key)
    SELECT $1,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,
      repeat(md5(semantic_key || 'chain'),2),$2
    FROM certification_facts WHERE id=$3`, [chainRun.id, chainKey, initial.id]);
  const taxonomyId = (await pool.query(`SELECT id FROM spending_taxonomies WHERE taxonomy_version='household-spending-taxonomy-v1'`)).rows[0].id;
  const groceriesId = (await pool.query(`SELECT id FROM spending_categories WHERE taxonomy_id=$1 AND category_code='GROCERIES'`, [taxonomyId])).rows[0].id;
  const allocation = async (key, supersedes = null) => (await pool.query(`INSERT INTO spending_category_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key,supersedes_allocation_id)
    VALUES($1,$2,$3,'PURCHASE',$4,$5,$6,$7,'ALLOCATED',$8,$9) RETURNING id`,
  [scope.id, chainRun.id, chainKey, initial.business_event_id, groceriesId, initial.amount, 'RUB', key, supersedes])).rows[0];
  const allocationA = await allocation('a'.repeat(64));
  const allocationB = await allocation('b'.repeat(64), allocationA.id);
  const allocationC = await allocation('c'.repeat(64), allocationB.id);
  const chainRows = (await pool.query(`SELECT category_code,category_gross::text,allocation_status
    FROM canonical_spending_category_allocations_v1 WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, chainKey])).rows;
  assert.equal(chainRows.filter((row) => row.allocation_status === 'ALLOCATED').length, 1);
  assert.equal(chainRows[0].category_gross, initial.amount);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM spending_category_allocations
    WHERE id IN ($1,$2)`, [allocationA.id, allocationB.id])).rows[0].count, 2);

  const returnRelationship = async (key, supersedes = null) => (await pool.query(`INSERT INTO spending_return_relationships(
      scope_id,return_event_id,purchase_event_id,relationship_status,semantic_key,supersedes_relationship_id)
    VALUES($1,$2,$3,'LINKED',$4,$5) RETURNING id`,
  [scope.id, returnEvent.id, initial.business_event_id, key, supersedes])).rows[0];
  const returnA = await returnRelationship('a'.repeat(64));
  await pool.query(`UPDATE spending_return_relationships SET relationship_status='SUPERSEDED' WHERE id=$1`, [returnA.id]);
  const returnB = await returnRelationship('b'.repeat(64), returnA.id);
  await pool.query(`UPDATE spending_return_relationships SET relationship_status='SUPERSEDED' WHERE id=$1`, [returnB.id]);
  const returnC = await returnRelationship('c'.repeat(64), returnB.id);
  const activeReturn = (await pool.query(`SELECT relationship_status,related_purchase_id
    FROM canonical_spending_returns_v1 WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, snapshotKey])).rows[0];
  assert.equal(activeReturn.relationship_status, 'LINKED');
  assert.equal(Number(activeReturn.related_purchase_id), Number(initial.business_event_id));
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM spending_return_relationships
    WHERE id IN ($1,$2)`, [returnA.id, returnB.id])).rows[0].count, 2);

  const returnOnlySummary = (await pool.query(`SELECT gross_spend::text,confirmed_returns::text,net_spend::text
    FROM canonical_spending_household_summary_v1 WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, returnOnlyKey])).rows[0];
  assert.deepEqual(returnOnlySummary, { gross_spend: '0.00', confirmed_returns: '0.10', net_spend: '-0.10' });

  const runningKey = 'e'.repeat(64);
  const runningRun = (await pool.query(`INSERT INTO reconciliation_runs(scope_id,model_version,source_state_key,status)
    VALUES($1,$2,$3,'RUNNING') RETURNING id`, [scope.id, initial.model_version, runningKey])).rows[0];
  await pool.query(`INSERT INTO certification_facts(
      run_id,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,semantic_key,source_state_key)
    SELECT $1,scope_id,subject_type,subject_id,metric_code,dimension,status,amount,currency,event_at,
      reason_code,rule_code,rule_version,ledger_entry_id,business_event_id,graph_evidence_id,
      repeat(md5(semantic_key || 'running'),2),$2
    FROM certification_facts WHERE id=$3`, [runningRun.id, runningKey, initial.id]);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM canonical_spending_purchases_v1
    WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, runningKey])).rows[0].count, 0);

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
  const proofItems = (await pool.query(`SELECT DISTINCT receipt_item_id
    FROM canonical_spending_items_v1 WHERE scope_id=$1 AND source_state_key=$2`, [scope.id, snapshotKey])).rows;
  const expectedItem = (await pool.query(`SELECT id FROM receipt_items WHERE receipt_id=$1 ORDER BY id LIMIT 1`, [receipt.receipt_id])).rows[0];
  if (expectedItem) assert.ok(proofItems.some((row) => row.receipt_item_id === expectedItem.id));
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
  assert.equal(person.length, 1);
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
  const allocationClient = await pool.connect();
  try {
    await allocationClient.query('BEGIN');
    await allocationClient.query(`INSERT INTO spending_category_allocations(
        scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key)
      VALUES($1,$2,$3,'PURCHASE',$4,$5,0.01,'RUB','ALLOCATED',$6)`,
    [scope.id, secondRun.id, snapshotKey, initial.business_event_id, groceriesId, '6'.repeat(64)]);
    const partialRows = (await allocationClient.query(`SELECT category_code,category_gross::text,allocation_status
      FROM canonical_spending_category_allocations_v1 WHERE scope_id=$1 AND source_state_key=$2 AND subject_event_id=$3`, [scope.id, snapshotKey, initial.business_event_id])).rows;
    assert.ok(partialRows.some((row) => row.category_code === 'GROCERIES' && row.category_gross === '0.01'));
    assert.ok(partialRows.some((row) => row.category_code === 'UNCLASSIFIED' && row.category_gross === money(minorUnits(chosenPurchase[0].amount) - 1n)));
    await allocationClient.query('ROLLBACK');
  } finally { allocationClient.release(); }

  const conflictClient = await pool.connect();
  try {
    await conflictClient.query('BEGIN');
    await conflictClient.query(`INSERT INTO spending_category_allocations(
        scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key)
      VALUES($1,$2,$3,'PURCHASE',$4,$5,$6,'RUB','ALLOCATED',$7)`,
    [scope.id, secondRun.id, snapshotKey, initial.business_event_id, groceriesId, initial.amount, '7'.repeat(64)]);
    await conflictClient.query(`INSERT INTO spending_category_allocations(
        scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key)
      VALUES($1,$2,$3,'PURCHASE',$4,$5,0.01,'USD','ALLOCATED',$6)`,
    [scope.id, secondRun.id, snapshotKey, initial.business_event_id, groceriesId, '8'.repeat(64)]);
    const conflictRows = (await conflictClient.query(`SELECT category_code,category_gross::text,allocation_status
      FROM canonical_spending_category_allocations_v1 WHERE scope_id=$1 AND source_state_key=$2 AND subject_event_id=$3`, [scope.id, snapshotKey, initial.business_event_id])).rows;
    assert.deepEqual(conflictRows, [{ category_code: 'UNCLASSIFIED', category_gross: chosenPurchase[0].amount, allocation_status: 'REVIEW_REQUIRED' }]);
    await conflictClient.query('ROLLBACK');
  } finally { conflictClient.release(); }

  const people = (await pool.query(`SELECT id FROM persons WHERE scope_id=$1 ORDER BY id LIMIT 2`, [scope.id])).rows;
  if (people.length === 2) {
    const personClient = await pool.connect();
    try {
      await personClient.query('BEGIN');
      await personClient.query(`INSERT INTO spending_person_allocations(
          scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,person_id,amount,currency,allocation_status,provenance_key,semantic_key)
        VALUES($1,$2,$3,'PURCHASE',$4,$5,0.01,'RUB','ALLOCATED',$6,$7),
              ($1,$2,$3,'PURCHASE',$4,$8,$9,'RUB','ALLOCATED',$10,$11)`,
      [scope.id, secondRun.id, snapshotKey, initial.business_event_id, people[0].id, '9'.repeat(64), '0'.repeat(64), people[1].id,
        money(minorUnits(chosenPurchase[0].amount) - 1n), '1'.repeat(64), '2'.repeat(64)]);
      const personRows = (await personClient.query(`SELECT SUM(person_gross)::text AS gross
        FROM canonical_spending_person_allocations_v1 WHERE scope_id=$1 AND source_state_key=$2 AND subject_event_id=$3`,
      [scope.id, snapshotKey, initial.business_event_id])).rows[0];
      assert.equal(personRows.gross, chosenPurchase[0].amount);
      await personClient.query('ROLLBACK');
    } finally { personClient.release(); }
  }

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
  [scope.id, initial.business_event_id, categoryId, 'd'.repeat(64), 'e'.repeat(64)])).rows[0];
  await pool.query(`UPDATE spending_classification_decisions SET decision_status='SUPERSEDED' WHERE id=$1`, [validDecision.id]);
  const refinedDecision = (await pool.query(`INSERT INTO spending_classification_decisions(
      scope_id,taxonomy_id,subject_type,subject_id,category_id,decision_status,decision_source,rule_or_model_version,provenance_key,semantic_key,supersedes_decision_id)
    VALUES($1,(SELECT id FROM spending_taxonomies LIMIT 1),'PURCHASE',$2,$3,'CLASSIFIED','MANUAL','v1',$4,$5,$6) RETURNING id`,
  [scope.id, initial.business_event_id, categoryId, '5'.repeat(64), '6'.repeat(64), validDecision.id])).rows[0];
  await pool.query(`UPDATE spending_classification_decisions SET decision_status='SUPERSEDED' WHERE id=$1`, [refinedDecision.id]);
  const finalDecision = (await pool.query(`INSERT INTO spending_classification_decisions(
      scope_id,taxonomy_id,subject_type,subject_id,category_id,decision_status,decision_source,rule_or_model_version,provenance_key,semantic_key,supersedes_decision_id)
    VALUES($1,(SELECT id FROM spending_taxonomies LIMIT 1),'PURCHASE',$2,$3,'CLASSIFIED','MANUAL','v1',$4,$5,$6) RETURNING id`,
  [scope.id, initial.business_event_id, categoryId, '7'.repeat(64), '8'.repeat(64), refinedDecision.id])).rows[0];
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM spending_classification_decisions
    WHERE subject_id=$1 AND decision_status <> 'SUPERSEDED'`, [initial.business_event_id])).rows[0].count, 1);
  assert.ok(finalDecision.id);
  await expectConstraint(`INSERT INTO spending_category_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key,supersedes_allocation_id)
    VALUES($1,$2,$3,'PURCHASE',$4,$5,0.01,'RUB','ALLOCATED',$6,$7)`,
  [scope.id, chainRun.id, chainKey, initial.business_event_id, categoryId, '4'.repeat(64), allocationA.id], ['23505']);
  await expectConstraint(`INSERT INTO spending_category_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key)
    VALUES($1,$2,$3,'PURCHASE',$4,$5,0.01,'RUB','ALLOCATED',$6)`,
  [scope.id, secondRun.id, chainKey, initial.business_event_id, categoryId, '5'.repeat(64)], ['23503']);

  const foreignScope = (await pool.query(`INSERT INTO accounting_scopes(scope_key,label)
    VALUES('analytics-foreign-scope','Analytics foreign scope') RETURNING id`)).rows[0];
  const foreignPerson = (await pool.query(`INSERT INTO persons(scope_id,person_key,display_name)
    VALUES($1,'analytics-foreign-person','Foreign Person') RETURNING id`, [foreignScope.id])).rows[0];
  await expectConstraint(`INSERT INTO spending_person_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,person_id,amount,currency,allocation_status,provenance_key,semantic_key)
    VALUES($1,$2,$3,'PURCHASE',$4,$5,0.01,'RUB','ALLOCATED',$6,$7)`,
  [scope.id, secondRun.id, snapshotKey, initial.business_event_id, foreignPerson.id, '3'.repeat(64), '4'.repeat(64)], ['23503']);

  const foreignTaxonomy = (await pool.query(`INSERT INTO spending_taxonomies(taxonomy_version,status)
    VALUES('analytics-foreign-taxonomy','ACTIVE') RETURNING id`)).rows[0];
  const foreignParent = (await pool.query(`INSERT INTO spending_categories(taxonomy_id,category_code)
    VALUES($1,'FOREIGN_PARENT') RETURNING id`, [foreignTaxonomy.id])).rows[0];
  await expectConstraint(`INSERT INTO spending_categories(taxonomy_id,category_code,parent_category_id)
    VALUES($1,'CROSS_TAXONOMY_CHILD',$2)`, [taxonomyId, foreignParent.id], ['23503']);

  await expectConstraint(`INSERT INTO spending_category_allocations(
      scope_id,certification_run_id,source_state_key,allocation_kind,subject_event_id,category_id,amount,currency,allocation_status,semantic_key)
    VALUES($1,$2,$3,'PURCHASE',$4,$5,0.01,'RUB','ALLOCATED',$6)`,
  [scope.id, secondRun.id, chainKey, initial.business_event_id, categoryId, '9'.repeat(64)], ['23503']);

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

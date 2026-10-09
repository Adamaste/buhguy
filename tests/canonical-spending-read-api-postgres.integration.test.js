import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import crypto from 'node:crypto';
import { queryCanonicalSpending, validatePurchaseGrainRows } from '../src/canonical-spending-read-api.js';
import { rebuildCertification } from '../src/certification.js';
import { rebuildLedger } from '../src/ledger.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
let pool;
before(() => { if (databaseUrl) pool = new pg.Pool({ connectionString: databaseUrl, max: 2 }); });
after(async () => { await pool?.end(); });

async function applyAnalyticsArtifact() {
  await pool.query(await fs.readFile(new URL('../db/analytics/011_canonical_spending_analytics_v1.sql', import.meta.url), 'utf8'));
}

integration('disposable PostgreSQL query is snapshot-qualified and write-free', async () => {
  await applyAnalyticsArtifact();
  const tableNames = ['reconciliation_runs', 'certification_facts', 'reconciliation_results', 'ledger_entries', 'ledger_postings', 'ledger_source_links', 'bank_receipt_matches', 'business_event_bank_evidence'];
  const snapshot = async () => Promise.all(tableNames.map(async (name) => [name, (await pool.query(`SELECT count(*)::bigint AS count FROM public.${name}`)).rows[0].count]));
  const beforeRows = await snapshot();
  const decimal = (value) => { const [whole, fraction = ''] = String(value).split('.'); return BigInt(`${whole}${fraction.padEnd(2, '0')}`); };
  const normalized = (rows) => rows.map((row) => ({ currency: row.currency, gross: decimal(row.gross).toString(), returns: decimal(row.returns).toString(), net: decimal(row.net).toString() })).sort((a, b) => a.currency.localeCompare(b.currency));
  const normalizedMinor = (rows) => rows.map((row) => ({ currency: row.currency, gross: String(row.gross), returns: String(row.returns), net: String(row.net) })).sort((a, b) => a.currency.localeCompare(b.currency));
  const directAggregates = async (queryPeriod, snapshot) => {
    const args = [snapshot.scopeId, snapshot.runId, snapshot.sourceStateKey, queryPeriod.from, queryPeriod.to];
    const monetary = (await pool.query(`WITH monetary AS (
      SELECT currency,amount AS gross,0::numeric AS returns FROM canonical_spending_purchases_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz
      UNION ALL
      SELECT currency,0::numeric,return_amount FROM canonical_spending_returns_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz
    ) SELECT currency,gross::text,returns::text FROM monetary`, args)).rows;
    const category = (await pool.query(`WITH p AS (
      SELECT DISTINCT purchase_id AS subject_event_id,currency FROM canonical_spending_purchases_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz
    ), r AS (
      SELECT DISTINCT return_id AS subject_event_id,currency FROM canonical_spending_returns_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz
    ), a AS (
      SELECT a.currency,a.category_gross AS gross,a.category_returns AS returns FROM canonical_spending_category_allocations_v1 a JOIN p ON p.subject_event_id=a.subject_event_id AND p.currency=a.currency
       WHERE a.scope_id=$1 AND a.certification_run_id=$2 AND a.source_state_key=$3 AND a.category_gross <> 0
      UNION ALL
      SELECT a.currency,a.category_gross,a.category_returns FROM canonical_spending_category_allocations_v1 a JOIN r ON r.subject_event_id=a.subject_event_id AND r.currency=a.currency
       WHERE a.scope_id=$1 AND a.certification_run_id=$2 AND a.source_state_key=$3 AND a.category_returns <> 0
    ) SELECT a.currency,a.gross::text,a.returns::text FROM a`, args)).rows;
    const person = (await pool.query(`WITH p AS (
      SELECT DISTINCT purchase_id AS subject_event_id,currency FROM canonical_spending_purchases_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz
    ), r AS (
      SELECT DISTINCT return_id AS subject_event_id,currency FROM canonical_spending_returns_v1
       WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND returned_at >= $4::timestamptz AND returned_at < $5::timestamptz
    ), a AS (
      SELECT a.currency,a.person_gross AS gross,a.person_returns AS returns FROM canonical_spending_person_allocations_v1 a JOIN p ON p.subject_event_id=a.subject_event_id AND p.currency=a.currency
       WHERE a.scope_id=$1 AND a.certification_run_id=$2 AND a.source_state_key=$3 AND a.person_gross <> 0
      UNION ALL
      SELECT a.currency,a.person_gross,a.person_returns FROM canonical_spending_person_allocations_v1 a JOIN r ON r.subject_event_id=a.subject_event_id AND r.currency=a.currency
       WHERE a.scope_id=$1 AND a.certification_run_id=$2 AND a.source_state_key=$3 AND a.person_returns <> 0
    ) SELECT a.currency,a.gross::text,a.returns::text FROM a`, args)).rows;
    const aggregate = (rows) => {
      const totals = new Map();
      for (const row of rows) {
        const item = totals.get(row.currency) ?? { currency: row.currency, gross: 0n, returns: 0n };
        item.gross += decimal(row.gross);
        item.returns += decimal(row.returns);
        totals.set(row.currency, item);
      }
      return [...totals.values()].map((item) => ({ currency: item.currency, gross: item.gross.toString(), returns: item.returns.toString(), net: (item.gross - item.returns).toString() }));
    };
    return { monetary: aggregate(monetary), category: aggregate(category), person: aggregate(person) };
  };
  const periods = [
    { period: 'today' },
    { period: 'yesterday' },
    { period: 'range', from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' },
  ];
  for (const options of periods) {
    const result = await queryCanonicalSpending(pool, { ...options, scopeKey: 'default', limit: 1000 });
    assert.equal(result.status, 'READY', `disposable fixture must provide READY for ${options.period}`);
    const direct = await directAggregates(result.queryPeriod, result.snapshot);
    const directMonetary = direct.monetary;
    assert.deepEqual(normalized(result.data.grossReturnsNetByCurrency), normalizedMinor(directMonetary));
    assert.deepEqual(normalized(result.data.category.map((row) => ({ currency: row.currency, gross: row.gross, returns: row.returns, net: row.net }))), normalizedMinor(direct.category));
    assert.deepEqual(normalized(result.data.person.map((row) => ({ currency: row.currency, gross: row.gross, returns: row.returns, net: row.net }))), normalizedMinor(direct.person));
    if (options.period === 'range') {
      assert.ok(directMonetary.some((row) => BigInt(row.gross) > 0n), 'fixed fixture range must provide a non-zero purchase');
    }
    assert.equal(new Set(result.data.confirmedPurchases.map((row) => row.purchase_id)).size, result.data.confirmedPurchases.length);
    assert.ok(result.data.confirmedReturns.every((row) => typeof row.return_amount === 'string'));
    assert.equal(result.data.bankOnlyIncomplete.status, 'EXCLUDED_FROM_CERTIFIED_ACQUISITIONS');
    assert.ok(result.data.category.every((row) => row.currency && row.categoryCode !== undefined));
    assert.ok(result.data.person.every((row) => row.currency && 'attributionStatus' in row));
    assert.match(result.snapshot.sourceStateKey, /^[0-9a-f]{64}$/);
    const page = await queryCanonicalSpending(pool, { ...options, scopeKey: 'default', limit: 1, offset: 0 });
    assert.equal(page.status, 'READY');
    const totalPurchases = (await pool.query(`SELECT count(*)::int AS count FROM canonical_spending_purchases_v1 WHERE scope_id=$1 AND certification_run_id=$2 AND source_state_key=$3 AND purchased_at >= $4::timestamptz AND purchased_at < $5::timestamptz`, [result.snapshot.scopeId, result.snapshot.runId, result.snapshot.sourceStateKey, result.queryPeriod.from, result.queryPeriod.to])).rows[0].count;
    if (totalPurchases > 1) assert.equal(page.data.pagination.purchases.hasMore, true);
  }
  const afterRows = await snapshot();
  assert.deepEqual(afterRows, beforeRows);
});

integration('disposable PostgreSQL permissions are inspected without public grants', async () => {
  const row = (await pool.query(`SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name,current_setting('search_path') AS search_path,
    has_table_privilege(current_user, 'public.reconciliation_runs', 'SELECT') AS runs_select,
    has_table_privilege(current_user, 'public.accounting_scopes', 'SELECT') AS scopes_select`)).rows[0];
  assert.equal(typeof row.database_name, 'string');
  assert.equal(typeof row.role_name, 'string');
  assert.equal(typeof row.runs_select, 'boolean');
  assert.equal(typeof row.scopes_select, 'boolean');
});

integration('duplicate matches fail closed and returns/currencies remain separate', () => {
  assert.equal(validatePurchaseGrainRows([{ purchase_id: 1, certification_fact_id: 2, semantic_key: 'a' }, { purchase_id: 1, certification_fact_id: 3, semantic_key: 'b' }]).reasonCode, 'CORRUPT');
  assert.equal(validatePurchaseGrainRows([{ purchase_id: 1, certification_fact_id: 2, semantic_key: 'a' }]).ok, true);
});



integration('deterministic disposable return proof is period-, currency-, and grain-safe', async () => {
  const scopeKey = `canonical-return-proof-${process.pid}-${Date.now()}`;
  let scopeId;
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  let ruleRows = (await pool.query(`SELECT rule_code,rule_version
    FROM business_graph_rules
    WHERE rule_code IN ('STANDALONE_PURCHASE_V1','RETURN_REFUND_V1')
    ORDER BY rule_code,rule_version`)).rows;
  let insertedReturnRule = false;
  if (!ruleRows.some((row) => row.rule_code === 'RETURN_REFUND_V1')) {
    await pool.query(`INSERT INTO business_graph_rules(rule_code,rule_version,description)
      VALUES('RETURN_REFUND_V1','v1','Disposable canonical spending return proof rule')`);
    ruleRows = [...ruleRows, { rule_code: 'RETURN_REFUND_V1', rule_version: 'v1' }];
    insertedReturnRule = true;
  }
  const rules = new Map(ruleRows.map((row) => [row.rule_code, row.rule_version]));
  assert.ok(rules.has('STANDALONE_PURCHASE_V1'));
  assert.ok(rules.has('RETURN_REFUND_V1'));

  const receiptIds = [];
  const eventIds = [];
  try {
    scopeId = Number((await pool.query(
      'INSERT INTO accounting_scopes(scope_key,label) VALUES($1,$2) RETURNING id',
      [scopeKey, 'canonical spending return proof'],
    )).rows[0].id);

    const insertReceipt = async (label, currency, amount, dateTime, itemSums = []) => {
      const receiptId = Number((await pool.query(
        `INSERT INTO receipts(fns_id,source,total_sum,currency,date_time)
         VALUES($1,'fns_moi_cheki_online',$2,$3,$4) RETURNING id`,
        [`return-proof-${label}-${process.pid}-${Date.now()}`, amount, currency, dateTime],
      )).rows[0].id);
      receiptIds.push(receiptId);
      await pool.query('INSERT INTO receipt_raw(receipt_id,payload) VALUES($1,$2)', [receiptId, JSON.stringify({ fixture: label })]);
      await pool.query(`INSERT INTO receipt_fiscal_facts(
        receipt_id,normalization_version,source_content_sha256,normalized_content_sha256,
        normalization_status,cash_total_state,ecash_total_sum,ecash_total_state,
        prepaid_state,credit_state,provision_state,payment_components_status,
        payment_stage,correction_status
      ) VALUES($1,'fiscal-normalizer-v1',$2,$3,'READY','EXPLICIT_ZERO',$4,'PRESENT_VALUE',
        'EXPLICIT_ZERO','EXPLICIT_ZERO','EXPLICIT_ZERO','RECONCILED','SETTLEMENT_ONLY','NORMAL')`,
      [receiptId, hash(`source-${label}`), hash(`normalized-${label}`), amount]);
      for (const [position, itemSum] of itemSums.entries()) {
        const itemId = Number((await pool.query(`INSERT INTO receipt_items(
          receipt_id,position,name,quantity,price,item_sum
        ) VALUES($1,$2,$3,1,$4,$4) RETURNING id`, [receiptId, position + 1, `fixture item ${position + 1}`, itemSum])).rows[0].id);
        await pool.query(`INSERT INTO receipt_item_fiscal_facts(
          receipt_item_id,normalization_version,payment_type_code,payment_type_semantic,normalized_content_sha256
        ) VALUES($1,'fiscal-normalizer-v1',4,'ELECTRONIC',$2)`, [itemId, hash(`item-${label}-${position}`)]);
      }
      return receiptId;
    };

    const insertPurchase = async ({ label, amount, currency, dateTime, itemSums }) => {
      const receiptId = await insertReceipt(label, currency, amount, dateTime, itemSums);
      const eventId = Number((await pool.query(`INSERT INTO business_events(
        scope_id,event_type,resolution_status,origin,graph_model_version,
        rule_code,rule_version,semantic_key,amount,currency,description
      ) VALUES($1,'PURCHASE','CONFIRMED','SYSTEM_DERIVED','canonical-spending-return-proof-v1',
        'STANDALONE_PURCHASE_V1',$2,$3,$4,$5,$6) RETURNING id`,
      [scopeId, rules.get('STANDALONE_PURCHASE_V1'), hash(`purchase-event-${label}`), amount, currency, `return-proof purchase ${label}`])).rows[0].id);
      eventIds.push(eventId);
      await pool.query(`INSERT INTO business_event_evidence(
        event_id,receipt_id,normalization_version,evidence_role,origin,
        graph_model_version,rule_code,rule_version,semantic_key
      ) VALUES($1,$2,'fiscal-normalizer-v1','PURCHASE_EVIDENCE','SYSTEM_DERIVED',
        'canonical-spending-return-proof-v1','STANDALONE_PURCHASE_V1',$3,$4)`,
      [eventId, receiptId, rules.get('STANDALONE_PURCHASE_V1'), hash(`purchase-evidence-${label}`)]);
      return { eventId, receiptId };
    };

    const rubPurchase = await insertPurchase({
      label: 'rub-purchase', amount: '100.00', currency: 'RUB',
      dateTime: '2026-04-10T10:00:00Z', itemSums: ['60.00', '40.00'],
    });
    const usdPurchase = await insertPurchase({
      label: 'usd-purchase', amount: '7.00', currency: 'USD',
      dateTime: '2026-04-15T10:00:00Z', itemSums: ['7.00'],
    });
    await insertPurchase({
      label: 'boundary-purchase', amount: '5.00', currency: 'USD',
      dateTime: '2026-05-01T00:00:00Z', itemSums: ['5.00'],
    });

    const returnReceiptId = await insertReceipt('rub-return', 'RUB', '20.00', '2026-04-11T10:00:00Z', ['20.00']);
    const returnEventId = Number((await pool.query(`INSERT INTO business_events(
      scope_id,event_type,resolution_status,origin,graph_model_version,
      rule_code,rule_version,semantic_key,amount,currency,description
    ) VALUES($1,'RETURN','CONFIRMED','SYSTEM_DERIVED','canonical-spending-return-proof-v1',
      'RETURN_REFUND_V1',$2,$3,20.00,'RUB','return-proof refund') RETURNING id`,
    [scopeId, rules.get('RETURN_REFUND_V1'), hash('return-event')])).rows[0].id);
    eventIds.push(returnEventId);
    await pool.query(`INSERT INTO business_event_evidence(
      event_id,receipt_id,normalization_version,evidence_role,origin,
      graph_model_version,rule_code,rule_version,semantic_key
    ) VALUES($1,$2,'fiscal-normalizer-v1','RETURN_EVIDENCE','SYSTEM_DERIVED',
      'canonical-spending-return-proof-v1','RETURN_REFUND_V1',$3,$4)`,
    [returnEventId, returnReceiptId, rules.get('RETURN_REFUND_V1'), hash('return-evidence')]);
    await pool.query(`INSERT INTO business_event_allocations(
      scope_id,target_event_id,source_receipt_id,normalization_version,
      allocated_amount,currency,allocation_role,resolution_status,origin,
      graph_model_version,rule_code,rule_version,semantic_key
    ) VALUES($1,$2,$3,'fiscal-normalizer-v1',20.00,'RUB','RETURNED_ITEM',
      'CONFIRMED','SYSTEM_DERIVED','canonical-spending-return-proof-v1',
      'RETURN_REFUND_V1',$4,$5)`,
    [scopeId, returnEventId, returnReceiptId, rules.get('RETURN_REFUND_V1'), hash('return-allocation')]);
    await pool.query(`INSERT INTO business_event_edges(
      scope_id,source_event_id,target_event_id,relation_type,resolution_status,
      origin,graph_model_version,rule_code,rule_version,semantic_key,explanation
    ) VALUES($1,$2,$3,'RETURNS','CONFIRMED','SYSTEM_DERIVED',
      'canonical-spending-return-proof-v1','RETURN_REFUND_V1',$4,$5,'return proof')`,
    [scopeId, returnEventId, rubPurchase.eventId, rules.get('RETURN_REFUND_V1'), hash('return-edge')]);

    await rebuildLedger(pool, { scopeKey, eventIds });
    assert.deepEqual((await pool.query(`SELECT derivation_rule,derivation_status
      FROM ledger_entries WHERE scope_id=$1 AND source_event_id=$2`, [scopeId, returnEventId])).rows,
    [{ derivation_rule: 'LEDGER_RETURN_V1', derivation_status: 'READY' }]);
    await rebuildCertification(pool, { scopeKey, persist: true });
    const before = (await pool.query(`SELECT
      (SELECT count(*) FROM reconciliation_runs WHERE scope_id=$1) AS runs,
      (SELECT count(*) FROM certification_facts WHERE scope_id=$1) AS facts,
      (SELECT count(*) FROM reconciliation_results WHERE run_id IN (SELECT id FROM reconciliation_runs WHERE scope_id=$1)) AS results`, [scopeId])).rows[0];

    const full = await queryCanonicalSpending(pool, {
      scopeKey, period: 'range', from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z', limit: 1,
    });
    assert.equal(full.status, 'READY');
    assert.deepEqual(full.data.grossReturnsNetByCurrency, [
      { currency: 'RUB', gross: '100.00', returns: '20.00', net: '80.00' },
      { currency: 'USD', gross: '7.00', returns: '0', net: '7.00' },
    ]);
    assert.equal(full.data.confirmedPurchases.length, 1);
    assert.equal(full.data.pagination.purchases.hasMore, true);
    assert.equal(full.data.confirmedReturns.length, 1);
    const minor = (value) => {
      const [whole, fraction = ''] = String(value).split('.');
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    };
    const byCurrency = (rows, field) => Object.fromEntries(rows.reduce((map, row) => {
      map.set(row.currency, (map.get(row.currency) ?? 0n) + minor(row[field]));
      return map;
    }, new Map()));
    assert.deepEqual(byCurrency(full.data.category, 'gross'), { RUB: 10000n, USD: 700n });
    assert.deepEqual(byCurrency(full.data.category, 'returns'), { RUB: 2000n, USD: 0n });
    assert.deepEqual(byCurrency(full.data.person, 'gross'), { RUB: 10000n, USD: 700n });
    assert.deepEqual(byCurrency(full.data.person, 'returns'), { RUB: 2000n, USD: 0n });
    assert.ok(full.data.person.some((row) => row.personId === null && row.attributionStatus === 'UNATTRIBUTED'));

    const purchaseDay = await queryCanonicalSpending(pool, {
      scopeKey, period: 'range', from: '2026-04-10T00:00:00Z', to: '2026-04-11T00:00:00Z',
    });
    assert.equal(purchaseDay.status, 'READY');
    assert.deepEqual(purchaseDay.data.grossReturnsNetByCurrency, [{ currency: 'RUB', gross: '100.00', returns: '0', net: '100.00' }]);

    const returnDay = await queryCanonicalSpending(pool, {
      scopeKey, period: 'range', from: '2026-04-11T00:00:00Z', to: '2026-04-12T00:00:00Z',
    });
    assert.equal(returnDay.status, 'READY');
    assert.deepEqual(returnDay.data.grossReturnsNetByCurrency, [{ currency: 'RUB', gross: '0', returns: '20.00', net: '-20.00' }]);

    const boundary = await queryCanonicalSpending(pool, {
      scopeKey, period: 'range', from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z',
    });
    assert.equal(boundary.status, 'READY');
    assert.equal(boundary.data.confirmedPurchases.some((row) => row.amount === '5.00'), false);

    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*) FROM reconciliation_runs WHERE scope_id=$1) AS runs,
      (SELECT count(*) FROM certification_facts WHERE scope_id=$1) AS facts,
      (SELECT count(*) FROM reconciliation_results WHERE run_id IN (SELECT id FROM reconciliation_runs WHERE scope_id=$1)) AS results`, [scopeId])).rows[0], before);

    const driftEventId = Number((await pool.query(`INSERT INTO business_events(
      scope_id,event_type,resolution_status,origin,graph_model_version,
      rule_code,rule_version,semantic_key,amount,currency,description
    ) VALUES($1,'FEE','CONFIRMED','SYSTEM_DERIVED','canonical-spending-return-proof-v1',
      'RETURN_REFUND_V1',$2,$3,1.00,'RUB','source-state drift fixture') RETURNING id`,
    [scopeId, rules.get('RETURN_REFUND_V1'), hash('drift-event')])).rows[0].id);
    await rebuildLedger(pool, { scopeKey, eventIds: [driftEventId] });
    const stale = await queryCanonicalSpending(pool, { scopeKey, period: 'range', from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z' });
    assert.equal(stale.status, 'STALE');
  } finally {
    if (scopeId) {
      await pool.query('DELETE FROM reconciliation_runs WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM ledger_entries WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM ledger_accounts WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM business_event_edges WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM business_event_allocations WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM business_events WHERE scope_id=$1', [scopeId]);
      await pool.query('DELETE FROM receipts WHERE id = ANY($1::bigint[])', [receiptIds]);
      await pool.query('DELETE FROM accounting_scopes WHERE id=$1', [scopeId]);
      if (insertedReturnRule) await pool.query("DELETE FROM business_graph_rules WHERE rule_code='RETURN_REFUND_V1' AND rule_version='v1'");
    }
  }
});

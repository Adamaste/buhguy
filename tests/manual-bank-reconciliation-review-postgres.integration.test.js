import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/database.js';
import { createBankSource, ingestBankEvent, linkBankSourcePerson } from '../src/bank-ingestion.js';
import { createFinancialAccount, relateFinancialAccountPerson } from '../src/bank-account-resolution.js';
import { reviewHistoricalBankAccountResolution } from '../src/manual-bank-reconciliation-review.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

integration('manual historical account review is explicit, append-only, replayable, and never writes ledger', { concurrency: false }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = `${process.pid}-${Date.now()}`;
  const sourceKey = `manual-review-source-${suffix}`;
  let accountIds = [];
  let transactionId = null;
  try {
    await migrate(pool);
    const scope = (await pool.query("SELECT id FROM accounting_scopes WHERE scope_key='default'")).rows[0];
    const person = (await pool.query('INSERT INTO persons(scope_id,person_key,display_name) VALUES($1,$2,$3) RETURNING id', [scope.id, `manual-review-person-${suffix}`, 'Synthetic test person'])).rows[0];
    await createBankSource(pool, { sourceKey, sourceType: 'ANDROID_NOTIFICATION', displayName: 'Synthetic review source' });
    await linkBankSourcePerson(pool, { sourceKey, personId: person.id });
    const account = await createFinancialAccount(pool, { institution: 'Synthetic Bank', provider: 'synthetic.review', displayName: 'Synthetic account', currency: 'RUB' });
    const otherAccount = await createFinancialAccount(pool, { institution: 'Synthetic Bank', provider: 'synthetic.review', displayName: 'Other synthetic account', currency: 'RUB' });
    accountIds = [account.id, otherAccount.id];
    await relateFinancialAccountPerson(pool, { financialAccountId: account.id, personId: person.id, relationType: 'OWNER', provenance: 'TEST_EXPLICIT', reason: 'Synthetic test evidence' });
    const created = await ingestBankEvent(pool, {
      sourceKey,
      sourceEventId: `manual-review-purchase-${suffix}`,
      observedAt: '2026-10-01T10:01:00.000Z',
      eventTime: '2026-10-01T10:00:00.000Z',
      payload: { amount: '26.00', currency: 'RUB', direction: 'DEBIT', eventType: 'PURCHASE', merchant: 'Synthetic Shop' },
      ingestionMetadata: { adapter: 'test', provider: 'synthetic.review', schemaVersion: '1' },
    });
    transactionId = created.transactionId;
    assert.equal(created.status, 'created');
    // The generic synthetic provider is intentionally not classified by the
    // production normalizer. Seed a controlled exact-PURCHASE fixture directly
    // in this isolated integration database so the review guard is exercised.
    await pool.query(`UPDATE bank_transactions SET amount='26.00',currency='RUB',direction='DEBIT',
      event_type='PURCHASE',normalization_status='READY',evidence_quality='EXACT',
      normalization_version='manual-review-fixture-v1' WHERE id=$1`, [transactionId]);
    assert.equal((await pool.query('SELECT resolution_state FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [transactionId])).rows[0].resolution_state, 'UNKNOWN');

    const evidence = {
      evidenceType: 'BANK_STATEMENT',
      evidenceSha256: digest('synthetic statement file'),
      evidenceReferenceSha256: digest('synthetic row reference'),
      reviewerCode: 'test-0123456789abcdef',
    };
    const before = {
      resolution: (await pool.query('SELECT * FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [transactionId])).rows,
      reviews: (await pool.query('SELECT count(*)::int AS count FROM manual_bank_reconciliation_review_evidence WHERE bank_transaction_id=$1', [transactionId])).rows[0].count,
      ledger: (await pool.query('SELECT count(*)::int AS count FROM ledger_source_links WHERE bank_transaction_id=$1', [transactionId])).rows[0].count,
    };
    const preview = await reviewHistoricalBankAccountResolution(pool, { bankTransactionId: transactionId, financialAccountId: account.id });
    assert.equal(preview.status, 'DRY_RUN', JSON.stringify(preview));
    assert.equal(preview.ledgerChanged, false);
    assert.deepEqual({
      resolution: (await pool.query('SELECT * FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [transactionId])).rows,
      reviews: (await pool.query('SELECT count(*)::int AS count FROM manual_bank_reconciliation_review_evidence WHERE bank_transaction_id=$1', [transactionId])).rows[0].count,
      ledger: (await pool.query('SELECT count(*)::int AS count FROM ledger_source_links WHERE bank_transaction_id=$1', [transactionId])).rows[0].count,
    }, before);

    const resolved = await reviewHistoricalBankAccountResolution(pool, { bankTransactionId: transactionId, financialAccountId: account.id, evidence, persist: true });
    assert.equal(resolved.status, 'ACCOUNT_RESOLVED_FROM_EXTERNAL_EVIDENCE');
    const row = (await pool.query('SELECT financial_account_id,resolution_state,provenance FROM bank_transaction_account_resolution WHERE bank_transaction_id=$1', [transactionId])).rows[0];
    assert.equal(Number(row.financial_account_id), Number(account.id));
    assert.equal(row.resolution_state, 'RECONCILED');
    assert.equal(row.provenance, 'INDEPENDENT_EXTERNAL_BANK_EVIDENCE');
    const review = (await pool.query('SELECT evidence_type,evidence_sha256,evidence_reference_sha256,reviewer_code,review_kind FROM manual_bank_reconciliation_review_evidence WHERE bank_transaction_id=$1', [transactionId])).rows[0];
    assert.equal(review.review_kind, 'ACCOUNT_RESOLUTION');
    assert.equal(review.evidence_sha256, evidence.evidenceSha256);
    assert.equal(review.evidence_reference_sha256, evidence.evidenceReferenceSha256);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_source_links WHERE bank_transaction_id=$1', [transactionId])).rows[0].count, 0);

    const replay = await reviewHistoricalBankAccountResolution(pool, { bankTransactionId: transactionId, financialAccountId: account.id, evidence, persist: true });
    assert.equal(replay.status, 'ALREADY_REVIEWED');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM manual_bank_reconciliation_review_evidence WHERE bank_transaction_id=$1', [transactionId])).rows[0].count, 1);
    const conflicting = await reviewHistoricalBankAccountResolution(pool, { bankTransactionId: transactionId, financialAccountId: otherAccount.id, evidence, persist: true });
    assert.equal(conflicting.status, 'FAIL_CLOSED');
    assert.equal(conflicting.reasonCode, 'ACCOUNT_ALREADY_RESOLVED');

    await assert.rejects(() => pool.query('UPDATE manual_bank_reconciliation_review_evidence SET reviewer_code=$1 WHERE bank_transaction_id=$2', ['changed', transactionId]), /append-only/);
    await assert.rejects(() => pool.query('DELETE FROM manual_bank_reconciliation_review_evidence WHERE bank_transaction_id=$1', [transactionId]), /append-only/);
    const privileges = (await pool.query(`SELECT has_table_privilege('receipt_collector',
      'public.manual_bank_reconciliation_review_evidence','INSERT') AS can_insert,
      has_table_privilege('receipt_collector','public.manual_bank_reconciliation_review_evidence','SELECT') AS can_select`)).rows[0];
    assert.equal(privileges.can_insert, false);
    assert.equal(privileges.can_select, false);
  } finally {
    if (transactionId) await pool.query('DELETE FROM bank_event_observations WHERE id=(SELECT observation_id FROM bank_transactions WHERE id=$1)', [transactionId]).catch(() => {});
    if (sourceKey) await pool.query('DELETE FROM bank_sources WHERE source_key=$1', [sourceKey]).catch(() => {});
    for (const accountId of accountIds) await pool.query('DELETE FROM financial_accounts WHERE id=$1', [accountId]).catch(() => {});
    await pool.end();
  }
});

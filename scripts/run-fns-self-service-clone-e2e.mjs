import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPool, migrate, ReceiptRepository } from '../src/database.js';
import { normalizeReceiptDetail } from '../src/normalize.js';
import { SessionStore } from '../src/session-store.js';
import { addOnboardingUser, finishOnboarding, OnboardingStore, ONBOARDING_STATES } from '../src/fns-user-onboarding.js';
import { validateBusinessEventGraph } from '../src/business-event-graph.js';
import { accountingCoverageReport } from '../src/accounting-coverage.js';
import { certificationReport } from '../src/certification.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required');

const pool = createPool({ connectionString, max: 8 });
const root = await mkdtemp(path.join(os.tmpdir(), 'fns-self-service-clone-'));
const configPath = path.join(root, 'sources.json');
const statePath = path.join(root, 'onboarding.json');
const sessionDir = path.join(root, 'synthetic-session');
const json = (value) => JSON.stringify(value, null, 2);

try {
  await migrate(pool);
  const repository = new ReceiptRepository(pool);
  await writeFile(configPath, '[]\n', { mode: 0o600 });
  const store = new OnboardingStore({ statePath });
  const before = {
    receipts: Number((await pool.query('SELECT count(*)::int AS n FROM receipts')).rows[0].n),
    observations: Number((await pool.query('SELECT count(*)::int AS n FROM receipt_source_observations')).rows[0].n),
  };
  const added = await addOnboardingUser({ store, repository, displayName: 'Synthetic Third User', sessionDir, configPath });
  assert.equal(added.user.state, ONBOARDING_STATES.WAITING_AUTH);
  const sourceId = added.user.sourceId;
  const sessionStore = new SessionStore({ stateDir: sessionDir });
  await sessionStore.save({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', deviceInfo: { sourceDeviceId: 'synthetic-device', sourceType: 'WEB' }, userAgent: 'synthetic' });
  const sample = (await pool.query('SELECT rr.payload FROM receipt_raw rr ORDER BY rr.receipt_id LIMIT 1')).rows[0];
  assert.ok(sample?.payload, 'clone has no raw receipt fixture');
  const sharedRaw = sample.payload;
  const sharedNormalized = normalizeReceiptDetail(sharedRaw, { sourceId: 'synthetic-shared-reference' });
  const shared = await repository.upsertObservedBundle({ sourceId, sourceReceiptId: 'synthetic-shared-reference', normalized: sharedNormalized, raw: sharedRaw });
  const newRaw = { ...sharedRaw, fiscalDocumentNumber: `${sharedRaw.fiscalDocumentNumber}-synthetic`, fiscalSign: `${sharedRaw.fiscalSign}-synthetic`, key: 'synthetic-new-reference' };
  const created = await repository.upsertObservedBundle({ sourceId, sourceReceiptId: 'synthetic-new-reference', normalized: normalizeReceiptDetail(newRaw, { sourceId: 'synthetic-new-reference' }), raw: newRaw });
  await repository.upsertSourceReceiptReference({ sourceId, sourceReceiptId: 'synthetic-unavailable-reference' });
  await repository.markSourceReceiptDetailAttempt({ sourceId, sourceReceiptId: 'synthetic-unavailable-reference' });
  await repository.markSourceReceiptDetailUnavailable({ sourceId, sourceReceiptId: 'synthetic-unavailable-reference', error: { httpStatus: 422, errorCode: 'FNS_DETAIL_UNAVAILABLE', errorSignature: 'synthetic' } });
  const sync = { fetched: 3, inserted: created.created ? 1 : 0, replayed: created.created ? 0 : 1, errors: 0, unclassified: 0, unexpectedErrors: 0, authError: 0 };
  const finished = await finishOnboarding({
    store,
    repository,
    nameOrSource: added.user.sourceKey,
    sessionStore,
    refresh: async () => ({ ok: true }),
    sync: async () => sync,
    verify: async () => {
      const duplicateFnsId = Number((await pool.query('SELECT count(*)::int AS n FROM (SELECT fns_id FROM receipts WHERE fns_id IS NOT NULL GROUP BY fns_id HAVING count(*) > 1) q')).rows[0].n);
      const duplicateCanonical = Number((await pool.query('SELECT count(*)::int AS n FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts WHERE fiscal_drive_number IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1) q')).rows[0].n);
      const normalizationIssues = Number((await pool.query('SELECT count(*)::int AS n FROM normalization_issues')).rows[0].n);
      const graph = await validateBusinessEventGraph(pool);
      const ledgerBalanceViolations = Number((await pool.query('SELECT count(*)::int AS n FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING SUM(debit) <> SUM(credit)) q')).rows[0].n);
      const coverage = await accountingCoverageReport(pool, { scopeKey: 'default' });
      const certification = await certificationReport(pool, { scopeKey: 'default' });
      return { authHealthy: true, unclassified: 0, unexpectedErrors: 0, conflicts: 0, duplicateFnsId, duplicateCanonical, normalizationIssues, graphValid: graph.ok, ledgerBalanceViolations, coveragePass: coverage.gate.status === 'PASS', layerGapsPass: true, certificationReady: certification.status === 'READY' || certification.status === 'PASS' };
    },
    configPath,
  });
  const refs = await repository.countSourceReceiptReferences(sourceId);
  const after = { receipts: Number((await pool.query('SELECT count(*)::int AS n FROM receipts')).rows[0].n), observations: Number((await pool.query('SELECT count(*)::int AS n FROM receipt_source_observations')).rows[0].n) };
  assert.equal(finished.user.state, ONBOARDING_STATES.ACTIVE);
  assert.equal(after.receipts, before.receipts + (created.created ? 1 : 0));
  assert.equal(shared.created, false);
  assert.equal(refs.FNS_DETAIL_UNAVAILABLE, 1);
  console.log(json({ pass: true, state: finished.user.state, before, after, shared: { receiptId: shared.id, created: shared.created, observationCreated: shared.observationCreated }, newReceipt: { receiptId: created.id, created: created.created }, unavailable: refs.FNS_DETAIL_UNAVAILABLE, sync }));
} finally {
  await rm(root, { recursive: true, force: true });
  await pool.end();
}

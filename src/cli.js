import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { FnsClient } from './fns-client.js';
import { createLogger } from './logger.js';
import { SessionStore } from './session-store.js';
import { CaptchaRequiredError, ReceiptCollectorError, SessionExpiredError } from './errors.js';
import { assertSchemaCurrent, createPool, migrate, ReceiptRepository } from './database.js';
import { syncReceipts } from './sync.js';
import { backfillNormalization, normalizeAndStoreReceipt, rebuildNormalization } from './fiscal-normalization.js';
import { validateBusinessEventGraph, BusinessEventGraphRepository } from './business-event-graph.js';
import { dryRunPrepaymentSettlements, reconsiderPrepaymentSettlement } from './prepayment-settlement-matcher.js';
import { dryRunReturnRefundMatches, reconsiderReturnRefund, persistReturnRefundMatches, rebuildReturnRefundMatches } from './return-refund-matcher.js';
import { rebuildLedger, refreshLedgerForReceipt } from './ledger.js';
import { certificationReport, rebuildCertification, refreshCertificationForEvents } from './certification.js';
import { analyticsSummary, analyticsBlocked, analyticsTrace, assertSupportedMetric } from './analytics.js';
import { standalonePurchaseCensus, persistStandalonePurchases } from './standalone-purchase.js';
import { accountingCoverageReport, compareCoverageReports } from './accounting-coverage.js';
import { runAccountingCatchup } from './accounting-pipeline.js';
import { runSourceSyncCycle } from './source-sync-cycle.js';
import { addOnboardingUser, disableOnboarding, finishOnboarding, retryOnboarding, OnboardingStore, ONBOARDING_STATES, updateOnboardingState, updateSourceConfigAtomic } from './fns-user-onboarding.js';
import { importBrowserSession } from './browser-session-import.js';
import { removeOnboardingProfile, requireOnboardingProfile, startOnboardingBrowser, stopOnboardingBrowser, waitForOnboardingBrowserExit, onboardingCdpPort } from './onboarding-browser.js';
import { createBankDeviceCredential, listBankDeviceCredentials, revokeBankDeviceCredential } from './bank-device-auth.js';
import { createProvisionedBankSource, listProvisionedBankSources, linkProvisionedBankSourcePerson, setProvisionedBankSourceEnabled } from './bank-source-provisioning.js';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const [name, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) {
      result[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[name] = true;
      continue;
    }
    result[name] = next;
    i += 1;
  }
  return result;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function progress(message) {
  process.stderr.write(`[fns-user] ${message}\n`);
}

function summarizeAccountingCatchup(result) {
  return {
    prepaymentPurchases: result.prepayments?.created?.purchases ?? 0,
    standalonePurchases: result.standalone?.created ?? 0,
    returnEvents: result.returns?.created?.returns ?? 0,
    ledgerEntries: result.ledger?.created?.entries ?? 0,
    certificationFacts: result.certification?.facts?.length ?? 0,
  };
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function runBankDeviceCommand(args, { pool, write = printJson } = {}) {
  const subcommand = args._[0];
  if (subcommand === 'create') {
    const sourceKey = args['source-key'] || args._[1];
    const displayName = args['display-name'] || args._[2] || 'Android bank device';
    const credential = await createBankDeviceCredential(pool, { sourceKey, displayName });
    write({ ok: true, message: 'Device credential created. Token cannot be shown again.', source: sourceKey, credentialKey: credential.credential_key, token: credential.token });
    return 0;
  }
  if (subcommand === 'list') {
    write({ credentials: await listBankDeviceCredentials(pool) });
    return 0;
  }
  if (subcommand === 'revoke') {
    const credentialKey = args['credential-key'] || args._[1];
    write({ ok: true, credential: await revokeBankDeviceCredential(pool, credentialKey) });
    return 0;
  }
  throw new ReceiptCollectorError('Bank device command must be create, list or revoke');
}

export async function runBankSourceCommand(args, { pool, write = printJson } = {}) {
  const subcommand = args._[0];
  if (subcommand === 'create') {
    const source = await createProvisionedBankSource(pool, { sourceKey: args['source-key'] || args._[1], displayName: args['display-name'] || args._[2], sourceType: args['source-type'] });
    write({ ok: true, source });
    return 0;
  }
  if (subcommand === 'list') {
    write({ sources: await listProvisionedBankSources(pool) });
    return 0;
  }
  if (subcommand === 'enable' || subcommand === 'disable') {
    const source = await setProvisionedBankSourceEnabled(pool, { sourceKey: args['source-key'] || args._[1], enabled: subcommand === 'enable' });
    write({ ok: true, source });
    return 0;
  }
  if (subcommand === 'link-person') {
    const link = await linkProvisionedBankSourcePerson(pool, { sourceKey: args['source-key'] || args._[1], personKey: args['person-key'] || args._[2], relationType: args['relation-type'] || 'OWNER', scopeKey: args['scope-key'] || 'default' });
    write({ ok: true, link });
    return 0;
  }
  throw new ReceiptCollectorError('Bank source command must be create, list, enable, disable or link-person');
}

export function normalizePhone(value) {
  const phone = String(value ?? '').replace(/[^\d+]/g, '');
  if (phone.startsWith('+7')) {
    return phone.slice(1);
  }
  if (phone.startsWith('8') && phone.length === 11) {
    return `7${phone.slice(1)}`;
  }
  return phone;
}

async function promptIfMissing(rl, label, existing) {
  if (existing) {
    return existing;
  }
  return rl.question(`${label}: `);
}

function buildSessionSummary(state) {
  return {
    deviceId: state.deviceId,
    keepTokens: state.keepTokens,
    accessTokenExpiresAt: state.accessTokenExpiresAt,
    refreshTokenExpiresAt: state.refreshTokenExpiresAt,
    hasAccessToken: Boolean(state.accessToken),
    hasRefreshToken: Boolean(state.refreshToken),
  };
}

function onboardingAuthTimeoutMs() {
  const configured = Number(process.env.FNS_ONBOARDING_AUTH_TIMEOUT_MS ?? 30 * 60 * 1000);
  if (!Number.isFinite(configured)) return 30 * 60 * 1000;
  return Math.min(Math.max(configured, 5 * 60 * 1000), 2 * 60 * 60 * 1000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBrowserSessionImport({ store, user }) {
  const deadline = Date.now() + onboardingAuthTimeoutMs();
  const cdpUrl = user.cdpUrl || process.env.FNS_ONBOARDING_CDP_URL || 'http://127.0.0.1:9222';
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await importBrowserSession({ stateDir: user.sessionDir, cdpUrl });
      return await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH, {
        sessionImported: true,
        lastError: null,
      });
    } catch (error) {
      lastError = error;
      await sleep(2000);
    }
  }
  const timeout = Object.assign(new Error('FNS browser authentication timed out'), { code: 'AUTH_TIMEOUT' });
  await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.AUTH_FAILED, {
    lastError: timeout.code,
  });
  throw timeout;
}

async function finishOnboardingChild(nameOrSource) {
  try {
    const child = await execFileAsync(process.execPath, [path.resolve('bin/receipt-collector.js'), 'fns-user', 'finish', nameOrSource], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    if (child.stderr) process.stderr.write(child.stderr);
    return JSON.parse(child.stdout);
  } catch (error) {
    throw new ReceiptCollectorError(error?.stderr?.trim() || error?.message || 'FNS onboarding finish failed');
  }
}

export async function main(argv = process.argv.slice(2), {
  fetchImpl = fetch,
  sessionStore = new SessionStore(),
  logger = createLogger(),
} = {}) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const client = new FnsClient({ fetchImpl, sessionStore, logger });
  const state = await sessionStore.load();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printJson({
      usage: 'receipt-collector <login|auth|list|show|sync|normalize|graph|analytics|coverage|bank-device|bank-source>',
      examples: [
        'receipt-collector login',
        'receipt-collector list',
        'receipt-collector show <receipt-id>',
      ],
      session: buildSessionSummary(state),
    });
    return 0;
  }

  if (command === 'login') {
    const rl = readline.createInterface({ input, output });
    try {
      const phone = normalizePhone(await promptIfMissing(rl, 'Phone number', args.phone));
      const captchaToken = args['captcha-token'] ?? null;
      const deviceInfo = sessionStore.getDeviceInfo(state);

      const start = await client.startPhoneChallenge({ phone, captchaToken, deviceInfo });
      logger.info('Phone challenge started', { sentTo: start.sentTo, sendCodeVerifyStatus: start.sendCodeVerifyStatus });

      const challengeToken = start.challengeToken;
      if (!challengeToken) {
        throw new ReceiptCollectorError('Login challenge did not return a challenge token');
      }

      const code = await promptIfMissing(rl, 'SMS code', args.code);
      const verify = await client.verifyPhoneChallenge({
        challengeToken,
        phone,
        code,
        saveCredentials: args['no-save'] ? false : true,
        deviceInfo,
      });

      if (!args['no-save']) {
        const saved = await sessionStore.load();
        await sessionStore.save({
          ...saved,
          accessToken: verify.token ?? null,
          refreshToken: verify.refreshToken ?? null,
          accessTokenExpiresAt: verify.tokenExpireIn ? new Date(Date.now() + Number(verify.tokenExpireIn) * 1000).toISOString() : saved.accessTokenExpiresAt,
          refreshTokenExpiresAt: verify.refreshTokenExpiresIn ? new Date(Date.now() + Number(verify.refreshTokenExpiresIn) * 1000).toISOString() : saved.refreshTokenExpiresAt,
        });
      }

      const profile = await client.getProfile().catch(() => null);
      printJson({
        ok: true,
        profile,
        session: buildSessionSummary(await sessionStore.load()),
      });
      return 0;
    } catch (error) {
      if (error instanceof CaptchaRequiredError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      if (error instanceof SessionExpiredError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      if (error instanceof ReceiptCollectorError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      throw error;
    } finally {
      rl.close();
    }
  }

  if (command === 'list') {
    const receipts = await client.listReceipts({
      limit: toNumber(args.limit, 10),
      offset: toNumber(args.offset, 0),
      dateFrom: args['date-from'] ?? null,
      dateTo: args['date-to'] ?? null,
      orderBy: args['order-by'] ?? 'CREATED_DATE:DESC',
      inn: args.inn ?? null,
      kktOwner: args['kkt-owner'] ?? null,
    });
    if (args.raw) {
      printJson(receipts.raw);
      return 0;
    }
    printJson({
      hasMore: receipts.hasMore,
      receipts: receipts.receipts,
      brands: receipts.brands,
    });
    return 0;
  }

  if (command === 'auth') {
    const subcommand = args._[0];
    if (subcommand === 'status') {
      printJson({ ok: true, session: buildSessionSummary(state) });
      return 0;
    }
    if (subcommand === 'refresh-test') {
      try {
        const refreshed = await client.refreshSession(state);
        printJson({ ok: true, refreshed: true, session: buildSessionSummary(refreshed) });
        return 0;
      } catch (error) {
        logger.error?.('FNS authentication refresh failed', {
          status: error.status,
          errorCode: error.code,
          authError: 'FNS_REFRESH_FAILED',
        });
        printJson({ ok: false, authError: 'FNS_REFRESH_FAILED' });
        return 2;
      }
    }
    throw new ReceiptCollectorError('Auth command must be status or refresh-test');
  }

  if (command === 'fns-user') {
    const subcommand = args._[0];
    const store = new OnboardingStore();
    const configPath = process.env.FNS_SOURCES_CONFIG;
    const stateDir = process.env.FNS_ONBOARDING_SESSION_ROOT || path.join(process.cwd(), '.receipt-collector', 'users');
    if (subcommand === 'status') {
      const state = await store.load();
      printJson({ users: state.users.map(({ displayName, sourceKey, sourceId, state: onboardingState, disabled, updatedAt }) => ({ displayName, sourceKey, sourceId, state: onboardingState, disabled: Boolean(disabled), updatedAt })) });
      return 0;
    }
    const nameOrSource = args._[1];
    if (!nameOrSource && subcommand !== 'add') throw new ReceiptCollectorError(`fns-user ${subcommand ?? ''} requires a name or source id`);
    if (subcommand === 'add') {
      if (!nameOrSource) throw new ReceiptCollectorError('fns-user add requires a display name');
      const identity = (await import('./fns-user-onboarding.js')).onboardingIdentity(nameOrSource);
      const result = await addOnboardingUser({
        store,
        repository: { ensureSource: async (source) => {
          const pool = createPool();
          try { await assertSchemaCurrent(pool); return await new ReceiptRepository(pool).ensureSource(source); } finally { await pool.end(); }
        } },
        displayName: nameOrSource,
        sessionDir: path.join(stateDir, identity.sourceKey),
        cdpUrl: process.env.FNS_ONBOARDING_CDP_URL,
        configPath,
        startAuth: (user) => startOnboardingBrowser({ user, phase: 'login' }),
      });
      let user = await store.find(result.user.sourceKey);
      if (user?.state === ONBOARDING_STATES.ACTIVE) {
        printJson({ ok: true, active: true, user: { displayName: user.displayName, sourceKey: user.sourceKey, sourceId: user.sourceId, state: user.state } });
        return 0;
      }
      if (!result.created) {
        const browser = await startOnboardingBrowser({ user, phase: 'login' });
        user = await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH, { cdpUrl: null, browserPid: browser.pid, lastError: null, sessionImported: false });
      }
      process.stderr.write('FNS login required in the opened Chromium window. After successful login, close Chromium; import will start automatically.\n');
      await waitForOnboardingBrowserExit({ user, timeoutMs: onboardingAuthTimeoutMs() });
      progress('Login window closed; importing the saved browser session.');
      const importBrowser = await startOnboardingBrowser({ user, phase: 'import', preserveProfile: true });
      user = await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH, { cdpUrl: importBrowser.cdpUrl, browserPid: importBrowser.pid });
      await waitForBrowserSessionImport({ store, user });
      progress('Browser session imported; starting validation and initial sync.');
      const finished = await finishOnboardingChild(nameOrSource);
      printJson({ ok: true, action: 'FINISH', state: finished.user?.state ?? ONBOARDING_STATES.ACTIVE, sync: finished.sync });
      return 0;
    }
    if (subcommand === 'import-profile') {
      const user = await store.find(nameOrSource);
      if (!user) throw new ReceiptCollectorError('Onboarding user/source not found');
      await requireOnboardingProfile({ user });
      progress('Saved onboarding profile found; opening it for import.');
      if (!user.sessionImported) {
        const importBrowser = await startOnboardingBrowser({ user, phase: 'import', preserveProfile: true });
        const importUser = await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH, { cdpUrl: importBrowser.cdpUrl, browserPid: importBrowser.pid, lastError: null });
        await waitForBrowserSessionImport({ store, user: { ...importUser, cdpUrl: importBrowser.cdpUrl } });
        progress('Browser session imported; starting validation and initial sync.');
      }
      const finished = await finishOnboardingChild(nameOrSource);
      printJson({ ok: true, action: 'IMPORT_PROFILE', state: finished.user?.state ?? ONBOARDING_STATES.ACTIVE, sync: finished.sync });
      return 0;
    }
    if (subcommand === 'browser-start' || subcommand === 'browser-stop') {
      const user = await store.find(nameOrSource);
      if (!user) throw new ReceiptCollectorError('Onboarding user/source not found');
      const result = subcommand === 'browser-start'
        ? await startOnboardingBrowser({ user, phase: 'login' })
        : await stopOnboardingBrowser({ user });
      if (subcommand === 'browser-start') await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH, { cdpUrl: result.cdpUrl, browserPid: result.pid });
      printJson({ ok: true, ...result });
      return 0;
    }
    if (subcommand === 'disable') {
      const pool = createPool();
      try { await assertSchemaCurrent(pool); const result = await disableOnboarding({ store, repository: new ReceiptRepository(pool), nameOrSource, configPath }); printJson({ ok: true, user: { displayName: result.displayName, sourceKey: result.sourceKey, state: result.state, disabled: true } }); return 0; } finally { await pool.end(); }
    }
    if (subcommand === 'retry') {
      const user = await store.find(nameOrSource);
      if (!user) throw new ReceiptCollectorError('Onboarding user/source not found');
      if (user.state === ONBOARDING_STATES.ACTIVE) {
        const normalized = user.disabled === true
          ? await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.ACTIVE)
          : user;
        printJson({ ok: true, active: true, state: normalized.state });
        return 0;
      }
      if ([ONBOARDING_STATES.WAITING_AUTH, ONBOARDING_STATES.AUTH_FAILED].includes(user.state)) {
        const browser = await startOnboardingBrowser({ user, phase: 'login' });
        await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH, { cdpUrl: null, browserPid: browser.pid, lastError: null });
        printJson({ ok: true, action: 'AUTH_REQUIRED', state: ONBOARDING_STATES.WAITING_AUTH, cdpUrl: browser.cdpUrl });
        return 0;
      }
      if (user.state === ONBOARDING_STATES.PARTIAL_ENABLEMENT) {
        const pool = createPool();
        try {
          await assertSchemaCurrent(pool);
          const result = await disableOnboarding({ store, repository: new ReceiptRepository(pool), nameOrSource, configPath });
          printJson({ ok: true, action: 'RECONCILE_DISABLED', state: result.state, active: false });
          return 0;
        } finally { await pool.end(); }
      }
      // Once the browser session was imported, the finish path no longer needs CDP.
      // A child invocation keeps retry crash-safe without passing credentials in argv.
      if (user.sessionImported || [ONBOARDING_STATES.AUTHENTICATED, ONBOARDING_STATES.INITIAL_SYNC, ONBOARDING_STATES.SYNC_FAILED, ONBOARDING_STATES.VERIFYING, ONBOARDING_STATES.VERIFICATION_FAILED].includes(user.state)) {
        const child = await execFileAsync(process.execPath, [path.resolve('bin/receipt-collector.js'), 'fns-user', 'finish', nameOrSource], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024 });
        const parsed = JSON.parse(child.stdout);
        printJson({ ok: true, action: 'FINISH', state: parsed.user?.state ?? ONBOARDING_STATES.ACTIVE, sync: parsed.sync });
        return 0;
      }
      throw new ReceiptCollectorError(`Onboarding state cannot be retried: ${user.state}`);
    }
    if (subcommand === 'enable') {
      const user = await store.find(nameOrSource);
      if (!user) throw new ReceiptCollectorError('Onboarding user/source not found');
      if (![ONBOARDING_STATES.ACTIVE, ONBOARDING_STATES.DISABLED].includes(user.state)) throw new ReceiptCollectorError('Enable requires ACTIVE or DISABLED onboarding state');
      const pool = createPool();
        try { await assertSchemaCurrent(pool); const sourceStore = new SessionStore({ stateDir: user.sessionDir }); const sourceState = await sourceStore.load(); if (!sourceState.accessToken || !sourceState.refreshToken) throw new ReceiptCollectorError('Enable requires a healthy saved session'); await new FnsClient({ sessionStore: sourceStore, logger }).refreshSession(sourceState); await new ReceiptRepository(pool).ensureSource({ scopeKey: 'default', sourceKey: user.sourceKey, displayName: user.displayName, sessionRef: `filesystem:${user.sessionDir}/session.json`, deviceRef: `filesystem:${user.sessionDir}/device.json`, personKey: user.personKey, personDisplayName: user.displayName, enabled: true }); if (configPath) await updateSourceConfigAtomic({ configPath, source: { sourceKey: user.sourceKey, displayName: user.displayName, scopeKey: 'default', personKey: user.personKey, personDisplayName: user.displayName, sessionDir: user.sessionDir, sessionRef: `filesystem:${user.sessionDir}/session.json`, deviceRef: `filesystem:${user.sessionDir}/device.json` }, enabled: true }); printJson({ ok: true, sourceKey: user.sourceKey, enabled: true }); return 0; } finally { await pool.end(); }
    }
    if (subcommand === 'finish') {
      const user = await store.find(nameOrSource);
      if (!user) throw new ReceiptCollectorError('Onboarding user/source not found');
      const pool = createPool();
      try {
        await assertSchemaCurrent(pool);
        const repository = new ReceiptRepository(pool);
        const sourceRow = await repository.ensureSource({ scopeKey: 'default', sourceKey: user.sourceKey, displayName: user.displayName, sessionRef: `filesystem:${user.sessionDir}/session.json`, deviceRef: `filesystem:${user.sessionDir}/device.json`, personKey: user.personKey, personDisplayName: user.displayName, enabled: false });
        const sourceStore = new SessionStore({ stateDir: user.sessionDir });
        const sourceClient = new FnsClient({ sessionStore: sourceStore, logger });
        progress('Loading and validating the saved FNS session.');
        if (!user.sessionImported) {
          try {
            await importBrowserSession({ stateDir: user.sessionDir, cdpUrl: user.cdpUrl || process.env.FNS_ONBOARDING_CDP_URL || 'http://127.0.0.1:9222' });
            await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH, { sessionImported: true, lastError: null });
          } catch (error) {
            await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.AUTH_FAILED, { lastError: error.code || 'AUTH_IMPORT_FAILED' });
            throw error;
          }
        }
        const result = await finishOnboarding({
          store,
          repository,
          nameOrSource,
          sessionStore: sourceStore,
          refresh: (state) => sourceClient.refreshSession(state),
          deferInitialSync: false,
          sync: async () => {
            progress('Initial sync started.');
            const syncResult = await syncReceipts({ client: sourceClient, repository, accountKey: user.sourceKey, sourceContext: { sourceId: sourceRow.id, sourceKey: user.sourceKey }, normalizer: (receiptId) => normalizeAndStoreReceipt(pool, receiptId), logger });
            progress(`Initial sync completed: fetched=${syncResult.fetched ?? 0}, errors=${syncResult.errors ?? 0}.`);
            progress('Accounting catch-up started for all normalized receipts in the household scope.');
            const accounting = await runAccountingCatchup(pool, { scopeKey: 'default', logger });
            progress(`Accounting catch-up completed: graph/ledger/certification refreshed; standalone=${accounting.standalone?.created ?? 0}.`);
            return { ...syncResult, accounting };
          },
          verify: async (_user, syncResult) => {
            progress('Running accounting and source validators.');
            const lifecycle = Object.fromEntries((await pool.query('SELECT status,count(*)::int AS count FROM fns_source_receipt_refs WHERE fns_source_id=$1 GROUP BY status', [sourceRow.id])).rows.map((row) => [row.status, row.count]));
            const graph = await validateBusinessEventGraph(pool);
            await rebuildLedger(pool, { scopeKey: 'default', dryRun: true });
            const ledgerBalanceViolations = Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT ledger_entry_id FROM ledger_postings GROUP BY ledger_entry_id HAVING SUM(debit)<>SUM(credit)) q')).rows[0].count);
            const coverage = await accountingCoverageReport(pool, { scopeKey: 'default', sourceId: sourceRow.id, sourceStateKey: user.sourceKey });
            await certificationReport(pool, { scopeKey: 'default' });
            const duplicateFnsId = Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT fns_id FROM receipts WHERE fns_id IS NOT NULL GROUP BY fns_id HAVING count(*)>1) q')).rows[0].count);
            const duplicateCanonical = Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT fiscal_drive_number,fiscal_document_number,fiscal_sign FROM receipts GROUP BY 1,2,3 HAVING count(*)>1) q')).rows[0].count);
            const normalizationIssues = Number((await pool.query('SELECT count(*)::int AS count FROM normalization_issues')).rows[0].count);
            const layer = coverage.layerChecks;
            const layerGapsPass = layer.normalizationToGraph.readyWithoutReceiptEvidence === 0
              && layer.graphToLedger.confirmedEventsWithoutLedger === 0
              && layer.ledgerToCertification.missingCertification === 0
              && layer.ledgerToCertification.missingCertifiedAcquisition === 0
              && layer.certificationToAnalytics.missingAnalytics === 0;
            const verification = { authHealthy: true, ...lifecycle, unclassified: lifecycle.UNCLASSIFIED ?? syncResult.unclassified ?? 0, unexpectedErrors: syncResult.unexpectedErrors ?? 0, conflicts: lifecycle.CONFLICT ?? 0, duplicateFnsId, duplicateCanonical, normalizationIssues, graphValid: graph.ok, ledgerBalanceViolations, coveragePass: coverage.gate.status === 'PASS', layerGapsPass };
            const coverageReasons = coverage.gate.reasonCodes.length ? coverage.gate.reasonCodes.join(',') : 'none';
            progress(`Validators completed: graph=${verification.graphValid ? 'PASS' : 'FAIL'}, ledger=${verification.ledgerBalanceViolations === 0 ? 'PASS' : 'FAIL'}, coverage=${verification.coveragePass ? 'PASS' : 'FAIL'} (ready=${coverage.totals.readyReceipts}, explained=${coverage.totals.explained}, unexplained=${coverage.totals.unexplained}, unexplainedExposure=${coverage.totals.unexplainedExposure}, reasons=${coverageReasons}).`);
            return verification;
          },
          configPath,
          stopAuth: async () => { await stopOnboardingBrowser({ user }); },
          cleanupAuth: async () => {
            if (user.chromiumProfileDir) {
              await removeOnboardingProfile({
                user,
                profileRoot: path.dirname(user.sessionDir),
              });
            }
          },
        });
        progress('Onboarding completed; receipt import will run in the next scheduled sync.');
        printJson({ ok: true, user: { displayName: result.user.displayName, sourceKey: result.user.sourceKey, state: result.user.state }, sync: result.user.lastSync });
        return 0;
      } finally { await pool.end(); }
    }
    throw new ReceiptCollectorError('fns-user command must be add, import-profile, finish, status, retry, disable or enable');
  }

  if (command === 'bank-device') {
    const pool = createPool();
    try {
      await assertSchemaCurrent(pool);
      return await runBankDeviceCommand(args, { pool });
    } finally { await pool.end(); }
  }

  if (command === 'bank-source') {
    const pool = createPool();
    try {
      await assertSchemaCurrent(pool);
      return await runBankSourceCommand(args, { pool });
    } finally { await pool.end(); }
  }

  if (command === 'show') {
    const receiptId = args._[0];
    if (!receiptId) {
      throw new ReceiptCollectorError('Receipt id is required');
    }

    const receipt = await client.getReceipt(receiptId, { includeRaw: Boolean(args.raw || args['save-raw']) });
    const normalized = args.raw ? receipt.raw : (receipt.receipt ?? receipt);

    if (args['save-raw']) {
      const savePath = path.resolve(String(args['save-raw']));
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, `${JSON.stringify(receipt.raw, null, 2)}\n`, 'utf8');
    }

    printJson(normalized);
    return 0;
  }

  if (command === 'migrate') {
    const pool = createPool();
    try { await migrate(pool); } finally { await pool.end(); }
    printJson({ ok: true, migrated: true });
    return 0;
  }

  if (command === 'sync') {
    const pool = createPool();
    try {
      await assertSchemaCurrent(pool);
      const repository = new ReceiptRepository(pool);
      const boundedRefreshEnabled = Boolean(args['persist-matcher'] || args['persist-return-refund']);
      const cycle = await runSourceSyncCycle({
        repository,
        legacySessionStore: sessionStore,
        logger,
        runSource: async ({ source, sourceRow }) => {
          const sourceClient = new FnsClient({ fetchImpl, sessionStore: new SessionStore({ stateDir: source.sessionDir }) , logger });
          const syncResult = await syncReceipts({
            client: sourceClient,
            repository,
            normalizer: (receiptId) => normalizeAndStoreReceipt(pool, receiptId),
            matcher: (receiptId) => reconsiderPrepaymentSettlement(pool, receiptId, { scopeKey: source.scopeKey ?? args['scope-key'] ?? 'default', persist: Boolean(args['persist-matcher']) }),
            returnMatcher: args['return-refund'] ? (receiptId) => reconsiderReturnRefund(pool, receiptId, { scopeKey: source.scopeKey ?? args['scope-key'] ?? 'default', persist: Boolean(args['persist-return-refund']) }) : null,
            standaloneMatcher: async (receiptId) => {
              const standalone = await persistStandalonePurchases(pool, { scopeKey: source.scopeKey ?? args['scope-key'] ?? 'default', receiptIds: [receiptId], ledgerRefresher: boundedRefreshEnabled ? (id) => refreshLedgerForReceipt(pool, { scopeKey: source.scopeKey ?? args['scope-key'] ?? 'default', receiptId: id }) : null, certificationRefresher: boundedRefreshEnabled ? (eventIds) => refreshCertificationForEvents(pool, { scopeKey: source.scopeKey ?? args['scope-key'] ?? 'default', eventIds }) : null });
              return { examined: 1, created: standalone.purchases.some((item) => Number(item.receiptId) === Number(receiptId) && item.created) ? 1 : 0 };
            },
            ledgerRefresher: args['persist-matcher'] || args['persist-return-refund'] ? (receiptId) => refreshLedgerForReceipt(pool, { scopeKey: source.scopeKey ?? args['scope-key'] ?? 'default', receiptId }) : null,
            certificationRefresher: args['persist-matcher'] || args['persist-return-refund'] ? (eventIds) => refreshCertificationForEvents(pool, { scopeKey: source.scopeKey ?? args['scope-key'] ?? 'default', eventIds }) : null,
            accountKey: source.sourceKey,
            sourceContext: { sourceId: sourceRow.id, sourceKey: source.sourceKey },
            pageSize: toNumber(args['page-size'], 50),
            logger,
          });
          await runAccountingCatchup(pool, { scopeKey: source.scopeKey ?? args['scope-key'] ?? 'default', logger });
          return syncResult;
        },
      });
      printJson(cycle);
      return cycle.exitCode;
    } finally { await pool.end(); }
  }

  if (command === 'normalize') {
    const pool = createPool();
    try {
      await assertSchemaCurrent(pool);
      const result = args.rebuild ? await rebuildNormalization(pool) : await backfillNormalization(pool);
      printJson({ ok: true, ...result });
      return result.blocked || result.unsupported ? 2 : 0;
    } finally { await pool.end(); }
  }

  if (command === 'accounting') {
    const subcommand = args._[0] ?? 'catch-up';
    if (subcommand !== 'catch-up') throw new ReceiptCollectorError('Accounting command must be catch-up');
    const pool = createPool();
    try {
      await assertSchemaCurrent(pool);
      const result = await runAccountingCatchup(pool, { scopeKey: args['scope-key'] ?? 'default', logger });
      printJson({ ok: true, scopeKey: args['scope-key'] ?? 'default', ...summarizeAccountingCatchup(result) });
      return 0;
    } finally { await pool.end(); }
  }

  if (command === 'graph') {
    const subcommand = args._[0];
    const pool = createPool();
    try {
      if (subcommand === 'validate') {
        const result = await validateBusinessEventGraph(pool);
        printJson(result);
        return result.ok ? 0 : 2;
      }
      if (subcommand === 'inspect') {
        const eventId = Number(args._[1]);
        if (!Number.isInteger(eventId) || eventId < 1) throw new ReceiptCollectorError('Graph event id is required');
        const result = await new BusinessEventGraphRepository(pool).inspectEvent(eventId);
        if (!result) throw new ReceiptCollectorError('Graph event was not found');
        printJson(result);
        return 0;
      }
      throw new ReceiptCollectorError('Graph command must be validate or inspect');
    } finally { await pool.end(); }
  }

  if (command === 'ledger') {
    const subcommand = args._[0];
    if (subcommand !== 'project' && subcommand !== 'rebuild') throw new ReceiptCollectorError('Ledger command must be project or rebuild');
    const pool = createPool();
    try {
      const result = await rebuildLedger(pool, { scopeKey: args['scope-key'] ?? 'default', dryRun: subcommand === 'project' || !args.persist, replace: Boolean(args.replace) });
      printJson(result);
      return result.balancedViolations ? 2 : 0;
    } finally { await pool.end(); }
  }

  if (command === 'certification') {
    const subcommand = args._[0] ?? 'report';
    if (subcommand !== 'report' && subcommand !== 'rebuild') throw new ReceiptCollectorError('Certification command must be report or rebuild');
    const pool = createPool();
    try {
      const options = { scopeKey: args['scope-key'] ?? 'default', from: args.from ?? null, to: args.to ?? null };
      const result = subcommand === 'report' ? await certificationReport(pool, options) : await rebuildCertification(pool, { ...options, persist: Boolean(args.persist), replace: Boolean(args.replace) });
      printJson(result);
      return 0;
    } finally { await pool.end(); }
  }

  if (command === 'analytics') {
    const subcommand = args._[0] ?? 'summary';
    if (!['summary', 'blocked', 'trace'].includes(subcommand)) throw new ReceiptCollectorError('Analytics command must be summary, blocked or trace');
    const pool = createPool();
    try {
      const options = { scopeKey: args['scope-key'] ?? 'default', from: args.from ?? null, to: args.to ?? null, timezone: args.timezone ?? undefined };
      if (subcommand === 'summary') { printJson(await analyticsSummary(pool, options)); return 0; }
      if (subcommand === 'blocked') { printJson(await analyticsBlocked(pool, options)); return 0; }
      assertSupportedMetric(args.metric ?? null);
      printJson(await analyticsTrace(pool, { ...options, metricCode: args.metric ?? null, limit: toNumber(args.limit, 100) }));
      return 0;
    } finally { await pool.end(); }
  }

  if (command === 'coverage') {
    const subcommand = args._[0] ?? 'summary';
    const writeResult = async (result) => {
      if (args.out) await fs.writeFile(path.resolve(String(args.out)), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      printJson(result);
      return result.gate?.status === 'FAIL' || result.status === 'FAIL' ? 2 : 0;
    };
    if (subcommand === 'compare') {
      const baselinePath = args._[1]; const candidatePath = args._[2];
      if (!baselinePath || !candidatePath) throw new ReceiptCollectorError('Coverage compare requires baseline and candidate JSON paths');
      const [baseline, candidate] = await Promise.all([fs.readFile(path.resolve(baselinePath), 'utf8'), fs.readFile(path.resolve(candidatePath), 'utf8')]);
      const allowlist = args.allowlist ? JSON.parse(await fs.readFile(path.resolve(String(args.allowlist)), 'utf8')) : [];
      return writeResult(compareCoverageReports(JSON.parse(baseline), JSON.parse(candidate), { allowlist }));
    }
    if (!['summary', 'period', 'receipt'].includes(subcommand)) throw new ReceiptCollectorError('Coverage command must be summary, period, receipt or compare');
    const pool = createPool();
    try {
      const receiptId = subcommand === 'receipt' ? Number(args._[1]) : null;
      if (subcommand === 'receipt' && (!Number.isInteger(receiptId) || receiptId < 1)) throw new ReceiptCollectorError('Coverage receipt id is required');
      const options = { scopeKey: args['scope-key'] ?? 'default', from: args.from ?? null, to: args.to ?? null };
      const report = await accountingCoverageReport(pool, options);
      if (receiptId !== null) {
        const receiptOutcomes = report.receiptOutcomes.filter((row) => row.receiptId === receiptId);
        if (!receiptOutcomes.length) throw new ReceiptCollectorError(`Coverage receipt not found: ${receiptId}`);
        return writeResult({ ...report, receiptOutcomes });
      }
      return writeResult(report);
    } finally { await pool.end(); }
  }

  if (command === 'standalone-purchase') {
    const subcommand = args._[0] ?? 'dry-run';
    if (!['dry-run', 'persist'].includes(subcommand)) throw new ReceiptCollectorError('Standalone purchase command must be dry-run or persist');
    const pool = createPool();
    try {
      const options = { scopeKey: args['scope-key'] ?? 'default', from: args.from ?? null, to: args.to ?? null };
      const result = subcommand === 'dry-run' ? await standalonePurchaseCensus(pool, options) : await persistStandalonePurchases(pool, { scopeKey: options.scopeKey, ledgerRefresher: args['persist-ledger'] ? (id) => refreshLedgerForReceipt(pool, { scopeKey: options.scopeKey, receiptId: id }) : null, certificationRefresher: args['persist-ledger'] ? (eventIds) => refreshCertificationForEvents(pool, { scopeKey: options.scopeKey, eventIds }) : null });
      printJson(result);
      return 0;
    } finally { await pool.end(); }
  }

  if (command === 'match') {
    const subcommand = args._[0];
    if (subcommand === 'return-refund') {
      if (args['dry-run'] === false && !args.persist) throw new ReceiptCollectorError('Return/refund persistence requires explicit --persist');
      const pool = createPool();
      try {
        const result = args.rebuild ? await rebuildReturnRefundMatches(pool, { scopeKey: args['scope-key'] ?? 'default' }) : (args.persist ? await persistReturnRefundMatches(pool, { scopeKey: args['scope-key'] ?? 'default' }) : await dryRunReturnRefundMatches(pool, { scopeKey: args['scope-key'] ?? 'default' }));
        printJson(result);
        return 0;
      } finally { await pool.end(); }
    }
    if (subcommand !== 'prepayment-settlement' || args['dry-run'] === false) throw new ReceiptCollectorError('Only match prepayment-settlement --dry-run or return-refund --dry-run is supported');
    const pool = createPool();
    try { printJson(await dryRunPrepaymentSettlements(pool, { scopeKey: args['scope-key'] ?? 'default' })); return 0; }
    finally { await pool.end(); }
  }

  throw new ReceiptCollectorError(`Unknown command: ${command}`);
}

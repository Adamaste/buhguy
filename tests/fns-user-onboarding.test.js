import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addOnboardingUser,
  enableSourceSaga,
  finishOnboarding,
  retryOnboarding,
  onboardingIdentity,
  OnboardingStore,
  ONBOARDING_STATES,
  updateSourceConfigAtomic,
} from '../src/fns-user-onboarding.js';
import { importBrowserSession } from '../src/browser-session-import.js';
import { onboardingCdpPort, removeOnboardingProfile, requireOnboardingProfile, startOnboardingBrowser, stopOnboardingBrowser } from '../src/onboarding-browser.js';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fns-user-onboarding-'));
  const statePath = path.join(dir, 'onboarding.json');
  const configPath = path.join(dir, 'sources.json');
  await writeFile(configPath, JSON.stringify([{ sourceKey: 'legacy-default', enabled: true, sessionDir: '/secure/legacy' }]));
  return { dir, store: new OnboardingStore({ statePath }), configPath };
}

test('add creates one disabled source and duplicate add resumes idempotently', async () => {
  const f = await fixture();
  const calls = [];
  const repository = { async ensureSource(source) { calls.push(source); return { id: 3, ...source }; } };
  const first = await addOnboardingUser({ store: f.store, repository, displayName: 'Третий пользователь', sessionDir: path.join(f.dir, 'source-3'), configPath: f.configPath });
  const second = await addOnboardingUser({ store: f.store, repository, displayName: 'Третий пользователь', sessionDir: path.join(f.dir, 'source-3'), configPath: f.configPath });
  assert.equal(first.created, true);
  assert.equal(second.resumed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].enabled, false);
  assert.equal((await f.store.load()).users.length, 1);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(f.dir, 'source-3', 'chromium-profile'))).mode & 0o777, 0o700);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(config.length, 2);
  assert.equal(config[1].enabled, false);
  await rm(f.dir, { recursive: true, force: true });
});

test('add resumes an existing AUTH_FAILED source without creating another person or source', async () => {
  const f = await fixture();
  const identity = onboardingIdentity('Person A');
  await f.store.save({
    version: 1,
    users: [{
      ...identity,
      sourceId: 101,
      personKey: identity.personKey,
      sessionDir: path.join(f.dir, identity.sourceKey),
      state: ONBOARDING_STATES.AUTH_FAILED,
      lastError: 'AUTH_RELOGIN_REQUIRED',
    }],
  });
  let ensureSourceCalls = 0;
  const result = await addOnboardingUser({
    store: f.store,
    repository: { async ensureSource() { ensureSourceCalls += 1; throw new Error('must not create a replacement source'); } },
    displayName: 'Person A',
    sessionDir: path.join(f.dir, identity.sourceKey),
    configPath: f.configPath,
  });
  assert.equal(result.created, false);
  assert.equal(result.resumed, true);
  assert.equal(result.user.sourceId, 101);
  assert.equal(result.user.sourceKey, identity.sourceKey);
  assert.equal(result.user.state, ONBOARDING_STATES.AUTH_FAILED);
  assert.equal(ensureSourceCalls, 0);
  assert.equal((await f.store.load()).users.length, 1);
  await rm(f.dir, { recursive: true, force: true });
});

test('ACTIVE onboarding state is never reported disabled after prior compensation', async () => {
  const f = await fixture();
  await f.store.save({ version: 1, users: [{ ...onboardingIdentity('Active Repair'), sourceId: 101, sessionDir: f.sessionDir, state: ONBOARDING_STATES.ACTIVE, disabled: true }] });
  const result = await finishOnboarding({
    store: f.store,
    repository: { ensureSource: async () => ({ id: 101 }) },
    nameOrSource: 'Active Repair',
    sessionStore: { load: async () => ({ accessToken: 'opaque', refreshToken: 'opaque' }) },
    refresh: async () => ({ ok: true }),
    sync: async () => ({ fetched: 0, errors: 0 }),
    verify: async () => ({}),
  });
  assert.equal(result.user.state, ONBOARDING_STATES.ACTIVE);
  assert.equal(result.user.disabled, false);
});

test('browser import is target-specific, atomic and returns no secret material', async () => {
  const f = await fixture();
  const target = path.join(f.dir, 'source-3');
  const fakeBrowser = {
    contexts: () => [{ pages: () => [{ url: () => 'https://lkdr.nalog.ru/login', evaluate: async () => ({ accessToken: 'opaque-access', refreshToken: 'opaque-refresh', accessTokenExpiresAt: '2026-09-10T00:00:00Z', refreshTokenExpiresAt: '2026-10-10T00:00:00Z', userAgent: 'test-agent', tokenStore: JSON.stringify({ sourceDeviceId: 'device-3', sourceType: 'WEB', metaDetails: { userAgent: 'test-agent' } }) }) }] }],
    disconnect() {},
  };
  const result = await importBrowserSession({ stateDir: target, chromium: { async connectOverCDP() { return fakeBrowser; } } });
  assert.deepEqual(result, { imported: true });
  const state = JSON.parse(await readFile(path.join(target, 'session.json'), 'utf8'));
  assert.equal(state.deviceInfo.sourceDeviceId, 'device-3');
  assert.equal(state.accessToken, 'opaque-access');
  await rm(f.dir, { recursive: true, force: true });
});

test('browser import finds device metadata in a separate auth storage key', async () => {
  const f = await fixture();
  const target = path.join(f.dir, 'fns-onboarding-device-key');
  const fakeBrowser = {
    contexts: () => [{ pages: () => [{ url: () => 'https://lkdr.nalog.ru/receipts', evaluate: async () => ({
      accessToken: 'access', refreshToken: 'refresh', userAgent: 'FNS', tokenStore: null,
      storage: { 'auth.token': 'access', 'device.info': JSON.stringify({ sourceDeviceId: 'device-separate', sourceType: 'WEB', metaDetails: { userAgent: 'FNS' } }) },
    }) }] }],
    disconnect() {},
  };
  await importBrowserSession({ stateDir: target, chromium: { async connectOverCDP() { return fakeBrowser; } } });
  assert.equal((JSON.parse(await readFile(path.join(target, 'session.json'), 'utf8'))).deviceInfo.sourceDeviceId, 'device-separate');
  await rm(f.dir, { recursive: true, force: true });
});

test('browser import accepts sourceDeviceId stored as a separate localStorage key', async () => {
  const f = await fixture();
  const browser = { contexts: () => [{ pages: () => [{
    url: () => 'https://lkdr.nalog.ru/',
    evaluate: async () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      sourceDeviceId: 'device-from-separate-key',
      userAgent: 'synthetic',
      tokenStore: null,
      storage: {},
    }),
  }] }], disconnect() {} };
  await importBrowserSession({ stateDir: path.join(f.dir, 'source-device-key'), chromium: { async connectOverCDP() { return browser; } } });
  const saved = JSON.parse(await readFile(path.join(f.dir, 'source-device-key', 'session.json'), 'utf8'));
  assert.equal(saved.deviceInfo.sourceDeviceId, 'device-from-separate-key');
  assert.equal(saved.deviceInfo.sourceType, 'WEB');
  await rm(f.dir, { recursive: true, force: true });
});

test('browser import normalizes deviceId-shaped metadata without guessing identity', async () => {
  const f = await fixture();
  const target = path.join(f.dir, 'fns-onboarding-device-id');
  const fakeBrowser = {
    contexts: () => [{ pages: () => [{ url: () => 'https://lkdr.nalog.ru/receipts', evaluate: async () => ({
      accessToken: 'access', refreshToken: 'refresh', userAgent: 'FNS', tokenStore: JSON.stringify({ deviceId: 'device-shaped', deviceType: 'WEB', userAgent: 'FNS' }), storage: {},
    }) }] }],
    disconnect() {},
  };
  await importBrowserSession({ stateDir: target, chromium: { async connectOverCDP() { return fakeBrowser; } } });
  const state = JSON.parse(await readFile(path.join(target, 'session.json'), 'utf8'));
  assert.equal(state.deviceInfo.sourceDeviceId, 'device-shaped');
  assert.equal(state.deviceInfo.sourceType, 'WEB');
  await rm(f.dir, { recursive: true, force: true });
});

test('synthetic third-user E2E converges add -> import -> finish -> ACTIVE', async () => {
  const f = await fixture();
  const repository = { async ensureSource(source) { return { id: 3, ...source }; } };
  const added = await addOnboardingUser({ store: f.store, repository, displayName: 'Synthetic Third', sessionDir: path.join(f.dir, 'source-3'), configPath: f.configPath });
  assert.equal(added.user.state, ONBOARDING_STATES.WAITING_AUTH);
  const browser = { contexts: () => [{ pages: () => [{ url: () => 'https://lkdr.nalog.ru/login', evaluate: async () => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', tokenStore: JSON.stringify({ sourceDeviceId: 'synthetic-device', sourceType: 'WEB', metaDetails: { userAgent: 'synthetic' } }) }) }] }], disconnect() {} };
  await importBrowserSession({ stateDir: added.user.sessionDir, chromium: { async connectOverCDP() { return browser; } } });
  const sessionStore = { async load() { return JSON.parse(await readFile(path.join(added.user.sessionDir, 'session.json'), 'utf8')); } };
  const finished = await finishOnboarding({ store: f.store, repository, nameOrSource: 'Synthetic Third', sessionStore, refresh: async () => ({ ok: true }), sync: async () => ({ fetched: 3, errors: 0, unclassified: 0 }), verify: async () => ({ authHealthy: true, unclassified: 0, unexpectedErrors: 0, conflicts: 0, duplicateFnsId: 0, duplicateCanonical: 0, normalizationIssues: 0, graphValid: true, ledgerBalanceViolations: 0, coveragePass: true, layerGapsPass: true }), configPath: f.configPath });
  assert.equal(finished.user.state, ONBOARDING_STATES.ACTIVE);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8'))[1].enabled, true);
  await rm(f.dir, { recursive: true, force: true });
});

test('enablement saga compensates config when DB enablement fails', async () => {
  const f = await fixture();
  const user = { displayName: 'Saga User', sourceKey: 'fns-onboarding-saga', personKey: 'person-saga', sessionDir: path.join(f.dir, 'saga') };
  await f.store.save({ version: 1, users: [{ ...user, state: ONBOARDING_STATES.VERIFYING }] });
  const repository = { async ensureSource(source) { if (source.enabled) throw new Error('synthetic db failure'); return { id: 9, ...source }; } };
  await assert.rejects(() => enableSourceSaga({ store: f.store, repository, user, configPath: f.configPath }), /synthetic db failure/);
  assert.equal((await f.store.find(user.sourceKey)).state, ONBOARDING_STATES.PARTIAL_ENABLEMENT);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).find((source) => source.sourceKey === user.sourceKey).enabled, false);
  await rm(f.dir, { recursive: true, force: true });
});

test('onboarding identity is deterministic and does not contain credentials', () => {
  const identity = onboardingIdentity('User 3');
  assert.deepEqual(identity, onboardingIdentity('User 3'));
  assert.equal(Object.hasOwn(identity, 'accessToken'), false);
  assert.equal(Object.hasOwn(identity, 'refreshToken'), false);
});

test('finish without authenticated session fails closed and records auth failure', async () => {
  const f = await fixture();
  const repository = { async ensureSource(source) { return { id: 3, ...source }; } };
  await addOnboardingUser({ store: f.store, repository, displayName: 'User 3', sessionDir: path.join(f.dir, 'source-3'), configPath: f.configPath });
  await assert.rejects(() => finishOnboarding({
    store: f.store,
    repository,
    nameOrSource: 'User 3',
    sessionStore: { async load() { return { accessToken: null, refreshToken: null }; } },
    refresh: async () => { throw new Error('must not run'); },
    sync: async () => { throw new Error('must not run'); },
    verify: async () => ({}),
    configPath: f.configPath,
  }), /not authenticated/);
  assert.equal((await f.store.find('User 3')).state, ONBOARDING_STATES.AUTH_FAILED);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(config[1].enabled, false);
  await rm(f.dir, { recursive: true, force: true });
});

test('auth failure preserves the browser profile for retry', async () => {
  const f = await fixture();
  const repository = { async ensureSource(source) { return { id: 3, ...source }; } };
  const sessionDir = path.join(f.dir, 'fns-onboarding-auth-failure');
  await addOnboardingUser({ store: f.store, repository, displayName: 'Auth Failure', sessionDir, configPath: f.configPath });
  const profile = path.join(sessionDir, 'chromium-profile');
  await writeFile(path.join(profile, 'Cookies'), 'old-auth-marker');
  await assert.rejects(() => finishOnboarding({
    store: f.store, repository, nameOrSource: 'Auth Failure',
    sessionStore: { async load() { return { accessToken: null, refreshToken: null }; } },
    refresh: async () => { throw new Error('must not run'); }, sync: async () => { throw new Error('must not run'); }, verify: async () => ({}), configPath: f.configPath,
    stopAuth: async () => { throw new Error('must not stop browser'); }, cleanupAuth: async () => { throw new Error('must not clean profile'); },
  }), /not authenticated/);
  assert.equal(await readFile(path.join(profile, 'Cookies'), 'utf8'), 'old-auth-marker');
  await rm(f.dir, { recursive: true, force: true });
});

test('successful session validation removes only its source profile', async () => {
  const f = await fixture();
  const repository = { async ensureSource(source) { return { id: 3, ...source }; } };
  const sessionA = path.join(f.dir, 'fns-onboarding-a');
  const sessionB = path.join(f.dir, 'fns-onboarding-b');
  await addOnboardingUser({ store: f.store, repository, displayName: 'Cleanup A', sessionDir: sessionA, configPath: f.configPath });
  await writeFile(path.join(sessionA, 'chromium-profile', 'Cookies'), 'A');
  await mkdir(path.join(sessionB, 'chromium-profile'), { recursive: true });
  await writeFile(path.join(sessionB, 'chromium-profile', 'Cookies'), 'B');
  let cleaned = 0;
  await finishOnboarding({ store: f.store, repository, nameOrSource: 'Cleanup A', sessionStore: { async load() { return { accessToken: 'a', refreshToken: 'r' }; } }, refresh: async () => {}, stopAuth: async () => {}, cleanupAuth: async () => { cleaned += 1; await removeOnboardingProfile({ user: (await f.store.find('Cleanup A')), profileRoot: f.dir }); }, sync: async () => ({ errors: 1 }), verify: async () => ({}) }).catch((error) => assert.match(error.message, /Initial source sync failed/));
  assert.equal(cleaned, 1);
  await assert.rejects(() => access(path.join(sessionA, 'chromium-profile')));
  assert.equal(await readFile(path.join(sessionB, 'chromium-profile', 'Cookies'), 'utf8'), 'B');
  await rm(f.dir, { recursive: true, force: true });
});

test('profile cleanup is fail-closed and idempotent', async () => {
  const f = await fixture();
  const safeSession = path.join(f.dir, 'fns-onboarding-safe');
  const safeProfile = path.join(safeSession, 'chromium-profile');
  await mkdir(safeProfile, { recursive: true });
  const user = { sessionDir: safeSession, chromiumProfileDir: safeProfile };
  await writeFile(path.join(safeProfile, 'Local Storage'), 'previous-user');
  await removeOnboardingProfile({ user, profileRoot: f.dir });
  await removeOnboardingProfile({ user, profileRoot: f.dir });
  await assert.rejects(() => access(safeProfile));
  await assert.rejects(() => removeOnboardingProfile({
    user: { sessionDir: path.join(f.dir, 'fns-onboarding-safe'), chromiumProfileDir: path.join(f.dir, 'outside', 'chromium-profile') },
    profileRoot: f.dir,
  }), /path mismatch/);
  await rm(f.dir, { recursive: true, force: true });
});

test('sync failure can be retried from SessionStore without a browser profile', async () => {
  const f = await fixture();
  const repository = { async ensureSource(source) { return { id: 3, ...source }; } };
  const sessionDir = path.join(f.dir, 'fns-onboarding-retry');
  const added = await addOnboardingUser({ store: f.store, repository, displayName: 'Retry Without Browser', sessionDir, configPath: f.configPath });
  await removeOnboardingProfile({ user: added.user, profileRoot: f.dir });
  await f.store.save({ version: 1, users: [{ ...(await f.store.find(added.user.sourceKey)), state: ONBOARDING_STATES.SYNC_FAILED }] });
  let finishCalls = 0;
  const result = await retryOnboarding({ store: f.store, repository, nameOrSource: added.user.sourceKey, startAuth: async () => { throw new Error('browser must not start'); }, finish: async (user) => { finishCalls += 1; return { active: true, user }; } });
  assert.equal(result.action, 'FINISH');
  assert.equal(finishCalls, 1);
  await assert.rejects(() => access(path.join(sessionDir, 'chromium-profile')));
  await rm(f.dir, { recursive: true, force: true });
});

test('successful finish activates exactly once and passes the gate', async () => {
  const f = await fixture();
  const calls = [];
  const repository = { async ensureSource(source) { calls.push(source); return { id: 3, ...source }; } };
  await addOnboardingUser({ store: f.store, repository, displayName: 'User 3', sessionDir: path.join(f.dir, 'source-3'), configPath: f.configPath });
  const sessionStore = { async load() { return { accessToken: 'opaque', refreshToken: 'opaque' }; } };
  const result = await finishOnboarding({
    store: f.store,
    repository,
    nameOrSource: 'User 3',
    sessionStore,
    refresh: async () => ({ ok: true }),
    sync: async () => ({ fetched: 2, inserted: 0, errors: 0, unclassified: 0 }),
    verify: async () => ({ authHealthy: true, unclassified: 0, unexpectedErrors: 0, conflicts: 0, duplicateFnsId: 0, duplicateCanonical: 0, normalizationIssues: 0, graphValid: true, ledgerBalanceViolations: 0, coveragePass: true, layerGapsPass: true }),
    configPath: f.configPath,
  });
  assert.equal(result.active, true);
  assert.equal(result.user.state, ONBOARDING_STATES.ACTIVE);
  assert.equal(calls.at(-1).enabled, true);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8'))[1].enabled, true);
  const replay = await finishOnboarding({ store: f.store, repository, nameOrSource: 'User 3', sessionStore, refresh: async () => { throw new Error('must not refresh'); }, sync: async () => { throw new Error('must not sync'); }, verify: async () => ({}) });
  assert.equal(replay.active, true);
  if (process.platform !== 'win32') assert.equal((await stat(f.store.statePath)).mode & 0o777, 0o600);
  await rm(f.dir, { recursive: true, force: true });
});

test('config failure leaves onboarding failed and retry from SessionStore can reach ACTIVE', async () => {
  const f = await fixture();
  const repositoryCalls = [];
  const repository = { async ensureSource(source) { repositoryCalls.push(source); return { id: 101, ...source }; } };
  const added = await addOnboardingUser({ store: f.store, repository, displayName: 'Person A', sessionDir: path.join(f.dir, 'person-a'), configPath: f.configPath });
  const sessionStore = { async load() { return { accessToken: 'opaque', refreshToken: 'opaque' }; } };
  const verify = async () => ({ authHealthy: true, unclassified: 0, unexpectedErrors: 0, conflicts: 0, duplicateFnsId: 0, duplicateCanonical: 0, normalizationIssues: 0, graphValid: true, ledgerBalanceViolations: 0, coveragePass: true, layerGapsPass: true });
  await assert.rejects(() => finishOnboarding({
    store: f.store,
    repository,
    nameOrSource: added.user.sourceKey,
    sessionStore,
    refresh: async () => ({ ok: true }),
    sync: async () => ({ fetched: 1, errors: 0, unclassified: 0 }),
    verify,
    configPath: path.join(f.dir, 'missing', 'sources.json'),
  }));
  assert.equal((await f.store.find(added.user.sourceKey)).state, ONBOARDING_STATES.VERIFICATION_FAILED);
  assert.equal(repositoryCalls.some((source) => source.enabled === true), false);

  const retried = await finishOnboarding({
    store: f.store,
    repository,
    nameOrSource: added.user.sourceKey,
    sessionStore,
    refresh: async () => ({ ok: true }),
    sync: async () => ({ fetched: 1, errors: 0, unclassified: 0 }),
    verify,
    configPath: f.configPath,
  });
  assert.equal(retried.user.state, ONBOARDING_STATES.ACTIVE);
  assert.equal(repositoryCalls.some((source) => source.enabled === true), true);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).find((source) => source.sourceKey === added.user.sourceKey).enabled, true);
  await rm(f.dir, { recursive: true, force: true });
});

test('self-service onboarding can activate after session validation and defer receipt sync', async () => {
  const f = await fixture();
  const repository = { async ensureSource(source) { return { id: 3, ...source }; } };
  const added = await addOnboardingUser({ store: f.store, repository, displayName: 'Deferred User', sessionDir: path.join(f.dir, 'deferred'), configPath: f.configPath });
  let syncCalls = 0;
  const result = await finishOnboarding({
    store: f.store,
    repository,
    nameOrSource: added.user.sourceKey,
    sessionStore: { async load() { return { accessToken: 'opaque', refreshToken: 'opaque' }; } },
    refresh: async () => ({ ok: true }),
    sync: async () => { syncCalls += 1; return { errors: 0 }; },
    verify: async () => { throw new Error('accounting validators must not run during deferred onboarding'); },
    deferInitialSync: true,
    configPath: f.configPath,
  });
  assert.equal(result.user.state, ONBOARDING_STATES.ACTIVE);
  assert.equal(result.user.verification.deferredInitialSync, true);
  assert.equal(syncCalls, 0);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).find((item) => item.sourceKey === added.user.sourceKey).enabled, true);
  await rm(f.dir, { recursive: true, force: true });
});

test('atomic config update preserves other active sources', async () => {
  const f = await fixture();
  await updateSourceConfigAtomic({ configPath: f.configPath, source: { sourceKey: 'fns-onboarding-x', sessionDir: '/secure/x' }, enabled: false });
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(config.find((source) => source.sourceKey === 'legacy-default').enabled, true);
  assert.equal(config.find((source) => source.sourceKey === 'fns-onboarding-x').enabled, false);
  await rm(f.dir, { recursive: true, force: true });
});

test('Windows wrapper carries no credentials or token arguments', async () => {
  const wrapper = await readFile(new URL('../scripts/fns-user.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(wrapper, /accessToken|refreshToken|sms.?code|fns.?password|DB_PASSWORD/i);
  assert.match(wrapper, /Credential Manager|mstsc\.exe|127\.0\.0\.1/);
  assert.match(wrapper, /rm -rf -- \$profile/);
  assert.doesNotMatch(wrapper, /profileArchive|mv --/);
  assert.match(wrapper, /if \(\$Command -eq 'add'\)/);
  assert.doesNotMatch(wrapper, /if \(\$FreshProfile\)/);
});

test('config update helper allows only the named onboarding sources and denies others', async () => {
  const helper = await readFile(new URL('../scripts/receipt-config-update.js', import.meta.url), 'utf8');
  assert.match(helper, /const configPath = '\/etc\/finance-receipt-collector\/fns-sources\.json'/);
  assert.match(helper, /CONFIG_UPDATE_THIRD_SOURCE_DENIED/);
  assert.match(helper, /fns-onboarding-e33cdda7194a94e6/);
  assert.match(helper, /fns-onboarding-6200a906e9f34b08/);
  assert.match(helper, /current\.length > 4/);
  assert.match(helper, /CONFIG_UPDATE_SESSION_PATH_DENIED/);
  assert.doesNotMatch(helper, /process\.env\.DATABASE_URL|accessToken|refreshToken|cookie/i);
});

test('Linux fns-user runtime allowlists saved-profile import with one name argument', async () => {
  const runtime = await readFile(new URL('../scripts/fns-user-runtime.sh', import.meta.url), 'utf8');
  assert.match(runtime, /add\|import-profile\|status\|retry\|disable\|enable/);
  assert.match(runtime, /import-profile\|retry\|disable\|enable\)/);
  assert.doesNotMatch(runtime, /import-profile.*\$# -eq 1/);
});

test('one-shot E2E runner is safety-scoped and sanitized', async () => {
  const runner = await readFile(new URL('../scripts/verify-fns-self-service-e2e.ps1', import.meta.url), 'utf8');
  assert.match(runner, /function Resolve-Cli/);
  assert.match(runner, /Get-Command\s+-Name\s+\$Name/);
  assert.match(runner, /function Resolve-NpmCli/);
  assert.match(runner, /Resolve-NpmCli \$script:nodeCommand/);
  assert.match(runner, /node_modules\\npm\\bin\\npm-cli\.js/);
  assert.match(runner, /Get-Command npm\.cmd -CommandType Application/);
  assert.match(runner, /System\.Diagnostics\.ProcessStartInfo|Diagnostics\.ProcessStartInfo/);
  assert.match(runner, /UseShellExecute\s*=\s*\$false/);
  assert.match(runner, /RedirectStandardOutput\s*=\s*\$true/);
  assert.match(runner, /RedirectStandardError\s*=\s*\$true/);
  assert.match(runner, /function Invoke-ProjectNode/);
  assert.match(runner, /WorkingDirectory\s*=\s*\$WorkingDirectory/);
  assert.match(runner, /Invoke-NativeProcess \$script:nodeCommand \$Arguments \$InputText \$EnvironmentVariables \$projectRoot/);
  assert.match(runner, /Join-Path \$projectRoot 'node_modules\\pg\\package\.json'/);
  assert.match(runner, /PROJECT_PG_DEPENDENCY_NOT_FOUND/);
  assert.match(runner, /localExecution = \[ordered\]@\{ projectWorkingDirectory = \$projectRoot \}/);
  assert.doesNotMatch(runner, /Resolve-Cli 'npm\.exe'|Require-Command 'npm\.exe'/i);
  assert.doesNotMatch(runner, /npm\.exe/);
  assert.match(runner, /NPM_CLI_NOT_FOUND/);
  assert.match(runner, /resolvedCommands = \[ordered\]@\{ ssh = \$script:sshCommand; node = \$script:nodeCommand; npmCli = \$null \}/);
  assert.match(runner, /npmCli = \$script:npmCli/);
  assert.match(runner, /finance_receipt_collector_selfservice_e2e_/);
  assert.match(runner, /current_database\(\)/);
  assert.match(runner, /finally/);
  assert.match(runner, /report\.json/);
  assert.match(runner, /report\.md/);
  assert.match(runner, /production.*mutated\s*=\s*\$false/i);
  assert.doesNotMatch(runner, /accessToken\s*=|refreshToken\s*=|SMS.?code\s*=/i);
  assert.doesNotMatch(runner, /ALTER\s+ROLE\s+receipt_collector|DROP\s+TABLE|systemctl\s+(enable|disable|restart)/i);
  assert.match(runner, /tests\.exitCode|exitCode = \$testResult\.ExitCode/);
  assert.match(runner, /tests\.stdout|stdout = Sanitize-ProcessOutput \$testResult\.Stdout/);
  assert.match(runner, /stderr = Sanitize-ProcessOutput \$testResult\.Stderr/);
  assert.match(runner, /passed = if \(\$testCombined/);
  assert.match(runner, /failed = if \(\$testCombined/);
  assert.match(runner, /skipped = if \(\$testCombined/);
  assert.match(runner, /\$testResult\.ExitCode -ne 0/);
  assert.match(runner, /Invoke-ProjectNode \@\(\$script:npmCli, 'test'\)/);
  assert.match(runner, /Invoke-ProjectNode \@\('scripts\\run-fns-self-service-clone-e2e\.mjs'\)/);
  assert.doesNotMatch(runner, /Invoke-NodeWithDatabase "import '\.\/scripts\/run-fns-self-service-clone-e2e\.mjs';"/);
  assert.doesNotMatch(runner, /if \(\$testResult\.Stderr/);
});

test('runner anchors local Node resolution to project root, independent of caller cwd', () => {
  const projectRoot = 'C:\\Users\\Example\\Documents\\Test Project';
  const callerCwd = 'C:\\Users\\Example';
  const pgPackage = `${projectRoot}\\node_modules\\pg\\package.json`;
  assert.notEqual(callerCwd, projectRoot);
  assert.match(pgPackage, /Test Project\\node_modules\\pg\\package\.json/);
  assert.match('WorkingDirectory = $projectRoot', /WorkingDirectory\s*=\s*\$projectRoot/);
  assert.doesNotMatch(pgPackage, /C:\\Users\\Example\\node_modules/);
});

test('runner native npm result semantics use exit code, not stderr presence', () => {
  const succeeds = ({ exitCode }) => exitCode === 0;
  assert.equal(succeeds({ exitCode: 0, stderr: 'npm notice ...' }), true);
  assert.equal(succeeds({ exitCode: 0, stderr: 'npm WARN ...' }), true);
  assert.equal(succeeds({ exitCode: 1, stderr: 'npm ERR ...' }), false);
  assert.equal(succeeds({ exitCode: 1, stderr: '' }), false);
  assert.equal(succeeds({ exitCode: 0, stdout: '# pass 149\n# fail 0\n# skipped 4' }), true);
});

test('runner verifies PostgreSQL identity as postgres, not SSH root', async () => {
  const runner = await readFile(new URL('../scripts/verify-fns-self-service-e2e.ps1', import.meta.url), 'utf8');
  assert.match(runner, /sudo\s+-u\s+postgres\s+psql\s+-X\s+-v\s+ON_ERROR_STOP=1\s+-d\s+\$\(Quote-Posix \$Database\)\s+-Atq/);
  assert.match(runner, /sudo\s+-u\s+postgres\s+pg_restore/);
  assert.match(runner, /sudo\s+-u\s+postgres\s+dropdb/);
  assert.match(runner, /sudo\s+-u\s+postgres\s+dropuser/);
  assert.match(runner, /Invoke-RemotePsql 'CREATE_CLONE_ROLE'/);
  assert.match(runner, /function ConvertTo-SqlLiteral/);
  assert.match(runner, /function ConvertTo-SqlIdentifier/);
  assert.match(runner, /ConvertTo-SqlLiteral \$cloneRole/);
  assert.match(runner, /ConvertTo-SqlLiteral \$cloneDb/);
  assert.match(runner, /ConvertTo-SqlIdentifier \$cloneRole/);
  assert.match(runner, /function Get-RemoteSchemaSnapshot/);
  assert.match(runner, /schemaRequired = \$requiredSchemaTables/);
  assert.match(runner, /schemaPresent = \$productionSchema\.Present/);
  assert.match(runner, /schemaMissing = \$productionSchema\.Missing/);
  assert.match(runner, /schemaMissing = \$cloneSchema\.Missing/);
  assert.match(runner, /hasFnsSourceReceiptRefs/);
  assert.match(runner, /backup\.status = 'STALE_SCHEMA'/);
  assert.match(runner, /backup\.conclusion = if \(\$report\.production\.schemaMissing\.Count -eq 0\) \{ 'STALE_BACKUP'/);
  assert.match(runner, /\$cloneDb -notmatch '\^\[a-z\]\[a-z0-9_\]\*\$'/);
  assert.match(runner, /\$cloneRole -notmatch '\^\[a-z\]\[a-z0-9_\]\*\$'/);
  assert.match(runner, /commandClass\s*=\s*Get-RemoteCommandClass/);
  assert.match(runner, /exitCode\s*=\s*\$result\.ExitCode/);
  assert.match(runner, /stderr\s*=\s*Sanitize-RemoteError \$result\.Stderr/);
  assert.match(runner, /Invoke-RemotePsql 'PRODUCTION_DATABASE_IDENTITY' 'SELECT current_database\(\);'/);
  assert.match(runner, /identityResult\.ExitCode/);
  assert.match(runner, /identityResult\.Stderr/);
  assert.match(runner, /remoteDatabase = \$identityResult\.Stdout\.Trim\(\)/);
  assert.match(runner, /-cne\s+'finance_receipt_collector'/);
  assert.doesNotMatch(runner, /--username=postgres.*current_database|--username=root.*current_database/i);
  assert.doesNotMatch(runner, /(?:^|\s)(?:psql|pg_restore|createdb|dropdb|createuser|dropuser)\b[^\n]*--username=postgres/i);
  assert.match(runner, /sudo\s+-u\s+postgres\s+dropdb\s+--if-exists/);
  assert.match(runner, /sudo\s+-u\s+postgres\s+dropuser\s+--if-exists/);
  assert.match(runner, /function Invoke-CloneGrant/);
  assert.match(runner, /SELECT current_database\(\);/);
  assert.match(runner, /GRANT USAGE, CREATE ON SCHEMA public TO \$cloneRoleIdentifier/);
  assert.match(runner, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \$cloneRoleIdentifier/);
  assert.match(runner, /GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO \$cloneRoleIdentifier/);
  assert.match(runner, /privilegesConfigured = \$true/);
  assert.match(runner, /rolePreflight = 'PASS'/);
  assert.match(runner, /rolePreflightError = \[ordered\]@\{ commandClass = 'CLONE_ROLE_PREFLIGHT'/);
  assert.match(runner, /code = if \(\$preflightMessage -match '42501\|permission denied'/);
  assert.match(runner, /object = \$preflightObject/);
  assert.doesNotMatch(runner, /ALTER DEFAULT PRIVILEGES/);
  assert.doesNotMatch(runner, /CREATE ROLE[^;]*(?:SUPERUSER|CREATEDB|CREATEROLE)/i);
});

test('temporary Codex VPS access is restricted, expiring and fail-closed', async () => {
  const bootstrap = await readFile(new URL('../scripts/bootstrap-codex-vps-access.ps1', import.meta.url), 'utf8');
  const revoke = await readFile(new URL('../scripts/revoke-codex-vps-access.ps1', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../scripts/receipt-codex-admin.sh', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../scripts/verify-fns-self-service-e2e.ps1', import.meta.url), 'utf8');
  assert.match(bootstrap, /Get-Command ssh-keygen\.exe -CommandType Application/);
  assert.match(bootstrap, /Start-Process -FilePath \$sshKeygen -ArgumentList \$keygenArguments/);
  assert.match(bootstrap, /-N ""/);
  assert.match(bootstrap, /Remove-Item -LiteralPath \$privateKey,\$publicKey/);
  assert.match(bootstrap, /PermanentKey/);
  assert.doesNotMatch(bootstrap, /Get-Content[^\n]*PermanentKey|ReadAllText[^\n]*PermanentKey/);
  assert.match(bootstrap, /ProcessStartInfo/);
  assert.match(bootstrap, /RedirectStandardInput=\$true/);
  assert.match(bootstrap, /StandardInput\.Write\(\$Payload\)/);
  assert.doesNotMatch(bootstrap, /^\uFEFF/);
  assert.match(bootstrap, /receipt-codex-expiry\.timer/);
  assert.match(bootstrap, /OnActiveSec=__HOURS__h/);
  assert.doesNotMatch(bootstrap, /(?<!Sec)OnActive=__HOURS__h/);
  assert.match(bootstrap, /home='\/home\/codex-receipt'/);
  assert.match(bootstrap, /usermod --home \"\$home\"/);
  assert.match(bootstrap, /\.ssh\/authorized_keys/);
  assert.match(bootstrap, /AuthorizedKeysFile \$home\/\.ssh\/authorized_keys/);
  assert.match(bootstrap, /PasswordAuthentication no/);
  assert.match(bootstrap, /KbdInteractiveAuthentication no/);
  assert.match(bootstrap, /AuthenticationMethods publickey/);
  assert.match(bootstrap, /if \[ -n "\$\{SSH_ORIGINAL_COMMAND:-\}" \]; then/);
  assert.match(bootstrap, /elif \[ "\$\{1:-\}" = '-c' \]; then/);
  assert.match(bootstrap, /shift/);
  assert.match(bootstrap, /requested_command=\$\*/);
  assert.match(bootstrap, /set -f/);
  assert.match(bootstrap, /set -- \$requested_command/);
  assert.match(bootstrap, /exec sudo -n \/usr\/local\/sbin\/receipt-codex-admin "\$@"/);
  assert.doesNotMatch(bootstrap, /tr -cd '\[:alnum:\]_- '/);
  assert.match(bootstrap, /sshd -t/);
  assert.match(bootstrap, /sshd -T -C/);
  assert.match(bootstrap, /server_fingerprint/);
  assert.match(bootstrap, /__PUBLIC_KEY_B64__/);
  assert.match(bootstrap, /__EXPECTED_FINGERPRINT__/);
  assert.doesNotMatch(bootstrap, /bash -s.*\$pubB64/);
  assert.match(bootstrap, /Temporary SSH credential validation failed/);
  assert.match(bootstrap, /WindowsIdentity\]::GetCurrent\(\)\)\.User\.Value/);
  assert.match(bootstrap, /Set-TemporaryAccessAcl/);
  assert.match(bootstrap, /SetAccessRuleProtection/);
  assert.match(bootstrap, /GetAccessControl\(\[Security\.AccessControl\.AccessControlSections\]::Access\)/);
  assert.match(bootstrap, /SetAccessControl\(\$acl\)/);
  assert.match(bootstrap, /S-1-5-18/);
  assert.match(bootstrap, /S-1-5-32-544/);
  assert.match(bootstrap, /permitopen=\\?"127\.0\.0\.1:5432/);
  assert.match(bootstrap, /NOPASSWD:/);
  assert.match(bootstrap, /visudo -cf/);
  assert.match(revoke, /authorized_keys\/codex-receipt/);
  assert.match(revoke, /receipt-codex-expiry\.timer/);
  assert.match(revoke, /ProcessStartInfo/);
  assert.match(revoke, /Temporary key still authenticates/);
  assert.match(revoke, /Temporary key revoke could not be verified/);
  assert.match(revoke, /permission denied\|sign_and_send_pubkey\|no supported authentication methods/);
  assert.match(revoke, /sshd -t/);
  assert.match(revoke, /sshd_config\.d\/receipt-codex\.conf/);
  assert.match(revoke, /userdel --remove codex-receipt/);
  assert.doesNotMatch(revoke, /^\uFEFF/);
  assert.match(helper, /PRODUCTION_DATABASE_FORBIDDEN/);
  assert.match(helper, /QUERY_NOT_ALLOWLISTED/);
  assert.match(helper, /finance_receipt_collector_selfservice_e2e_/);
  assert.match(helper, /selfservice_e2e_/);
  assert.match(helper, /clone-restore-status/);
  assert.match(helper, /clone-exists/);
  assert.match(helper, /clone-role-exists/);
  assert.match(helper, /current_db\(\)/);
  assert.doesNotMatch(helper, /SSH_ORIGINAL_COMMAND/);
  assert.doesNotMatch(helper, /psql[^\n]*\$\{?SSH_ORIGINAL_COMMAND/);
  assert.match(runner, /codexAccessKey/);
  assert.match(runner, /codex-receipt/);
  assert.match(runner, /Codex remote capability is not allowlisted/);
  assert.match(runner, /clone-grant \$cloneDb \$cloneRole/);
  assert.match(runner, /CLEANUP_VERIFY_DATABASE.*clone-exists/);
  assert.match(runner, /CLEANUP_VERIFY_ROLE.*clone-role-exists/);
  assert.match(runner, /cloneDropSucceeded/);
});

test('runner fail-closes clone creation and verifies cleanup resources', async () => {
  const runner = await readFile(new URL('../scripts/verify-fns-self-service-e2e.ps1', import.meta.url), 'utf8');
  const roleCreate = runner.lastIndexOf("'CREATE_CLONE_ROLE'");
  const roleVerify = runner.lastIndexOf("'VERIFY_CLONE_ROLE'");
  const dbCreate = runner.lastIndexOf("'CREATE_CLONE_DATABASE'");
  const dbVerify = runner.lastIndexOf("'VERIFY_CLONE_DATABASE'");
  const createdFlag = runner.indexOf('$report.clone.created = $true');
  const restore = runner.lastIndexOf("'RESTORE_CLONE_DATABASE'");
  const restoreVerify = runner.lastIndexOf("'VERIFY_CLONE_RESTORE'");
  assert.ok(roleCreate >= 0 && roleVerify > roleCreate);
  assert.ok(dbCreate > roleVerify && dbVerify > dbCreate);
  assert.ok(createdFlag > dbVerify && createdFlag < restore);
  assert.ok(restore > dbVerify && restoreVerify > restore);
  assert.match(runner, /\$report\.clone\.created\s*=\s*\$true/);
  assert.match(runner, /\$dbVerify\.Stdout\.Trim\(\)\s*-cne\s+\$cloneDb/);
  assert.match(runner, /\$report\.clone\.created\s*=\s*\$true[\s\S]*?\$restore\s*=/);
  assert.match(runner, /CLEANUP_DROP_CLONE_DATABASE/);
  assert.match(runner, /CLEANUP_DROP_CLONE_ROLE/);
  assert.match(runner, /database remains:/);
  assert.match(runner, /role remains:/);
  assert.match(runner, /cleanup\.status\s*=\s*'COMPLETE'/);
  assert.doesNotMatch(runner, /\$report\.clone\.created\s*=\s*\$true\s*\r?\n\s*Invoke-Ssh/);
  assert.doesNotMatch(runner, /if\s*\(\$report\.clone\.created\)/);
});

test('runner keeps SQL with shell punctuation in one remote command argument', async () => {
  const runner = await readFile(new URL('../scripts/verify-fns-self-service-e2e.ps1', import.meta.url), 'utf8');
  assert.match(runner, /function Quote-Posix/);
  assert.match(runner, /function Invoke-RemoteCommand/);
  assert.match(runner, /function Invoke-RemotePsql/);
  assert.match(runner, /Invoke-RemoteCommand \$remoteCommand \$Sql/);
  assert.match(runner, /-X -v ON_ERROR_STOP=1 -d .* -Atq/);
  assert.match(runner, /\$args\s*=\s*\@\([^\n]+\$Command\)/);
  assert.doesNotMatch(runner, /psql[^\n]*-c|psql[^\n]*-Atqc/i);
  assert.match(runner, /singleQuoteEscape/);
  for (const sql of ["SELECT rolname FROM pg_roles WHERE rolname = 'selfservice_e2e_abc123';", "SELECT '(';", "SELECT 'a b';", "SELECT 'it''s';", "SELECT 'x;y';"]) {
    assert.match(sql, /\(|;|'|\s/);
    assert.doesNotMatch("sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d 'postgres' -Atq", new RegExp(sql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('runner pins backup validation to the dedicated restricted capability', async () => {
  const runner = await readFile(path.join(process.cwd(), 'scripts', 'verify-fns-self-service-e2e.ps1'), 'utf8');
  assert.match(runner, /CommandClass -eq 'BACKUP_VALIDATION'/);
  assert.match(runner, /\$Command = 'backup-validate'/);
});

test('runner terminates restricted clone-role password stdin with a newline', async () => {
  const runner = await readFile(path.join(process.cwd(), 'scripts', 'verify-fns-self-service-e2e.ps1'), 'utf8');
  assert.match(runner, /CREATE_CLONE_ROLE.*Groups\[1\]\.Value\.Replace\("''", "'"\)\) \+ "`n"/);
});

test('runner generates lowercase clone database identifiers accepted by the restricted helper', async () => {
  const runner = await readFile(path.join(process.cwd(), 'scripts', 'verify-fns-self-service-e2e.ps1'), 'utf8');
  assert.match(runner, /ToString\('yyyyMMddTHHmmssZ'\)\.ToLowerInvariant\(\)/);
});

test('runner verifies the clone database, not the administrative postgres database', async () => {
  const runner = await readFile(new URL('../scripts/verify-fns-self-service-e2e.ps1', import.meta.url), 'utf8');
  assert.match(runner, /VERIFY_CLONE_DATABASE\|VERIFY_CLONE_RESTORE\|VERIFY_CLONE_GRANT_DATABASE.*clone-query \$cloneDb identity/);
});

test('runner preserves Unicode Windows paths and avoids 8.3/TEMP workarounds', async () => {
  const runner = await readFile(new URL('../scripts/verify-fns-self-service-e2e.ps1', import.meta.url), 'utf8');
  const unicodeFixture = {
    profile: 'C:\\Users\\Example',
    project: 'C:\\Users\\Example\\Documents\\Test Project',
    sshKey: 'C:\\Users\\Example\\.ssh\\private-key'
  };
  assert.equal(unicodeFixture.project.includes('~1'), false);
  assert.equal(unicodeFixture.sshKey.includes('~1'), false);
  assert.match(runner, /\$env:FINANCE_VPS_SSH_KEY/);
  assert.match(runner, /Join-Path \$unicodeUserProfile ['"]AppData\\Local\\Temp['"]/);
  assert.match(runner, /\$projectRoot = \(Resolve-Path/);
  assert.match(runner, /['"]-i['"],\$SshKey/);
  assert.doesNotMatch(runner, /9A4B~1|ShortPath|GetShortPathName|%~s|cmd\.exe|8\.3/i);
  assert.doesNotMatch(runner, /\$env:TEMP/);
  assert.match(runner, /Start-Process -FilePath \$script:sshCommand -ArgumentList \@\(/);
});

test('browser launcher login phase is vanilla and import phase binds CDP to localhost', async () => {
  const f = await fixture();
  const user = { sourceId: 7, sessionDir: path.join(f.dir, 'fns-onboarding-source-7'), chromiumProfileDir: path.join(f.dir, 'fns-onboarding-source-7', 'chromium-profile') };
  await mkdir(user.sessionDir, { recursive: true });
  const calls = [];
  const result = await startOnboardingBrowser({ user, executable: '/opt/chromium', spawnImpl: (...args) => { calls.push(args); return { pid: 7007 }; } });
  assert.equal(result.phase, 'login');
  assert.equal(result.cdpUrl, null);
  assert.equal(calls[0][1].some((arg) => arg.includes(user.chromiumProfileDir)), true);
  assert.equal(calls[0][1].some((arg) => arg.startsWith('--remote-debugging-')), false);
  assert.equal(Number((await readFile(path.join(user.sessionDir, 'chromium.pid'), 'utf8')).trim()), 7007);
  const importResult = await startOnboardingBrowser({ user, executable: '/opt/chromium', phase: 'import', preserveProfile: true, spawnImpl: (...args) => { calls.push(args); return { pid: 7008 }; } });
  assert.equal(importResult.cdpUrl, `http://127.0.0.1:${onboardingCdpPort(7)}`);
  assert.equal(calls[1][1].includes('--remote-debugging-address=127.0.0.1'), true);
  assert.equal(calls[1][1].includes('--remote-debugging-port=19207'), true);
  let killed;
  await writeFile(path.join(user.sessionDir, 'chromium.pid'), '7008\n');
  await stopOnboardingBrowser({ user, kill: (pid, signal) => { killed = [pid, signal]; }, isAlive: () => false });
  assert.deepEqual(killed, [7008, 'SIGTERM']);
  await rm(f.dir, { recursive: true, force: true });
});

test('profile import recovery distinguishes an existing profile from a missing profile', async () => {
  const f = await fixture();
  const user = {
    sourceId: 19,
    sessionDir: path.join(f.dir, 'fns-onboarding-source-19'),
    chromiumProfileDir: path.join(f.dir, 'fns-onboarding-source-19', 'chromium-profile'),
  };
  await mkdir(user.chromiumProfileDir, { recursive: true });
  assert.equal(await requireOnboardingProfile({ user }), user.chromiumProfileDir);
  await rm(user.chromiumProfileDir, { recursive: true, force: true });
  await assert.rejects(() => requireOnboardingProfile({ user }), (error) => error.code === 'PROFILE_NOT_FOUND' && error.message === 'ONBOARDING_PROFILE_NOT_FOUND');
  await rm(f.dir, { recursive: true, force: true });
});

test('finish runs the verification gate again after enablement', async () => {
  const f = await fixture();
  const repository = { async ensureSource(source) { return { id: 3, ...source }; } };
  await addOnboardingUser({ store: f.store, repository, displayName: 'Final Verify', sessionDir: path.join(f.dir, 'source-3'), configPath: f.configPath });
  let verifyCalls = 0;
  const verify = async () => { verifyCalls += 1; return { authHealthy: true, unclassified: 0, unexpectedErrors: 0, conflicts: 0, duplicateFnsId: 0, duplicateCanonical: 0, normalizationIssues: 0, graphValid: true, ledgerBalanceViolations: 0, coveragePass: true, layerGapsPass: true }; };
  await finishOnboarding({ store: f.store, repository, nameOrSource: 'Final Verify', sessionStore: { async load() { return { accessToken: 'a', refreshToken: 'r' }; } }, refresh: async () => {}, sync: async () => ({ errors: 0 }), verify, configPath: f.configPath });
  assert.equal(verifyCalls, 2);
  await rm(f.dir, { recursive: true, force: true });
});

test('retry resumes auth states without changing source identity', async () => {
  const f = await fixture();
  const repository = { async ensureSource(source) { return { id: 3, ...source }; } };
  const added = await addOnboardingUser({ store: f.store, repository, displayName: 'Retry User', sessionDir: path.join(f.dir, 'source-3'), configPath: f.configPath });
  let started = 0;
  const result = await retryOnboarding({ store: f.store, repository, nameOrSource: added.user.sourceKey, startAuth: async () => { started += 1; return { started: true }; } });
  assert.equal(result.action, 'AUTH_REQUIRED');
  assert.equal(started, 1);
  assert.equal((await f.store.load()).users.length, 1);
  assert.equal((await f.store.find(added.user.sourceKey)).sourceKey, added.user.sourceKey);
  await rm(f.dir, { recursive: true, force: true });
});

test('retry reconciles partial enablement to disabled without creating a source', async () => {
  const f = await fixture();
  const calls = [];
  const repository = { async ensureSource(source) { calls.push(source); return source; } };
  const user = { displayName: 'Partial User', sourceKey: 'fns-onboarding-partial', personKey: 'person-partial', sessionDir: path.join(f.dir, 'partial'), state: ONBOARDING_STATES.PARTIAL_ENABLEMENT };
  await f.store.save({ version: 1, users: [user] });
  const result = await retryOnboarding({ store: f.store, repository, nameOrSource: user.sourceKey, reconcile: async () => ({ state: 'DISABLED' }) });
  assert.equal(result.action, 'RECONCILE_DISABLED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].enabled, false);
  await rm(f.dir, { recursive: true, force: true });
});

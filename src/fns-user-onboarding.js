import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { onboardingChromiumProfile } from './browser-session-import.js';
import { onboardingCdpPort } from './onboarding-browser.js';

export const ONBOARDING_STATES = Object.freeze({
  CREATED: 'CREATED',
  WAITING_AUTH: 'WAITING_AUTH',
  AUTHENTICATED: 'AUTHENTICATED',
  INITIAL_SYNC: 'INITIAL_SYNC',
  VERIFYING: 'VERIFYING',
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  AUTH_FAILED: 'AUTH_FAILED',
  SYNC_FAILED: 'SYNC_FAILED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  PARTIAL_ENABLEMENT: 'PARTIAL_ENABLEMENT',
});

const FAILURE_STATES = new Set([
  ONBOARDING_STATES.AUTH_FAILED,
  ONBOARDING_STATES.SYNC_FAILED,
  ONBOARDING_STATES.VERIFICATION_FAILED,
]);

function sourceDigest(displayName) {
  return crypto.createHash('sha256').update(displayName, 'utf8').digest('hex').slice(0, 16);
}

export function onboardingIdentity(displayName) {
  const name = String(displayName ?? '').trim();
  if (!name || name.length > 120) throw new Error('Display name must be 1..120 characters');
  return {
    displayName: name,
    personKey: `onboarding-${sourceDigest(name)}`,
    sourceKey: `fns-onboarding-${sourceDigest(name)}`,
  };
}

function defaultStatePath() {
  return process.env.FNS_ONBOARDING_STATE_FILE
    || path.join(process.env.RECEIPT_COLLECTOR_STATE_DIR || '.receipt-collector', 'onboarding.json');
}

export class OnboardingStore {
  constructor({ statePath = defaultStatePath(), fsImpl = fs } = {}) {
    this.statePath = statePath;
    this.fs = fsImpl;
  }

  async load() {
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.statePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.users)) throw new Error('Invalid onboarding state');
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, users: [] };
      throw error;
    }
  }

  async save(state) {
    const directory = path.dirname(this.statePath);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.fs.chmod) await this.fs.chmod(directory, 0o700);
    const temporary = `${this.statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await this.fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (this.fs.chmod) await this.fs.chmod(temporary, 0o600);
    await this.fs.rename(temporary, this.statePath);
    if (this.fs.chmod) await this.fs.chmod(this.statePath, 0o600);
  }

  async find(nameOrSource) {
    const state = await this.load();
    return state.users.find((user) => user.displayName === nameOrSource || user.sourceKey === nameOrSource || String(user.sourceId) === String(nameOrSource)) ?? null;
  }
}

export async function updateSourceConfigAtomic({ configPath, source, enabled, fsImpl = fs }) {
  if (!configPath) throw new Error('FNS_SOURCES_CONFIG is required');
  if (process.env.FNS_CONFIG_UPDATE_HELPER === '1') {
    const expectedPath = '/etc/finance-receipt-collector/fns-sources.json';
    if (configPath !== expectedPath) throw new Error('CONFIG_UPDATE_PATH_DENIED');
    const helper = process.env.FNS_CONFIG_UPDATE_HELPER_PATH || '/usr/local/sbin/receipt-config-update';
    const payload = JSON.stringify({
      operation: enabled ? 'enable' : 'upsert-disabled',
      source: {
        sourceKey: source.sourceKey,
        displayName: source.displayName,
        scopeKey: source.scopeKey,
        personKey: source.personKey,
        personDisplayName: source.personDisplayName,
        sessionDir: source.sessionDir,
        sessionRef: source.sessionRef,
        deviceRef: source.deviceRef,
      },
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sudo', ['-n', helper], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CONFIG_UPDATE_FAILED:${code}`)));
      child.stdin.end(payload);
    });
    let output;
    try { output = JSON.parse(result.stdout); } catch { throw new Error('CONFIG_UPDATE_INVALID_HELPER_OUTPUT'); }
    if (output?.ok !== true) throw new Error('CONFIG_UPDATE_REJECTED');
    return { backupPath: output.backupPath, added: Boolean(output.added) };
  }
  const current = JSON.parse(await fsImpl.readFile(configPath, 'utf8'));
  if (!Array.isArray(current)) throw new Error('FNS_SOURCES_CONFIG must contain an array');
  const index = current.findIndex((item) => item.sourceKey === source.sourceKey);
  const nextSource = { ...source, enabled };
  const next = index < 0 ? [...current, nextSource] : current.map((item, itemIndex) => itemIndex === index ? { ...item, enabled } : item);
  const backupPath = `${configPath}.bak`;
  await fsImpl.copyFile(configPath, backupPath);
  const temporary = `${configPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsImpl.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (fsImpl.chmod) await fsImpl.chmod(temporary, 0o600);
  await fsImpl.rename(temporary, configPath);
  if (fsImpl.chmod) await fsImpl.chmod(configPath, 0o600);
  return { backupPath, added: index < 0 };
}

async function updateUser(store, sourceKey, update) {
  const state = await store.load();
  const index = state.users.findIndex((user) => user.sourceKey === sourceKey);
  if (index < 0) throw new Error(`Onboarding source not found: ${sourceKey}`);
  state.users[index] = { ...state.users[index], ...update, updatedAt: new Date().toISOString() };
  await store.save(state);
  return state.users[index];
}

export async function updateOnboardingState(store, sourceKey, state, extra = {}) {
  if (!Object.values(ONBOARDING_STATES).includes(state)) throw new Error(`Invalid onboarding state: ${state}`);
  const lifecycle = state === ONBOARDING_STATES.ACTIVE
    ? { disabled: false }
    : FAILURE_STATES.has(state) || state === ONBOARDING_STATES.PARTIAL_ENABLEMENT || state === ONBOARDING_STATES.DISABLED
      ? { disabled: true }
      : {};
  return updateUser(store, sourceKey, { state, ...lifecycle, ...extra });
}

export async function enableSourceSaga({ store, repository, user, configPath, verify = async () => true }) {
  const source = { scopeKey: 'default', sourceKey: user.sourceKey, displayName: user.displayName, sessionDir: user.sessionDir, sessionRef: `filesystem:${user.sessionDir}/session.json`, deviceRef: `filesystem:${user.sessionDir}/device.json`, personKey: user.personKey, personDisplayName: user.displayName };
  await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.VERIFYING, { enablementState: 'PREPARED' });
  let configEnabled = false;
  let dbEnabled = false;
  try {
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.VERIFYING, { enablementState: 'CONFIG_STAGED' });
    if (configPath) {
      await updateSourceConfigAtomic({ configPath, source, enabled: true });
      configEnabled = true;
    }
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.VERIFYING, { enablementState: 'DB_ENABLED' });
    await repository.ensureSource({ ...source, enabled: true });
    dbEnabled = true;
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.VERIFYING, { enablementState: 'CONFIG_COMMITTED' });
    const verified = await verify(user);
    if (!verified) throw new Error('Final multi-source verification failed');
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.VERIFYING, { enablementState: 'VERIFYING' });
    return { configEnabled, dbEnabled };
  } catch (error) {
    try {
      if (configEnabled && configPath) await updateSourceConfigAtomic({ configPath, source, enabled: false });
      if (dbEnabled) await repository.ensureSource({ ...source, enabled: false });
      await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.PARTIAL_ENABLEMENT, { enablementState: 'COMPENSATED', lastError: error.code || error.message });
    } catch (compensationError) {
      await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.PARTIAL_ENABLEMENT, { enablementState: 'COMPENSATION_FAILED', lastError: compensationError.code || compensationError.message });
    }
    throw error;
  }
}

export async function addOnboardingUser({ store, repository, displayName, sessionDir, configPath, cdpUrl, startAuth = async () => ({ started: false }) }) {
  const identity = onboardingIdentity(displayName);
  const current = await store.find(identity.sourceKey);
  if (current) {
    if (current.displayName !== identity.displayName) throw new Error('Onboarding identity collision');
    return { created: false, resumed: true, user: current };
  }
  const existing = await store.find(identity.displayName);
  if (existing) return { created: false, resumed: true, user: existing };
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await fs.chmod(sessionDir, 0o700);
  const chromiumProfileDir = onboardingChromiumProfile(sessionDir);
  await fs.mkdir(chromiumProfileDir, { recursive: true, mode: 0o700 });
  await fs.chmod(chromiumProfileDir, 0o700);
  const source = await repository.ensureSource({
    scopeKey: 'default',
    sourceKey: identity.sourceKey,
    displayName: identity.displayName,
    sessionRef: `filesystem:${sessionDir}/session.json`,
    deviceRef: `filesystem:${sessionDir}/device.json`,
    personKey: identity.personKey,
    personDisplayName: identity.displayName,
    enabled: false,
  });
  const state = await store.load();
  const user = {
    ...identity,
    sourceId: source.id,
    sessionDir,
    chromiumProfileDir,
    cdpUrl: cdpUrl || `http://127.0.0.1:${onboardingCdpPort(source.id)}`,
    state: ONBOARDING_STATES.CREATED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.users.push(user);
  await store.save(state);
  await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH);
  if (configPath) await updateSourceConfigAtomic({ configPath, source: { sourceKey: user.sourceKey, displayName: user.displayName, scopeKey: 'default', personKey: user.personKey, personDisplayName: user.displayName, sessionDir: user.sessionDir, sessionRef: `filesystem:${user.sessionDir}/session.json`, deviceRef: `filesystem:${user.sessionDir}/device.json` }, enabled: false });
  const auth = await startAuth(user);
  return { created: true, resumed: false, user: { ...(await store.find(user.sourceKey)), authStarted: Boolean(auth?.started) } };
}

function gatePass(result) {
  return Boolean(result?.authHealthy
    && Number(result?.unclassified ?? 0) === 0
    && Number(result?.unexpectedErrors ?? 0) === 0
    && Number(result?.conflicts ?? 0) === 0
    && Number(result?.duplicateFnsId ?? 0) === 0
    && Number(result?.duplicateCanonical ?? 0) === 0
    && Number(result?.normalizationIssues ?? 0) === 0
    && result?.graphValid === true
    && Number(result?.ledgerBalanceViolations ?? 0) === 0
    && result?.coveragePass === true
    && result?.layerGapsPass === true);
}

export async function finishOnboarding({ store, repository, nameOrSource, sessionStore, refresh, sync, verify, configPath, deferInitialSync = false, stopAuth = async () => {}, cleanupAuth = async () => {} }) {
  const user = await store.find(nameOrSource);
  if (!user) throw new Error('Onboarding user/source not found');
  if (user.state === ONBOARDING_STATES.ACTIVE) {
    const normalized = user.disabled === true
      ? await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.ACTIVE)
      : user;
    return { active: true, user: normalized };
  }
  try {
    const session = await sessionStore.load();
    if (!session.accessToken || !session.refreshToken) throw Object.assign(new Error('FNS session is not authenticated'), { code: 'AUTH_RELOGIN_REQUIRED' });
    await refresh(session);
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.AUTHENTICATED, { sessionValidated: true });
    // Once refresh has validated the browser-bound session, the SessionStore is
    // the source of truth. Remove only this source's browser profile before
    // sync/verification so later retries do not depend on Chromium.
    await stopAuth(user);
    await cleanupAuth(user);
    if (deferInitialSync) {
      await enableSourceSaga({
        store,
        repository,
        user,
        configPath,
        verify: async () => true,
      });
      return { active: true, user: await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.ACTIVE, {
        lastSync: null,
        verification: { authHealthy: true, deferredInitialSync: true },
        verificationCompleted: true,
      }) };
    }
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.INITIAL_SYNC);
    const syncResult = await sync(user);
    if (syncResult?.errors || syncResult?.unclassified || syncResult?.authError) throw new Error('Initial source sync failed');
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.INITIAL_SYNC, { initialSyncCompleted: true });
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.VERIFYING);
    const verification = await verify(user, syncResult);
    if (!gatePass(verification)) throw new Error('Onboarding verification gate failed');
    await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.VERIFYING, { verificationCompleted: true });
    await enableSourceSaga({
      store,
      repository,
      user,
      configPath,
      // Re-run the real gate after both DB and config are enabled. This closes
      // the window where activation could succeed but multi-source validation
      // was only checked against the disabled state.
      verify: async () => gatePass(await verify(user, { ...syncResult, finalVerification: true })),
    });
    return { active: true, user: await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.ACTIVE, { lastSync: syncResult, verification }) };
  } catch (error) {
    const state = error.code === 'AUTH_RELOGIN_REQUIRED' ? ONBOARDING_STATES.AUTH_FAILED : (error.message.includes('sync') ? ONBOARDING_STATES.SYNC_FAILED : ONBOARDING_STATES.VERIFICATION_FAILED);
    await updateOnboardingState(store, user.sourceKey, state, { lastError: error.code || error.message });
    throw error;
  }
}

export async function retryOnboarding({ store, repository, nameOrSource, startAuth = async () => ({ started: false }), finish = async () => { throw new Error('finish hook is required'); }, reconcile = async () => ({ state: 'DISABLED' }) }) {
  const user = await store.find(nameOrSource);
  if (!user) throw new Error('Onboarding user/source not found');
  if (user.state === ONBOARDING_STATES.ACTIVE) return { resumed: false, active: true, user };
  if ([ONBOARDING_STATES.WAITING_AUTH, ONBOARDING_STATES.AUTH_FAILED].includes(user.state)) {
    const auth = await startAuth(user);
    const next = await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.WAITING_AUTH, { authStarted: Boolean(auth?.started), lastError: null });
    return { resumed: true, action: 'AUTH_REQUIRED', user: next };
  }
  if ([ONBOARDING_STATES.AUTHENTICATED, ONBOARDING_STATES.INITIAL_SYNC, ONBOARDING_STATES.SYNC_FAILED, ONBOARDING_STATES.VERIFYING, ONBOARDING_STATES.VERIFICATION_FAILED].includes(user.state)) {
    return { resumed: true, action: 'FINISH', result: await finish(user) };
  }
  if (user.state === ONBOARDING_STATES.PARTIAL_ENABLEMENT) {
    const result = await reconcile(user);
    if (result?.state === ONBOARDING_STATES.ACTIVE || result?.active === true) {
      const active = await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.ACTIVE, { enablementState: 'RECONCILED' });
      return { resumed: true, action: 'RECONCILE', user: active, result };
    }
    await repository.ensureSource({ scopeKey: 'default', sourceKey: user.sourceKey, displayName: user.displayName, sessionRef: `filesystem:${user.sessionDir}/session.json`, deviceRef: `filesystem:${user.sessionDir}/device.json`, personKey: user.personKey, personDisplayName: user.displayName, enabled: false });
    const disabled = await updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.DISABLED, { disabled: true, enablementState: 'RECONCILED_DISABLED' });
    return { resumed: true, action: 'RECONCILE_DISABLED', user: disabled, result };
  }
  throw new Error(`Onboarding state cannot be retried: ${user.state}`);
}

export async function disableOnboarding({ store, repository, nameOrSource, configPath }) {
  const user = await store.find(nameOrSource);
  if (!user) throw new Error('Onboarding user/source not found');
  await repository.ensureSource({ scopeKey: 'default', sourceKey: user.sourceKey, displayName: user.displayName, sessionRef: `filesystem:${user.sessionDir}/session.json`, deviceRef: `filesystem:${user.sessionDir}/device.json`, personKey: user.personKey, personDisplayName: user.displayName, enabled: false });
  if (configPath) await updateSourceConfigAtomic({ configPath, source: { sourceKey: user.sourceKey, displayName: user.displayName, scopeKey: 'default', personKey: user.personKey, personDisplayName: user.displayName, sessionDir: user.sessionDir, sessionRef: `filesystem:${user.sessionDir}/session.json`, deviceRef: `filesystem:${user.sessionDir}/device.json` }, enabled: false });
  return updateOnboardingState(store, user.sourceKey, ONBOARDING_STATES.DISABLED, { disabled: true });
}

export { FAILURE_STATES };

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const DEFAULT_URL = 'https://lkdr.nalog.ru/login';

function executableCandidates() {
  return process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
}

export async function findChromium({ access = async (file) => fs.access(file) } = {}) {
  for (const candidate of executableCandidates()) {
    if (!candidate.includes(path.sep)) return candidate;
    try { await access(candidate); return candidate; } catch {}
  }
  throw Object.assign(new Error('Chromium executable was not found'), { code: 'CHROMIUM_NOT_FOUND' });
}

export function onboardingCdpPort(sourceId) {
  const id = Number(sourceId);
  if (!Number.isInteger(id) || id < 1 || id > 1000) throw new Error('Invalid onboarding source id');
  return 19200 + id;
}

function assertProfilePathShape({ sessionDir, profileDir, profileRoot }) {
  if (typeof sessionDir !== 'string' || typeof profileDir !== 'string' || !sessionDir || !profileDir) {
    throw new Error('Onboarding profile paths are required');
  }
  const session = path.resolve(sessionDir);
  const profile = path.resolve(profileDir);
  const root = path.resolve(profileRoot || path.dirname(session));
  const expected = path.join(session, 'chromium-profile');
  const relativeSession = path.relative(root, session);
  if (profile !== expected || path.basename(profile) !== 'chromium-profile') throw new Error('Onboarding profile path mismatch');
  if (!relativeSession || relativeSession.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSession)) throw new Error('Onboarding session is outside profile root');
  if (root === path.parse(root).root || root === session || session === path.parse(session).root) throw new Error('Unsafe onboarding profile root');
  if (!path.basename(session).startsWith('fns-onboarding-')) throw new Error('Onboarding session path is not source-specific');
  return { root, session, profile };
}

export function onboardingProfilePath({ user, profileRoot }) {
  return assertProfilePathShape({ sessionDir: user.sessionDir, profileDir: user.chromiumProfileDir, profileRoot }).profile;
}

export async function requireOnboardingProfile({ user, fsImpl = fs }) {
  const profile = onboardingProfilePath({ user, profileRoot: path.dirname(user.sessionDir) });
  try {
    const details = await fsImpl.stat(profile);
    if (!details.isDirectory()) throw new Error('Onboarding profile path is not a directory');
  } catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error('ONBOARDING_PROFILE_NOT_FOUND'), { code: 'PROFILE_NOT_FOUND' });
    throw error;
  }
  return profile;
}

export async function removeOnboardingProfile({ user, profileRoot, fsImpl = fs }) {
  const paths = assertProfilePathShape({ sessionDir: user.sessionDir, profileDir: user.chromiumProfileDir, profileRoot });
  let canonicalRoot;
  let canonicalSession;
  try {
    canonicalRoot = path.resolve(await fsImpl.realpath(paths.root));
    canonicalSession = path.resolve(await fsImpl.realpath(paths.session));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Onboarding profile root or session is missing');
    throw error;
  }
  const canonicalRelative = path.relative(canonicalRoot, canonicalSession);
  if (!canonicalRelative || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error('Canonical onboarding session is outside profile root');
  }
  if (!path.basename(canonicalSession).startsWith('fns-onboarding-')) throw new Error('Canonical onboarding session is not source-specific');
  const canonicalProfile = path.join(canonicalSession, 'chromium-profile');
  let existing;
  try {
    existing = await fsImpl.realpath(canonicalProfile);
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: true, absent: true, path: canonicalProfile };
    throw error;
  }
  if (path.resolve(existing) !== canonicalProfile) throw new Error('Onboarding profile resolves outside expected path');
  await fsImpl.rm(canonicalProfile, { recursive: true, force: true });
  try {
    await fsImpl.access(canonicalProfile);
    throw new Error('Onboarding profile was not removed');
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: true, absent: true, path: canonicalProfile };
    throw error;
  }
}

export async function startOnboardingBrowser({ user, executable, spawnImpl = spawn, url = DEFAULT_URL, display = process.env.DISPLAY || ':10', phase = 'login', preserveProfile = false }) {
  if (!['login', 'import'].includes(phase)) throw new Error('Invalid onboarding browser phase');
  const chromium = executable || await findChromium();
  const port = onboardingCdpPort(user.sourceId);
  await fs.mkdir(user.sessionDir, { recursive: true, mode: 0o700 });
  await fs.chmod(user.sessionDir, 0o700);
  if (!preserveProfile) await removeOnboardingProfile({ user, profileRoot: path.dirname(user.sessionDir) });
  onboardingProfilePath({ user, profileRoot: path.dirname(user.sessionDir) });
  await fs.mkdir(user.chromiumProfileDir, { recursive: true, mode: 0o700 });
  await fs.chmod(user.chromiumProfileDir, 0o700);
  const args = [
    `--user-data-dir=${user.chromiumProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    url,
  ];
  if (phase === 'import') args.splice(1, 0, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`);
  const child = spawnImpl(chromium, args, { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
  if (!child?.pid) throw new Error('Chromium did not start');
  await fs.writeFile(path.join(user.sessionDir, 'chromium.pid'), `${child.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  return { started: true, phase, pid: child.pid, cdpUrl: phase === 'import' ? `http://127.0.0.1:${port}` : null };
}

export async function waitForOnboardingBrowserExit({ user, fsImpl = fs, isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === 'ESRCH') return false; throw error; } }, timeoutMs = 2 * 60 * 60 * 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const pidPath = path.join(user.sessionDir, 'chromium.pid');
  let pidText;
  try { pidText = await fsImpl.readFile(pidPath, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { exited: true, absent: true };
    throw error;
  }
  const pid = Number(pidText.trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid onboarding Chromium pid');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { exited: true, pid };
    await sleep(250);
  }
  throw Object.assign(new Error('FNS browser login timed out'), { code: 'AUTH_TIMEOUT' });
}

export async function stopOnboardingBrowser({ user, kill = (pid) => process.kill(pid), fsImpl = fs, isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === 'ESRCH') return false; throw error; } }, waitMs = 5000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const pidPath = path.join(user.sessionDir, 'chromium.pid');
  try {
    let pidText;
    try {
      pidText = await fsImpl.readFile(pidPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { stopped: true, absent: true };
      throw error;
    }
    const pid = Number(pidText.trim());
    if (Number.isInteger(pid) && pid > 1) {
      try { kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && isAlive(pid)) await sleep(50);
      if (isAlive(pid)) throw new Error('Onboarding Chromium did not stop');
    }
  } finally {
    await fsImpl.rm(pidPath, { force: true });
  }
  return { stopped: true };
}

import path from 'node:path';
import { chromium as defaultChromium } from 'playwright';
import { SessionStore } from './session-store.js';

function parseExpiry(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function findDeviceInfo(value) {
  if (!value || typeof value !== 'object') return null;
  const deviceId = value.sourceDeviceId ?? value.deviceId ?? value.device_id;
  if (deviceId || value.sourceType || value.metaDetails) {
    return {
      ...value,
      sourceDeviceId: deviceId,
      sourceType: value.sourceType ?? value.deviceType ?? 'WEB',
      metaDetails: {
        ...(value.metaDetails ?? {}),
        ...(value.userAgent && !value.metaDetails?.userAgent ? { userAgent: value.userAgent } : {}),
      },
    };
  }
  for (const child of Object.values(value)) {
    const found = findDeviceInfo(child);
    if (found) return found;
  }
  return null;
}

export async function importBrowserSession({ stateDir, cdpUrl = 'http://127.0.0.1:9222', chromium = defaultChromium }) {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().includes('lkdr.nalog.ru'));
    if (!page) throw new Error('FNS browser page was not found');
    const browserState = await page.evaluate(() => {
      const storage = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && /auth|token|device|session|store/i.test(key)) storage[key] = localStorage.getItem(key);
      }
      return ({
      accessToken: localStorage.getItem('auth.token'),
      refreshToken: localStorage.getItem('refresh.token'),
      accessTokenExpiresAt: localStorage.getItem('auth.token.expires'),
      refreshTokenExpiresAt: localStorage.getItem('refresh.token.expires'),
      sourceDeviceId: localStorage.getItem('sourceDeviceId'),
      userAgent: navigator.userAgent,
      tokenStore: localStorage.getItem('auth.token.store'),
      storage,
      });
    });
    if (!browserState.accessToken || !browserState.refreshToken) throw Object.assign(new Error('FNS browser login is incomplete'), { code: 'AUTH_RELOGIN_REQUIRED' });
    let deviceInfo = null;
    for (const value of [browserState.tokenStore, ...Object.values(browserState.storage ?? {})]) {
      try {
        deviceInfo = findDeviceInfo(JSON.parse(value));
        if (deviceInfo) break;
      } catch {}
    }
    if (!deviceInfo && browserState.sourceDeviceId) {
      deviceInfo = {
        sourceDeviceId: browserState.sourceDeviceId,
        sourceType: 'WEB',
        metaDetails: { userAgent: browserState.userAgent },
      };
    }
    if (!deviceInfo) throw Object.assign(new Error('FNS browser session has no device metadata'), { code: 'AUTH_RELOGIN_REQUIRED' });
    const store = new SessionStore({ stateDir });
    const current = await store.load();
    await store.save({
      ...current,
      accessToken: browserState.accessToken,
      refreshToken: browserState.refreshToken,
      accessTokenExpiresAt: parseExpiry(browserState.accessTokenExpiresAt),
      refreshTokenExpiresAt: parseExpiry(browserState.refreshTokenExpiresAt),
      userAgent: browserState.userAgent,
      deviceInfo,
    });
    return { imported: true };
  } finally {
    if (typeof browser.disconnect === 'function') browser.disconnect();
  }
}

export function onboardingChromiumProfile(sessionDir) {
  return path.join(sessionDir, 'chromium-profile');
}

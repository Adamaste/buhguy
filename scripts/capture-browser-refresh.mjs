import { chromium } from 'playwright';
import { SessionStore } from './src/session-store.js';

function parseExpiry(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return new Date(Date.now() + numeric * 1000).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes('lkdr.nalog.ru'));
if (!page) throw new Error('FNS page not found');

const result = await new Promise(async (resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Browser refresh request was not observed')), 30000);
  let requestBody;
  const onRequest = (request) => {
    if (request.url().endsWith('/api/v1/auth/token') && request.method() === 'POST') {
      try { requestBody = request.postDataJSON(); } catch { requestBody = null; }
    }
  };
  const onResponse = async (response) => {
    if (!response.url().endsWith('/api/v1/auth/token') || response.request().method() !== 'POST') return;
    clearTimeout(timeout);
    try {
      const data = await response.json();
      if (!response.ok() || !requestBody?.deviceInfo || !data?.token) {
        reject(new Error(`Browser refresh failed with status ${response.status()}`));
        return;
      }
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const store = new SessionStore();
      const state = await store.load();
      await store.save({
        ...state,
        accessToken: data.token,
        refreshToken: data.refreshToken ?? state.refreshToken,
        accessTokenExpiresAt: parseExpiry(data.tokenExpireIn) ?? state.accessTokenExpiresAt,
        refreshTokenExpiresAt: parseExpiry(data.refreshTokenExpiresIn) ?? state.refreshTokenExpiresAt,
        userAgent,
        deviceInfo: requestBody.deviceInfo,
      });
      resolve({ ok: true, deviceInfoKeys: Object.keys(requestBody.deviceInfo), metaDetailsKeys: Object.keys(requestBody.deviceInfo.metaDetails ?? {}) });
    } catch (error) { reject(error); }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    await page.evaluate(() => localStorage.setItem('auth.token.expires', '2000-01-01T00:00:00.000Z'));
    await page.reload({ waitUntil: 'domcontentloaded' });
  } catch (error) { clearTimeout(timeout); reject(error); }
});

console.log(JSON.stringify(result));

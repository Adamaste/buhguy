import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes('lkdr.nalog.ru'));
  if (!page) throw new Error('FNS page not found');
  const result = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const raw = localStorage.getItem('auth.token.store');
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    const paths = [];
    const walk = (value, prefix = '') => {
      if (!value || typeof value !== 'object' || paths.length > 200) return;
      for (const [key, child] of Object.entries(value)) {
        const next = prefix ? `${prefix}.${key}` : key;
        paths.push(`${next}:${Array.isArray(child) ? 'array' : typeof child}`);
        walk(child, next);
      }
    };
    walk(parsed);
    return { url: location.href, title: document.title, localStorageKeys: keys, tokenStorePresent: Boolean(raw), tokenStoreShape: paths };
  });
  console.log(JSON.stringify(result));
} finally { browser.disconnect(); }

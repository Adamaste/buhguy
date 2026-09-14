#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { SessionStore } from '../src/session-store.js';

const stateDir = process.env.RECEIPT_COLLECTOR_STATE_DIR || path.join(process.cwd(), '.receipt-collector');
const profileDir = path.join(stateDir, 'browser-profile');

function parseExpiry(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const browser = await chromium.launchPersistentContext(profileDir, {
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: false,
});

try {
  const page = await browser.newPage();
  await page.goto('https://lkdr.nalog.ru/login', { waitUntil: 'domcontentloaded' });
  const rl = readline.createInterface({ input, output });
  await rl.question('Выполните вход в открытом Chrome, затем нажмите Enter здесь: ');
  rl.close();

  const tokens = await page.evaluate(() => ({
    accessToken: localStorage.getItem('auth.token'),
    refreshToken: localStorage.getItem('refresh.token'),
    accessTokenExpiresAt: localStorage.getItem('auth.token.expires'),
    refreshTokenExpiresAt: localStorage.getItem('refresh.token.expires'),
  }));

  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new Error('Токены не найдены. Убедитесь, что вход завершён именно в открытом окне Chrome.');
  }

  const store = new SessionStore({ stateDir });
  const state = await store.load();
  await store.save({
    ...state,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: parseExpiry(tokens.accessTokenExpiresAt),
    refreshTokenExpiresAt: parseExpiry(tokens.refreshTokenExpiresAt),
  });
  console.log(`Сессия сохранена локально: ${path.join(stateDir, 'session.json')}`);
} finally {
  await browser.close();
}

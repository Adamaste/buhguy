import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redactDeep } from '../src/logger.js';

function captureStderr(callback) {
  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };

  try {
    callback();
  } finally {
    process.stderr.write = originalWrite;
  }

  return lines;
}

function captureLog(method, ...args) {
  const lines = captureStderr(() => createLogger()[method](...args));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].endsWith('\n'), true);
  assert.equal(lines[0].split('\n').length, 2);
  return JSON.parse(lines[0]);
}

test('redacts secrets in nested structures', () => {
  const data = redactDeep({
    accessToken: 'super-secret-token',
    nested: {
      refreshToken: 'another-secret-token',
      ok: 'value',
    },
    list: [{ code: '123456' }],
  });

  const json = JSON.stringify(data);
  assert.ok(!json.includes('super-secret-token'));
  assert.ok(!json.includes('another-secret-token'));
  assert.ok(!json.includes('123456'));
  assert.ok(json.includes('[REDACTED]'));
});

test('info logs one JSON line with event and structured fields', () => {
  assert.deepEqual(captureLog('info', 'source_sync_started', {
    sourceId: 457,
    sourceKey: 'constantine',
  }), {
    level: 'info',
    event: 'source_sync_started',
    sourceId: 457,
    sourceKey: 'constantine',
  });
});

test('warn and error preserve their severity and event', () => {
  assert.equal(captureLog('warn', 'fns_detail_unavailable', { status: 422 }).level, 'warn');
  assert.equal(captureLog('warn', 'fns_detail_unavailable', { status: 422 }).event, 'fns_detail_unavailable');
  assert.equal(captureLog('error', 'source_sync_failed', { code: 'EACCES' }).level, 'error');
  assert.equal(captureLog('error', 'source_sync_failed', { code: 'EACCES' }).event, 'source_sync_failed');
});

test('plain strings and Error values use a safe fallback contract', () => {
  assert.deepEqual(captureLog('info', 'plain text'), {
    level: 'info',
    event: 'plain text',
  });
  assert.deepEqual(captureLog('error', new Error('database unavailable')), {
    level: 'error',
    event: 'error',
    message: 'database unavailable',
  });
});

test('secret fields stay redacted in emitted JSON', () => {
  const record = captureLog('info', 'session_loaded', {
    accessToken: 'super-secret-token',
    nested: { password: 'do-not-log' },
  });

  assert.notEqual(record.accessToken, 'super-secret-token');
  assert.match(record.accessToken, /\[REDACTED\]/);
  assert.notEqual(record.nested.password, 'do-not-log');
  assert.match(record.nested.password, /\[REDACTED\]/);
});

test('silent logger emits nothing', () => {
  const lines = captureStderr(() => createLogger({ silent: true }).info('silent_event', { ok: true }));
  assert.deepEqual(lines, []);
});

test('unicode and malformed arguments do not break logging', () => {
  assert.equal(captureLog('info', 'проверка_чека', { продавец: 'Магазин' }).event, 'проверка_чека');
  assert.equal(captureLog('warn', null, 42, false).level, 'warn');
  assert.equal(captureLog('error', { reason: 'invalid input' }).event, 'log');
});

const SECRET_KEYS = new Set([
  'accessToken',
  'refreshToken',
  'token',
  'captchaToken',
  'challengeToken',
  'code',
  'phone',
  'password',
  'clientSecret',
  'client_secret',
  'secret',
  'secretHash',
  'secret_hash',
  'sessionId',
  'session_id',
]);

function redactValue(value) {
  if (typeof value !== 'string') {
    return '[REDACTED]';
  }

  if (value.length <= 8) {
    return '[REDACTED]';
  }

  return `${value.slice(0, 2)}…[REDACTED]…${value.slice(-2)}`;
}

export function redactDeep(input, seen = new WeakSet()) {
  if (Array.isArray(input)) {
    if (seen.has(input)) {
      return '[CIRCULAR]';
    }
    seen.add(input);
    const output = input.map((value) => redactDeep(value, seen));
    seen.delete(input);
    return output;
  }

  if (!input || typeof input !== 'object') {
    return input;
  }

  if (seen.has(input)) {
    return '[CIRCULAR]';
  }
  seen.add(input);

  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEYS.has(key)) {
      output[key] = redactValue(value);
      continue;
    }
    output[key] = redactDeep(value, seen);
  }
  seen.delete(input);
  return output;
}

export function createLogger({ silent = false } = {}) {
  const write = (level, ...args) => {
    if (silent) {
      return;
    }

    const [first, ...rest] = args;
    const fields = {};
    let event = 'log';

    if (typeof first === 'string') {
      event = first;
    } else if (first instanceof Error) {
      fields.message = first.message;
      event = 'error';
    } else if (first && typeof first === 'object' && !Array.isArray(first)) {
      Object.assign(fields, first);
    }

    for (const part of rest) {
      if (part instanceof Error) {
        fields.message ??= part.message;
      } else if (part && typeof part === 'object' && !Array.isArray(part)) {
        Object.assign(fields, part);
      } else if (part !== undefined) {
        fields.message ??= String(part);
      }
    }

    const record = { ...redactDeep(fields), level, event };
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level, event: 'logger_serialization_failed' });
    }
    process.stderr.write(`${line}\n`);
  };

  return {
    info: (...args) => write('info', ...args),
    warn: (...args) => write('warn', ...args),
    error: (...args) => write('error', ...args),
  };
}

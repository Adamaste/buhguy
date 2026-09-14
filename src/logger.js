const SECRET_KEYS = new Set([
  'accessToken',
  'refreshToken',
  'token',
  'captchaToken',
  'challengeToken',
  'code',
  'phone',
]);

function redactValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  if (value.length <= 8) {
    return '[REDACTED]';
  }

  return `${value.slice(0, 2)}…[REDACTED]…${value.slice(-2)}`;
}

export function redactDeep(input) {
  if (Array.isArray(input)) {
    return input.map(redactDeep);
  }

  if (!input || typeof input !== 'object') {
    return input;
  }

  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEYS.has(key)) {
      output[key] = redactValue(value);
      continue;
    }
    output[key] = redactDeep(value);
  }
  return output;
}

export function createLogger({ silent = false } = {}) {
  const write = (...args) => {
    if (silent) {
      return;
    }
    process.stderr.write(`${args.map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      return JSON.stringify(redactDeep(part));
    }).join(' ')}\n`);
  };

  return {
    info: (...args) => write(...args),
    warn: (...args) => write(...args),
    error: (...args) => write(...args),
  };
}

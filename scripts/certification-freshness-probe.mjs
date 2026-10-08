import { createPool } from '../src/database.js';
import { inspectCertificationFreshness } from '../src/certification-freshness.js';

const args = process.argv.slice(2);
const valueAfter = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const scopeKey = valueAfter('--scope', 'default');
const statementTimeoutMs = Number(valueAfter('--statement-timeout-ms', '120000'));
const lockTimeoutMs = Number(valueAfter('--lock-timeout-ms', '5000'));
const pool = createPool({ max: 1, connectionTimeoutMillis: 10000 });
try {
  process.stdout.write(`${JSON.stringify(await inspectCertificationFreshness(pool, { scopeKey, statementTimeoutMs, lockTimeoutMs }))}\n`);
} finally {
  await pool.end();
}


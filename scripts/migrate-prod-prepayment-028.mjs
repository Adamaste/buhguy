import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '../src/database.js';

export const PREPAYMENT_MIGRATION_028 = '028_prepayment_bank_funding.sql';
export const PREPAYMENT_MIGRATION_028_SHA256 = '15354b28933f1255d15162c975ffaebdc3be849e067630a0250b24f8b157e977';

export async function migratePrepayment028(pool, migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')) {
  let bytes;
  try {
    bytes = await readFile(path.join(migrationsDir, PREPAYMENT_MIGRATION_028));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
    const error = new Error(`Approved migration ${PREPAYMENT_MIGRATION_028} is unavailable`);
    error.code = 'MIGRATION_FILE_MISSING';
    throw error;
  }
  // Git may check out SQL with CRLF on Windows. Hash the canonical LF form so
  // the same approved migration has one checksum in Windows tests and Linux releases.
  const canonicalBytes = Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  const actual = createHash('sha256').update(canonicalBytes).digest('hex');
  if (actual !== PREPAYMENT_MIGRATION_028_SHA256) {
    const error = new Error(`Checksum mismatch for approved migration ${PREPAYMENT_MIGRATION_028}`);
    error.code = 'MIGRATION_CHECKSUM_MISMATCH';
    throw error;
  }
  const stagedMigrations = await mkdtemp(path.join(os.tmpdir(), 'buhguy-migrate-028-'));
  try {
    const files = (await readdir(migrationsDir))
      .filter((filename) => filename.endsWith('.sql') && filename <= PREPAYMENT_MIGRATION_028)
      .sort();
    for (const filename of files) await copyFile(path.join(migrationsDir, filename), path.join(stagedMigrations, filename));
    return await migrate(pool, stagedMigrations, {
      requireSinglePendingMigration: PREPAYMENT_MIGRATION_028,
      lockTimeoutMs: Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 5000),
      statementTimeoutMs: Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS ?? 120000),
    });
  } finally {
    await rm(stagedMigrations, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool({ connectionTimeoutMillis: Number(process.env.MIGRATION_CONNECTION_TIMEOUT_MS ?? 10000) });
  try {
    const result = await migratePrepayment028(pool);
    process.stdout.write(result.applied.length ? `Applied ${PREPAYMENT_MIGRATION_028}\n` : `${PREPAYMENT_MIGRATION_028} is already applied\n`);
  } finally {
    await pool.end();
  }
}

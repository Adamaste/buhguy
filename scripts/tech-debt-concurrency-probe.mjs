const appRoot = process.env.APP_ROOT ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { createPool } = await import(`${appRoot}/src/database.js`);
const { rebuildLedger } = await import(`${appRoot}/src/ledger.js`);

const pool = process.env.DB_NAME
  ? createPool({ host: process.env.PGHOST ?? '/var/run/postgresql', port: process.env.PGPORT ?? 5432, user: process.env.PGUSER ?? 'postgres', database: process.env.DB_NAME })
  : createPool();

const countRows = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM ledger_entries) AS entries,
  (SELECT count(*)::int FROM ledger_postings) AS postings,
  (SELECT count(*)::int FROM ledger_source_links) AS links,
  (SELECT count(*)::int FROM ledger_entries GROUP BY semantic_key HAVING count(*) > 1) AS duplicate_entries`)).rows[0];

const rounds = Number(process.env.ROUNDS ?? 20);
const width = Number(process.env.WIDTH ?? 25);
const errors = [];
const started = await countRows();
for (let round = 0; round < rounds; round += 1) {
  const results = await Promise.all(Array.from({ length: width }, async () => {
    try { return await rebuildLedger(pool); }
    catch (error) { return { error: { code: error.code ?? null, message: error.message } }; }
  }));
  for (const result of results) if (result.error) errors.push({ round, ...result.error });
}
const finished = await countRows();
process.stdout.write(`${JSON.stringify({ rounds, width, attempts: rounds * width, errors, started, finished, stableCounts: JSON.stringify(started) === JSON.stringify(finished) }, null, 2)}\n`);
await pool.end();

const appRoot = process.env.APP_ROOT ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { createPool } = await import(`${appRoot}/src/database.js`);
const { rebuildLedger } = await import(`${appRoot}/src/ledger.js`);
const { rebuildCertification, certificationReport } = await import(`${appRoot}/src/certification.js`);
const pool = process.env.DB_NAME
  ? createPool({ host: process.env.PGHOST ?? '/var/run/postgresql', port: process.env.PGPORT ?? 5432, user: process.env.PGUSER ?? 'postgres', database: process.env.DB_NAME })
  : createPool();

const counts = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM ledger_entries) AS ledger_entries,
  (SELECT count(*)::int FROM ledger_postings) AS postings,
  (SELECT count(*)::int FROM ledger_source_links) AS links,
  (SELECT count(*)::int FROM reconciliation_runs WHERE model_version='reconciliation-certification-v1') AS runs,
  (SELECT count(*)::int FROM reconciliation_results rr JOIN reconciliation_runs r ON r.id=rr.run_id WHERE r.model_version='reconciliation-certification-v1') AS results,
  (SELECT count(*)::int FROM certification_facts f JOIN reconciliation_runs r ON r.id=f.run_id WHERE r.model_version='reconciliation-certification-v1') AS facts`)).rows[0];

try {
  const before = await counts();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM reconciliation_runs WHERE model_version='reconciliation-certification-v1'");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  const ledger = await rebuildLedger(pool, { replace: true });
  const certification = await rebuildCertification(pool, { persist: true, replace: true });
  const after = await counts();
  const report = await certificationReport(pool);
  process.stdout.write(`${JSON.stringify({ before, ledger: { created: ledger.created, balancedViolations: ledger.balancedViolations }, certification: { facts: certification.facts.length, results: certification.results.length }, after, report: { results: report.results.length, metrics: report.metrics } }, null, 2)}\n`);
} finally { await pool.end(); }

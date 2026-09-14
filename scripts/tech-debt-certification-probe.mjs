const appRoot = process.env.APP_ROOT ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { createPool } = await import(`${appRoot}/src/database.js`);
const { certificationReport } = await import(`${appRoot}/src/certification.js`);
const pool = process.env.DB_NAME
  ? createPool({ host: process.env.PGHOST ?? '/var/run/postgresql', port: process.env.PGPORT ?? 5432, user: process.env.PGUSER ?? 'postgres', database: process.env.DB_NAME })
  : createPool();
const report = await certificationReport(pool);
const persisted = (await pool.query(`SELECT
  (SELECT count(*)::int FROM reconciliation_runs WHERE model_version='reconciliation-certification-v1') AS runs,
  (SELECT count(*)::int FROM reconciliation_results rr JOIN reconciliation_runs r ON r.id=rr.run_id WHERE r.model_version='reconciliation-certification-v1') AS persisted_results,
  (SELECT count(*)::int FROM certification_facts f JOIN reconciliation_runs r ON r.id=f.run_id WHERE r.model_version='reconciliation-certification-v1') AS persisted_facts,
  (SELECT count(*)::int FROM reconciliation_results rr JOIN reconciliation_runs r ON r.id=rr.run_id WHERE r.model_version='reconciliation-certification-v1' AND r.id=(SELECT max(id) FROM reconciliation_runs WHERE model_version='reconciliation-certification-v1')) AS latest_results`)).rows[0];
process.stdout.write(`${JSON.stringify({ projectionResults: report.results.length, projectionFacts: report.proofFacts.length, metrics: report.metrics, persisted }, null, 2)}\n`);
await pool.end();

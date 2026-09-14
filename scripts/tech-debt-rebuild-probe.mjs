const appRoot = process.env.APP_ROOT ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { createPool } = await import(`${appRoot}/src/database.js`);
const { rebuildLedger } = await import(`${appRoot}/src/ledger.js`);
const { rebuildCertification, certificationReport } = await import(`${appRoot}/src/certification.js`);

const pool = process.env.DB_NAME
  ? createPool({
      host: process.env.PGHOST ?? '/var/run/postgresql',
      port: process.env.PGPORT ?? 5432,
      user: process.env.PGUSER ?? 'postgres',
      database: process.env.DB_NAME,
    })
  : createPool();
const counts = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM receipts) receipts,
  (SELECT count(*)::int FROM receipt_items) items,
  (SELECT count(*)::int FROM receipt_raw) raw,
  (SELECT count(*)::int FROM receipt_fiscal_facts) fiscal_facts,
  (SELECT count(*)::int FROM business_events) events,
  (SELECT count(*)::int FROM business_event_evidence) evidence,
  (SELECT count(*)::int FROM business_event_edges) edges,
  (SELECT count(*)::int FROM business_event_allocations) allocations,
  (SELECT count(*)::int FROM ledger_entries) ledger_entries,
  (SELECT count(*)::int FROM ledger_postings) postings,
  (SELECT count(*)::int FROM ledger_source_links) links,
  (SELECT count(*)::int FROM reconciliation_runs) runs,
  (SELECT count(*)::int FROM reconciliation_results) results,
  (SELECT count(*)::int FROM certification_facts) certification_facts`)).rows[0];

try {
  const before = await counts();
  let directReplace;
  try { directReplace = { ok: true, result: await rebuildLedger(pool, { replace: true }) }; }
  catch (error) { directReplace = { ok: false, code: error.code ?? null, message: error.message }; }
  const afterDirectReplace = await counts();
  let downstreamFirst;
  try {
    const certificationBefore = await rebuildCertification(pool, { persist: true, replace: true });
    const ledger = await rebuildLedger(pool, { replace: true });
    const certificationAfter = await rebuildCertification(pool, { persist: true, replace: true });
    downstreamFirst = { ok: true, certificationBefore: { facts: certificationBefore.facts.length, results: certificationBefore.results.length }, ledger: { created: ledger.created, balancedViolations: ledger.balancedViolations }, certificationAfter: { facts: certificationAfter.facts.length, results: certificationAfter.results.length }, report: (await certificationReport(pool)).metrics };
  } catch (error) { downstreamFirst = { ok: false, code: error.code ?? null, message: error.message }; }
  const afterDownstreamFirst = await counts();
  process.stdout.write(`${JSON.stringify({ before, directReplace, afterDirectReplace, downstreamFirst, afterDownstreamFirst }, null, 2)}\n`);
} finally { await pool.end(); }

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertSchemaCurrent, migrate } from '../src/database.js';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

integration('runtime schema gate works with a role that has no public CREATE privilege', async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const role = `runtime_schema_${process.pid}_${Date.now()}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const quotedRole = quoteIdentifier(role);
  let runtime;
  try {
    await migrate(admin);
    await admin.query(`CREATE ROLE ${quotedRole} LOGIN PASSWORD $1`, [password]);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`);
    await admin.query(`GRANT SELECT ON TABLE schema_migrations TO ${quotedRole}`);
    await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${quotedRole}`);
    const privilege = await admin.query('SELECT has_schema_privilege($1, \'public\', \'CREATE\') AS can_create', [role]);
    assert.equal(privilege.rows[0].can_create, false);
    runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, user: role, password });
    assert.deepEqual(await assertSchemaCurrent(runtime), { ok: true, migrations: (await admin.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count });
  } finally {
    await runtime?.end();
    await admin.query(`DROP ROLE IF EXISTS ${quotedRole}`);
    await admin.end();
  }
});

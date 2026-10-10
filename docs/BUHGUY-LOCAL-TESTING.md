# Temporary local testing while GitHub Actions minutes are exhausted

**Effective:** 2026-10-10 until the account's GitHub Actions allotment resets on
2026-11-01 **and** automated CI is deliberately restored. This is a temporary
operational substitution, not permanent removal of acceptance tests.

GitHub Actions automatic `push` and `pull_request` triggers are paused in
`.github/workflows/ci.yml`. The workflow retains manual `workflow_dispatch`
for explicitly authorized exceptional use, but avoid dispatches during this
period. Pushing or merging a PR should not start GitHub-hosted tests.

## Where to test

Prefer a local developer workstation or isolated test VM/server with Node.js
22+, npm, Docker, and sufficient disk/CPU. **Do not use the production
PostgreSQL instance or an unisolated production server** as an integration
test runner. Do not install Docker, create privileged databases, restart
services, modify firewall rules, or alter runtime/deployment configuration
on production under this policy.

Run against the **exact candidate commit SHA** in a disposable, clean Git
worktree. Preserve dirty worktrees and local secrets. Verify `git rev-parse
HEAD` immediately before testing.

## Backend checks (Linux / test VM)

From a clean, isolated checkout **without production credentials or .env**:

```sh
node --version                # Node 22+
npm ci
npm run check
npm run test:unit
# Ensure no inherited production DB connection or TEST_DATABASE_URL:
unset DATABASE_URL TEST_DATABASE_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
npm run test:integration
```

`scripts/test-postgres-integration.js` automatically starts a new
**loopback-bound disposable PostgreSQL 16 Docker container**, runs the
integration suite and removes the container. It returns an error if Docker
is unavailable and no `TEST_DATABASE_URL` was supplied. Do not interpret
a Docker-unavailable/skipped test as PASS.

On Windows, use the equivalent PowerShell environment cleanup and Docker
Desktop, or run in an isolated Linux development VM. Never pass production
credentials into these commands. If an existing `TEST_DATABASE_URL` must
be used, verify separately that it points exclusively to an isolated,
throwaway test database, never to production.

Do **not** substitute bare `npm test` with no `TEST_DATABASE_URL` for
the integration command: tests may be skipped without a database fixture.

## Android checks (only when Android files change)

On a workstation or isolated build host with Android SDK API 35, Build Tools
35.0.0, Java 17 and Gradle 8.9:

```sh
cd android/buhguy-bank-collector
gradle --no-daemon testDebugUnitTest assembleDebug
```

Check the produced debug APK locally. Do not create a signed release or
upload keystore material unless separately approved.

## PR review and merge gate during the pause

Before merging code, review the actual GitHub PR diff, threads, reviews,
mergeability and current master. In lieu of GitHub CI, require a local test
report tied to the **exact PR HEAD SHA**:

- node version and test host type; no secrets, machine identifiers or private paths;
- `npm run check`, `npm run test:unit`, `npm run test:integration`
  explicitly PASS, with real disposable PostgreSQL tests executed;
- Android test/build PASS if Android code changed;
- `git diff --check`, clean/reconciled worktree, and exact tested SHA.

A documentation-only PR can use a read-only diff/format review without the
full test suite; do not claim GitHub CI PASS during the pause. If exact-head
tests have not passed locally, do not merge functional or financial changes.

All production writes/deployments/grants/materialization remain separately
approved. Temporary CI changes do not authorize new production operations.

## Restore the CI

On or after **2026-11-01**, confirm in GitHub Billing that included Actions
minutes actually reset. Restore these automatic triggers via a reviewed PR:

```yaml
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
  workflow_dispatch:
```

Keep the existing workflow jobs and signed-build dispatch configuration.
Verify the restored CI on a real code change with expected test/Android
selection and make GitHub CI mandatory again for subsequent code PRs.
Until verified, the local exact-head test policy remains in force.

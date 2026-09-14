# Finance Receipt Collector

Receipt ingestion and accounting-proof pipeline for the FNS "Moyi cheki onlayn" service.

## Architecture

The application stores canonical receipts once, keeps source-specific provenance separately, and processes data through these layers:

1. FNS source references and receipt observations
2. Fiscal identity and normalization
3. Business-event graph
4. Double-entry ledger
5. Certification and reconciliation
6. Purchase and item analytics

The data model supports multiple FNS sources and persons. A disabled source remains available for historical provenance but is not selected by scheduled synchronization.

The production installation is systemd-based. The Docker files are retained for disposable local PostgreSQL/integration environments and are not the production deployment contract.

Production systemd units read secrets from `/etc/finance-receipt-collector/receipt-collector.env`, owned by root with restrictive permissions. The repository contains only the installation templates; it does not contain that file, FNS sessions, browser state, backups, or database credentials.

## Requirements

- Node.js 22 or newer
- PostgreSQL for runtime or integration tests

Install dependencies with:

```bash
npm ci
```

Copy `.env.example` to a local `.env` and set a disposable `DATABASE_URL` when running the application locally. Never commit `.env`, session stores, browser profiles, raw responses, or database dumps.

## CLI

From the repository root:

```bash
npm start -- help
npm run migrate
npm start -- sync
npm start -- list
npm start -- show <receipt-id>
```

For the production self-service flow, the `fns-user` command is installed in the operator account's `PATH` by the deployment. It opens a clean, source-specific browser profile for the official FNS login flow; CAPTCHA and SMS steps remain manual. Session import, validation, initial synchronization, and source activation are performed by the application only after the saved session passes validation.

```bash
fns-user add "Display name"
fns-user status
```

The application never attempts to bypass CAPTCHA. Browser session data and credentials remain outside the repository and are not printed by the CLI.

## Migrations and semantic views

Runtime migrations are in `db/migrations/` and are applied in filename order. Analytics migrations in `db/analytics/` are deployed separately from the runtime migration loader.

The read-only accounting semantic layer is defined by `db/analytics/010_chatgpt_accounting_semantic_layer.sql`. It exposes documented views in the `chatgpt_accounting` schema without exposing raw receipt payloads or authentication material. See:

- `docs/chatgpt-accounting-data-contract.md`
- `docs/chatgpt-accounting-query-guide.md`
- `docs/blazesql-accounting-selection.md`

## Tests and checks

```bash
npm test
npm run check
```

The PostgreSQL integration tests require `TEST_DATABASE_URL` pointing to a disposable database. They must not be run against production. `npm run test:integration` provisions a disposable PostgreSQL container when Docker is available.

For a manual test container, use `compose.test.yml` with a temporary project name and no persistent volumes. The test database is local-only and uses synthetic credentials. The root `docker-compose.yml` is a legacy deployment path and is not the supported systemd production path.

The accounting invariants are intentionally strict: duplicate canonical receipts, orphaned accounting rows, unbalanced ledger entries, missing certification proof, and unresolved layer gaps fail validation rather than being suppressed.

## Deployment safety

Production deployment is an explicit reviewed operation. The GitHub workflow runs tests and can deploy on pushes to its configured deployment branch; do not push credentials, artifacts, production snapshots, or unreviewed code. Deployment credentials are supplied only through the CI secret store and are never stored in this repository.

The systemd installation convention is `/opt/accountant/receipt-collector`; operators may choose another `RECEIPT_COLLECTOR_HOME` during installation, but the path must be configured consistently in the installed units. Backups are created by the installed backup service outside the repository and must not be copied into Git.

Before publishing, review `git status`, inspect ignored files, and create a sanitized initial commit. Do not publish `.codex-access/`, `artifacts/`, `outputs/`, dumps, raw responses, session files, or private keys.

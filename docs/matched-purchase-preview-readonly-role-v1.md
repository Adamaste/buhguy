# Matched-Purchase Read-Only Preview Role v1

## Status and boundary

This document is an operator runbook for one bounded, aggregate-only
matched-purchase preview. It is not authorization to execute production SQL.
The role creation, grants, preview, and cleanup commands below are review
artifacts only until a separate production approval is recorded.

The approved execution target is the exact GitHub master checkout containing
`scripts/matched-purchase-preview-read-only.mjs`. The target is one
accounting scope, `default`, and one explicitly bounded UTC period. No caller
may choose another scope during this operation.

This procedure does not add a service, protocol, matcher, writer, migration,
RLS policy, publication view, grant to `receipt_collector`, or grant to
`chatgpt_reader`. It does not run a writer, certification materialization,
sync/retry, replay, backfill, deployment, or service restart.

## Current evidence

The exact master used for this preparation is:

`8e2268f47eb80e8b69b5b88e3a1d65517cbe622d`

PR #155 and PR #156 are merged. The current master push CI was
`38048318293` and passed. The explicit-column preview change is therefore
already in master; this document does not replace that implementation.

The previous bounded catalog audit established the following facts without
reading financial payloads:

- PostgreSQL 18.6, database `finance_receipt_collector`, schema `public`.
- There is one current accounting scope, `default`/id `1`.
- The private SSH/admin path can inspect catalog metadata, but it does not
  provide a safe local Node credential for the preview runner.
- `receipt_collector` is not an acceptable preview role: it has DML rights
  and lacks SELECT on seven required tables.
- `chatgpt_reader` has no SELECT on the preview call graph.
- No production preview role has been created.

The one-scope observation is a prerequisite for this one-shot operator run,
not a row-level security guarantee. PostgreSQL table or column grants do not
isolate rows. If a second scope appears, this procedure stops before a role
is created or a preview is run.

## Authoritative call graph

The runner opens one connection, begins `REPEATABLE READ READ ONLY`, applies
transaction-local bounded `statement_timeout=120000ms` and
`lock_timeout=5000ms`, verifies `transaction_read_only`, runs the existing
orchestration preview twice for the approved narrow/wide transfer-window
invariance check, and always rolls back. It does not call the persistence
writer.

The SQL path is:

`matched-purchase-preview-read-only.mjs`
-> `runReadOnlyMatchedPurchasePreview`
-> `previewMatchedPurchaseOrchestration`
-> `loadBankReceiptMatching`
-> `loadBalancedBankJournalProjection`
-> `loadBankCashFlowProjection`
-> `loadBankInternalTransferOwnershipSnapshot`
-> `loadMatchedPurchaseEnrichment`

The projection, matcher, and enrichment code reuses the authoritative
business rules. It performs the remaining joins and semantic checks in
memory. The path does not read `schema_migrations`, certification tables,
analytics views, raw notification payloads, or receipt raw payloads.

## Exact column allowlist

The following is the complete current table/column matrix for the merged
preview SQL path. The names are taken from the actual SELECT, JOIN, WHERE,
GROUP BY, and ORDER BY clauses. A temporary role must receive no other
SELECT column grant.

| Table | Required columns |
| --- | --- |
| `accounting_scopes` | `id`, `scope_key` |
| `bank_sources` | `id` |
| `bank_source_person` | `bank_source_id`, `person_id` |
| `persons` | `id`, `scope_id` |
| `bank_event_observations` | `id`, `bank_source_id` |
| `bank_transactions` | `id`, `observation_id`, `occurred_at`, `amount`, `currency`, `event_type`, `direction`, `normalization_status`, `evidence_quality` |
| `bank_transaction_account_resolution` | `bank_transaction_id`, `financial_account_id`, `resolution_state`, `provenance` |
| `financial_accounts` | `id`, `scope_id` |
| `financial_account_person_relations` | `financial_account_id`, `person_id`, `relation_type`, `provenance` |
| `receipt_source_observations` | `receipt_id`, `fns_source_id` |
| `fns_sources` | `id`, `scope_id` |
| `receipts` | `id`, `date_time`, `currency`, `total_sum` |
| `receipt_fiscal_facts` | `receipt_id`, `normalization_version`, `normalized_content_sha256`, `normalization_status`, `fiscal_operation_type`, `household_cash_direction`, `payment_components_status`, `payment_stage`, `correction_status`, `ecash_total_sum`, `ecash_total_state`, `cash_total_sum`, `cash_total_state`, `prepaid_sum`, `prepaid_state`, `credit_sum`, `credit_state`, `provision_sum`, `provision_state` |
| `receipt_items` | `id`, `receipt_id` |
| `receipt_item_fiscal_facts` | `receipt_item_id`, `normalization_version`, `payment_type_code` |
| `business_events` | `id`, `scope_id`, `event_type`, `resolution_status`, `amount`, `currency` |
| `business_event_evidence` | `id`, `event_id`, `receipt_id`, `normalization_version` |
| `ledger_entries` | `id`, `scope_id`, `source_event_id`, `currency`, `derivation_rule`, `derivation_status` |
| `ledger_entry_supersessions` | `scope_id`, `superseded_ledger_entry_id` |
| `ledger_postings` | `id`, `ledger_entry_id`, `account_id`, `currency`, `debit`, `credit` |
| `ledger_accounts` | `id`, `account_code` |
| `ledger_source_links` | `id`, `ledger_entry_id`, `business_event_id`, `graph_evidence_id`, `graph_allocation_id`, `receipt_id`, `normalization_version`, `link_role`, `bank_receipt_match_id`, `bank_transaction_id` |
| `bank_receipt_matches` | `id`, `match_key` |

The list intentionally excludes tables that are not touched by this runner,
including `receipt_raw`, `business_event_bank_evidence`, certification tables,
analytics views, and unrelated provider tables. The path contains no
`SELECT *`, `e.*`, `le.*`, `lp.*`, or equivalent wildcard projection.

## Review-only role SQL

The following commands are a precise plan, not commands to execute in this
PR. An administrator must replace the role name and password through an
approved secret mechanism. The password must never appear in shell history,
Git, logs, a PR, or the runner output.

```sql
CREATE ROLE buhguy_preview_ro_YYYYMMDD
  LOGIN PASSWORD '<temporary-secret-from-approved-secret-store>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

REVOKE ALL PRIVILEGES ON DATABASE finance_receipt_collector
  FROM buhguy_preview_ro_YYYYMMDD;
GRANT CONNECT ON DATABASE finance_receipt_collector
  TO buhguy_preview_ro_YYYYMMDD;

REVOKE ALL PRIVILEGES ON SCHEMA public
  FROM buhguy_preview_ro_YYYYMMDD;
GRANT USAGE ON SCHEMA public
  TO buhguy_preview_ro_YYYYMMDD;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM buhguy_preview_ro_YYYYMMDD;
```

Grant exactly the columns below, and no table-wide SELECT:

```sql
GRANT SELECT (id, scope_key) ON public.accounting_scopes TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id) ON public.bank_sources TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (bank_source_id, person_id) ON public.bank_source_person TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, scope_id) ON public.persons TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, bank_source_id) ON public.bank_event_observations TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, observation_id, occurred_at, amount, currency, event_type, direction, normalization_status, evidence_quality) ON public.bank_transactions TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (bank_transaction_id, financial_account_id, resolution_state, provenance) ON public.bank_transaction_account_resolution TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, scope_id) ON public.financial_accounts TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (financial_account_id, person_id, relation_type, provenance) ON public.financial_account_person_relations TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (receipt_id, fns_source_id) ON public.receipt_source_observations TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, scope_id) ON public.fns_sources TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, date_time, currency, total_sum) ON public.receipts TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (receipt_id, normalization_version, normalized_content_sha256, normalization_status, fiscal_operation_type, household_cash_direction, payment_components_status, payment_stage, correction_status, ecash_total_sum, ecash_total_state, cash_total_sum, cash_total_state, prepaid_sum, prepaid_state, credit_sum, credit_state, provision_sum, provision_state) ON public.receipt_fiscal_facts TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, receipt_id) ON public.receipt_items TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (receipt_item_id, normalization_version, payment_type_code) ON public.receipt_item_fiscal_facts TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, scope_id, event_type, resolution_status, amount, currency) ON public.business_events TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, event_id, receipt_id, normalization_version) ON public.business_event_evidence TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, scope_id, source_event_id, currency, derivation_rule, derivation_status) ON public.ledger_entries TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (scope_id, superseded_ledger_entry_id) ON public.ledger_entry_supersessions TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, ledger_entry_id, account_id, currency, debit, credit) ON public.ledger_postings TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, account_code) ON public.ledger_accounts TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, ledger_entry_id, business_event_id, graph_evidence_id, graph_allocation_id, receipt_id, normalization_version, link_role, bank_receipt_match_id, bank_transaction_id) ON public.ledger_source_links TO buhguy_preview_ro_YYYYMMDD;
GRANT SELECT (id, match_key) ON public.bank_receipt_matches TO buhguy_preview_ro_YYYYMMDD;
```

The role must not be granted membership in `pg_read_all_data`,
`pg_read_all_settings`, an application role, or any other group. It must not
own an object and must not receive default privileges. A grant on a column is
not a row-security boundary.

## Independent preflight

The administrator must complete all checks before the preview. Use a short
`REPEATABLE READ READ ONLY` transaction with local `lock_timeout=5000ms` and
`statement_timeout=120000ms`; always issue `ROLLBACK`. Do not print row data.

The identity and server checks are:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '120000ms';
SELECT current_database(), current_user, current_schema(),
       current_setting('search_path'), current_setting('server_version'),
       current_setting('transaction_read_only');
SELECT current_setting('transaction_read_only') = 'on' AS read_only;
ROLLBACK;
```

The role-attribute and membership checks must show `false` for superuser,
createdb, createrole, replication, and bypassrls, and no membership rows:

```sql
SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
       rolinherit, rolcanlogin
FROM pg_roles
WHERE rolname = current_user;

SELECT 1
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.member
WHERE r.rolname = current_user;
```

The independent privilege verifier must compare the effective grants against
the exact 23-table matrix above. It must prove:

1. every listed column has SELECT;
2. no unlisted `public` column has SELECT;
3. INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER are false on
   every listed table;
4. the role has no access to another schema or a broad read role;
5. `default` is present exactly once and the aggregate scope count remains
   one; and
6. all seven previously missing table SELECTs are now covered only by the
   temporary role.

Use `has_column_privilege`, `has_table_privilege`,
`information_schema.column_privileges`, `pg_auth_members`, and
`pg_database.datacl`/`pg_namespace` catalog checks. Compare names to the
allowlist, not to a hard-coded assumption about current role names. Any
unexpected inherited/public privilege is a STOP condition.

The existing `receipt_collector` and `chatgpt_reader` grants must not change.
No production grant is performed as part of this document.

## Private SSH loopback and secret handling

The operator runs the exact-master Node process locally and reaches PostgreSQL
only through the existing private SSH path. No public PostgreSQL listener or
new firewall rule is needed.

1. Verify the existing `finance-vps` SSH alias, host key, and operator
   authorization. Do not print private key material.
2. On the local Windows host, open a tunnel with a one-shot local port:

```powershell
ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 `
  -o ServerAliveCountMax=3 -N `
  -L 127.0.0.1:<local-port>:127.0.0.1:5432 finance-vps
```

3. Connect the local runner to `127.0.0.1:<local-port>` and database
   `finance_receipt_collector`. The temporary role password is supplied only
   by an approved OS secret store or one-shot process environment. Do not put
   it in `.env`, a command line, a shell history, a Git file, or logs.
4. Verify `current_database`, `current_user`, and the private loopback peer
   before running the preview. If the tunnel is not private or the identity
   differs, stop.

The command is operator-controlled and must use the literal approved scope:

```powershell
node scripts/matched-purchase-preview-read-only.mjs `
  --scope-key default `
  --from 2026-09-27T13:48:18Z `
  --to <reviewed-utc-cutoff>
```

`<reviewed-utc-cutoff>` must be a concrete UTC instant selected immediately
before the run and recorded in the safe operator log. An open-ended or
guessed period is not allowed. The CLI is not exposed to an end user; any
scope value other than `default` is a STOP condition. The runner's approved
receipt window is 300000ms and its internal-transfer window is 5000ms, with a
same-snapshot invariance check at 3600000ms.

## One-run procedure

The following sequence is intentionally one-shot and fail-closed:

1. Verify the exact master SHA, clean checkout, package lock, and script hash.
2. Verify the private SSH tunnel and temporary role identity.
3. Run the complete role, schema, column, DML, membership, and one-scope
   preflight. Stop on any unexpected result.
4. Capture aggregate before counts/hashes for the selected matched-purchase,
   ledger, and certification persistence tables. Do not export rows or
   payloads.
5. Start the exact runner once with scope `default`, explicit `from` and
   `to`, and the existing bounded settings. Its transaction must report
   `transaction_read_only=on` and must end with `ROLLBACK`.
6. Accept only the runner's safe aggregate statuses. A `READY`-like result is
   not authorization to write. `STALE`, `MISSING`, `CONFLICT`, `CORRUPT`,
   `AMBIGUOUS`, `UNMATCHED`, `INELIGIBLE`, or a technical error is reported
   as-is; no historical number is substituted.
7. Repeat the aggregate before/after count/hash check. It must be identical.
   If any persistence count/hash changes, stop and treat the operation as a
   safety incident; do not retry or repair in this procedure.
8. Close the tunnel. The administrator then revokes the temporary grants,
   sets `NOLOGIN`, verifies no active session remains, and drops the temporary
   role. Cleanup is a separate approved admin action; do not force-terminate a
   session automatically.

## STOP and recovery rules

Stop before preview for any of the following:

- master, script, schema, database, role, scope, or SSH identity drift;
- missing/extra column grant, inherited role, DML privilege, or schema access;
- more than one scope, missing `default`, or inability to enforce the fixed
  operator scope;
- failed private tunnel, wrong database, `transaction_read_only` not `on`,
  timeout, lock conflict, or unexpected query shape;
- raw financial/receipt data or a credential in output;
- source-state mismatch, ambiguity, non-READY status, or any runner error.

There are no automatic retries. If role creation succeeds and a later step
fails, stop the tunnel and perform only the approved cleanup. If a session
prevents cleanup, set `NOLOGIN` if authorized and escalate without killing a
production backend session. Do not drop, revoke, or alter a role blindly.
Do not restore a backup or change application configuration as recovery.

## Disposable validation

The procedure is validated without production changes by the repository's
existing disposable PostgreSQL integration path. Relevant merged coverage is:

- `tests/matched-purchase-preview-read-only-runner.test.js` for the runner's
  bounded read-only transaction, rollback, aggregate output, and write guard;
- `tests/matched-purchase-orchestration-postgres.integration.test.js` for the
  authoritative orchestration path and PostgreSQL fixtures; and
- the explicit-column projection regressions merged in PR #156.

A disposable rehearsal may create a temporary role and apply the exact
allowlist above, run the runner against synthetic/empty data, assert every
listed column is readable and every DML class is denied, then revoke and drop
the role. This rehearsal must use an isolated database and must not use a
production connection string. No new production code or schema is required
for this role plan.

## Security decision and next approval

For the one-time operator preview, the simplest safe path is:

`exact-master local runner -> private SSH loopback -> short-lived column-allowlisted LOGIN role -> PostgreSQL`

This is acceptable only while the independently verified scope count is one
and the operator keeps the scope literal `default`. It is not a general
ChatGPT connector boundary and is not suitable for a long-lived service when
multiple scopes exist. A future multi-scope or unattended integration would
need a separately reviewed row-isolation boundary; this document does not
introduce RLS or `SECURITY DEFINER`.

The exact next authorized operation is a separate approval for an administrator
to create the short-lived role, apply only the matrix above, independently
verify privileges, run one bounded exact-master read-only preview, verify no
write, and revoke/disable/drop the role. Until that approval, production role
creation and preview remain not executed.

# Canonical Spending Read Service v1

## Status

This is a repository-owned core service adapter and security contract. It is
not a ChatGPT connector registration, deployment, database grant, or
production activation.

The adapter delegates to the existing `queryCanonicalSpending(pool, options)`.
It does not reimplement certification, ledger, source-state fingerprints,
period aggregation, or purchase/return accounting rules.

## Invocation contract

The intended transport shape is:

`ChatGPT -> supported connector/plugin -> authenticated service adapter ->
queryCanonicalSpending() -> PostgreSQL -> curated JSON -> ChatGPT`

This repository does not currently prove that a specific ChatGPT connector or
plugin is registered or available. The included mock connector test verifies
the contract boundary only. A real connector requires a separate reviewed
registration and deployment decision.

The service requires:

- an authenticated caller;
- a server-side scope resolver that maps the authenticated principal to an
  approved accounting scope;
- an allowlisted period and IANA timezone;
- bounded page size and offset;
- the existing authoritative source-state and READY validation;
- a read-only database connection used by the delegated query API.

The caller's `scopeKey` is only a selector passed to authorization. It never
authorizes access by itself. The resolver must derive the permitted scope from
the authenticated principal and reject foreign scopes.

## Safe result contract

The service returns only a curated projection:

- `READY`, `STALE`, `MISSING`, `CONFLICT`, `CORRUPT`, or
  `ACCESS_ERROR`;
- safe source-state/run identity when available;
- explicit timezone and half-open period;
- decimal-string gross, returns, and net by currency;
- confirmed purchase/return rows at purchase grain;
- category/person attribution metadata and unattributed rows;
- explicit bank-only/incomplete limitations.

It never substitutes historical values or zero for a non-READY result. Raw
notifications, fiscal payloads, account/card references, credentials, and
secrets are not returned or logged.

Safe logs contain only an event name, scope key, status/reason, source-state
identity, run id, and aggregate row/currency counts. Query errors are redacted.

## Database and operational boundary

The delegated query executes inside its existing bounded
`REPEATABLE READ READ ONLY` transaction and rolls back. The service adds no
writes and does not change session grants. The production connection must be a
least-privilege read-only path; direct `chatgpt_reader` SELECT on canonical
public objects is not a substitute.

A future activation review must establish:

1. connector authentication and scope authorization;
2. a production read-only role/path;
3. rate limits, request IDs, timeout budgets, and safe logging;
4. current source-state/READY behavior under concurrent ingestion;
5. denied-permission and stale-snapshot handling;
6. a nonzero return proof before publication.

No `SECURITY DEFINER`, `GRANT`, `REVOKE`, DDL, timer, writer,
materialization, replay, backfill, deployment, or automatic classification is
part of this PR.

## Fail-closed service gates

The adapter exposes financial data only when the delegated result is
simultaneously `ok=true`, `status=READY`, and has a complete validated
snapshot, half-open query period, pagination contract, and curated data shape.
Any contradictory or incomplete READY-shaped result is returned as
`CORRUPT` with `data=null`. Foreign explicit scope selection is rejected;
the service never substitutes `default`. Caller timeout fields are ignored;
server-owned bounded timeout values are passed to the authoritative query.

## Disposable performance evidence

The PostgreSQL integration fixture measures three distinct operations inside
an isolated `REPEATABLE READ READ ONLY` transaction: the existing
`certificationSourceStateKey` fingerprint, the current-snapshot READY guard
using that measured key, and the complete period query including its own
snapshot guard. It records only elapsed milliseconds and fixture row scope in
test output; it does not benchmark production or perform writes. The
measurement is available when `TEST_DATABASE_URL` points to the disposable
PostgreSQL fixture. If that gate is unavailable, performance remains
`UNMEASURED` rather than being inferred from unit tests.

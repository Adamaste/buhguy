# Canonical Spending MCP Transport v1

Status: implementation-only, non-production.

## Scope

This PR adds one official Model Context Protocol JavaScript SDK server with the
Streamable HTTP transport. It exposes exactly one read-only tool,
`canonical_spending_read`, and delegates all accounting behavior to
`createCanonicalSpendingReadService() -> queryCanonicalSpending()`.

There is no MCP-specific certification, ledger, source-state fingerprint,
matching, or SQL publication logic here. The existing read-service remains the
only authority for authentication, scope authorization, current-snapshot
identity, READY validation, period filtering, decimal strings, pagination, and
fail-closed statuses.

The server returns no financial data unless the delegated result is a coherent
READY result. MISSING, STALE, CONFLICT, CORRUPT, ACCESS_ERROR and technical or
malformed-request failures keep `data: null`.

## Security boundary

- The server accepts injected `authenticate` and `authorizeScope` callbacks;
  it does not implement an OAuth provider.
- The MCP tool passes the SDK authenticated `authInfo` to the existing
  read-service. Missing auth context therefore fails closed.
- The database pool must be a dedicated least-privilege read-only pool,
  isolated from bank-ingestion credentials and pools.
- Request rate, page size/offset, server-side DB timeouts, redacted errors and
  summary-only logs remain bounded.
- Only whitelisted request/result fields cross the tool boundary. Raw
  notification, receipt, bank, account, token and secret fields are not
  returned or logged.
- There are no writes, migrations, grants, timers, materialization,
  replay/backfill or automatic certification paths.

## OAuth, Server URL and Secure Tunnel

The ChatGPT Desktop UI confirms that custom MCP creation is available in the
user's real account because it exposes Server URL/Tunnel, OAuth and
“Create as a plugin”. This proves UI availability only; it does not prove
end-to-end connect, OAuth, tool discovery or tool invocation.

The code deliberately relies on the selected supported OAuth/tunnel deployment
path rather than implementing a homemade OAuth provider. A future non-production
test should choose one reviewed mode:

1. **Secure Tunnel (preferred for local rehearsal):** run the isolated
   Streamable HTTP server on localhost, expose only its HTTPS tunnel URL, and
   configure the tunnel/provider-managed OAuth resource if required. Do not
   expose a database or ingestion port.
2. **Server URL:** use only a deployed HTTPS endpoint with a reviewed
   reverse proxy/OAuth resource and health controls. Do not use an
   unauthenticated public URL.

The repository does not provide the tunnel, OAuth registration, client
configuration or hosting. OpenAI/ChatGPT support and registration details must
be verified in the target account/client before connecting. No banking token
may be reused as MCP OAuth material.

## Future test connection instructions

This PR does not authorize a real connection. After separate security review:

1. Create an isolated non-production database with synthetic spending fixtures
   and a dedicated read-only DB role.
2. Start this Streamable HTTP server with the existing read-service and
   server-side `authenticate`/`authorizeScope` callbacks.
3. Use the supported Secure Tunnel or reviewed HTTPS Server URL; confirm no
   database or ingestion port is exposed.
4. In ChatGPT Desktop, create the custom MCP/plugin with that URL and the
   account's supported OAuth flow. Never paste bank credentials or a DB
   password into the UI.
5. Verify discovery, invalid-auth rejection, foreign-scope rejection,
   STALE/MISSING fail-closed behavior, and synthetic 100/20/80 before any
   production consideration.

If the target client cannot complete OAuth/tool discovery, stop at this
adapter contract; do not add a custom OAuth server or broaden permissions.

## Evidence and handoff

Unit tests cover synthetic 100.00 RUB gross, 20.00 returns and 80.00 net,
invalid auth, foreign-scope rejection, MISSING/STALE/CONFLICT/CORRUPT,
malformed requests, rate limiting, redacted errors and service reuse. Existing
disposable PostgreSQL read-service/current-snapshot tests remain the database
proof for current-state guards and zero writes; this transport adds no DB
writes. A live ChatGPT connect/auth/tool call is not claimed.

- Custom MCP registration UI: **CONFIRMED_AVAILABLE** in the user's real
  ChatGPT Desktop account.
- End-to-end connect/auth/tool-call: **NOT_VERIFIED**.
- Automatic certification freshness/materialization: **NOT_IMPLEMENTED**.
- Architecture: **SIMPLE-FIRST / REUSE-FIRST**; keep the existing Node
  read-service and query, with no parallel SQL publication or duplicate
  accounting logic.

## Next action

Security review this non-production adapter, then perform one isolated
synthetic Secure Tunnel/Server URL connection test if the target ChatGPT client
supports the reviewed OAuth path. Production least-privilege access and an
authoritative current-state probe remain separate approvals.

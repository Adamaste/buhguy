# FNS Self-Service Onboarding V1

This tooling prepares a third FNS source without copying credentials through
ChatGPT, PowerShell output, or the database. The real third user is not created
by this development task.

## Operator Flow

```powershell
.\scripts\fns-user.ps1 add "Display name"
# Complete phone, CAPTCHA and SMS in the source-isolated remote Chromium.
# Close Remote Desktop, then:
.\scripts\fns-user.ps1 finish "Display name"
.\scripts\fns-user.ps1 status
```

`retry`, `disable`, and `enable` are safe non-destructive operational commands.
The wrapper starts `browser-start` after `add`, using a per-source profile and
localhost CDP. `browser-stop` is available for manual cleanup. There is
intentionally no normal delete command.

## State Machine

The server-side `onboarding.json` store records:

`CREATED -> WAITING_AUTH -> AUTHENTICATED -> INITIAL_SYNC -> VERIFYING -> ACTIVE`

Failure states are `AUTH_FAILED`, `SYNC_FAILED`, and `VERIFICATION_FAILED`.
The state file is atomically replaced under a `0700` directory with mode `0600`.
Repeating `add` or `finish` is idempotent and cannot create another person/source.

## Database and Config

`add` uses the existing `ensureSource` operation to create one person, source,
relation, and sync-state row with `enabled=false`. It never stores tokens or
cookies in SQL. The source config update is validated, backed up as `.bak`,
atomically replaced, and keeps existing source entries unchanged.

`finish` imports browser state into the target SessionStore, executes the normal
refresh path once, runs the source sync, evaluates the activation gate, enables
the source in both the database and config through a compensating saga, and
evaluates the same gate again after enablement. Detail unavailability is
explicit and non-fatal; conflicts, unclassified errors, normalization issues,
graph failures, and ledger imbalance fail closed.

## GUI and SSH

The PowerShell wrapper uses the existing SSH key only for the SSH connection.
The RDP connection is local-only through an SSH forward. RDP credentials are
not embedded in the script and are handled by Windows Credential Manager.
The candidate launcher uses `--user-data-dir=<source session>/chromium-profile`,
`--remote-debugging-address=127.0.0.1`, a deterministic per-source CDP port,
and a 0600 PID file. Production must run that launcher as the same graphical
user visible through the temporary RDP display; a generic shared RDP profile
must not be reused for two authenticated users.

## Security Rules

- No access/refresh token, cookie, SMS code, password, or private key is accepted
  as a CLI argument.
- Session directories are `0700`; session files are `0600` and owned by the
  collector service account.
- Source #1 and existing active sources remain untouched if source #3 fails.
- A source is never activated before refresh, sync, lifecycle, accounting,
  graph, and ledger checks pass.

## Verification

Local verification covers duplicate add, isolated session paths, source-bound
browser import, localhost CDP binding, PID cleanup, WAITING_AUTH, fail-closed
finish, successful activation, post-enable re-verification, replay idempotency,
atomic config preservation, and restrictive state permissions.

The full test suite result for this candidate is `144 passed, 4 skipped,
0 failed`.

## Deployment Gate

Before proposing production deployment, verify the target-specific temporary
GUI bootstrap under the real graphical service account and run a synthetic
third-source dry run. The repository candidate does not create a real third
person/source and has not been deployed to production. Deployment remains
blocked until the remote display adapter proves source-specific Chromium is
visible in RDP, `finish` can connect to its CDP endpoint, and the full
disposable multi-source verification passes.

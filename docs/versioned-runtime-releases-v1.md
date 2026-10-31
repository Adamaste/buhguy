# Versioned runtime releases v1

**Status:** implementation proposal; not a production authorization.

## Layout and invariants

- A complete runtime is published once at `/opt/accountant/releases/<full-40-character-Git-SHA>/`. Existing release directories are never overwritten.
- `/opt/accountant/releases/current` is a relative symlink to one exact SHA directory. Switching creates a temporary symlink and replaces `current` with one same-filesystem rename. There is no `latest` selector and no separately updated `previous` pointer; the selector command reports the exact prior SHA, which is the only accepted rollback target.
- `release-manifest.json` binds the full target SHA to the sorted runtime file inventory, Git blob identity for repository files, SHA-256, byte size, and immutable POSIX mode. Every verify/select command also requires the expected manifest SHA-256 from the reviewed artifact record.
- Sealing checks repository file modes against the exact Git tree as well as file contents; executable flags cannot be introduced or lost during staging.
- Release files and directories are read-only (`0444`/`0555`); executable bits from Git/runtime dependencies are retained as `0555`. Symlinks must resolve inside the release. Hardlinks, special files, unexpected paths, traversal, sensitive names, writable files, missing files, or hash/mode drift stop the operation.
- The artifact contains `bin/`, `src/`, `db/migrations/`, `package.json`, `package-lock.json`, `node_modules/`, this verifier, and the three explicitly allowlisted migration runners: `scripts/migrate-prod-troika-024.mjs`, `scripts/migrate-prod-bank-only-025.mjs`, and `scripts/migrate-prod-bank-only-026.mjs`. No other `scripts/` content is allowed. Sealing checks all three runner paths against the target Git tree and fails with `RUNTIME_FILE_MISSING` if any is absent from the staged archive; all files are recorded with Git blob and SHA-256 in the manifest. It excludes `.receipt-collector`, `.env`, tokens/cookies, browser profiles and binaries, logs, backups, PostgreSQL files, Android, tests, and local caches. Playwright's package is included; browser downloads are not.

## Preserve the legacy working directory

`receipt-collector-sync.service` keeps its existing `User=receiptcollector`, `Group=receiptcollector`, `WorkingDirectory=/opt/accountant/receipt-collector`, `EnvironmentFile`, sandbox, and `ReadWritePaths`. Only its `ExecStart` changes to the release selector path; the existing sync arguments remain unchanged.

The old `WorkingDirectory` is intentional: `SessionStore` and FNS onboarding state resolve from `process.cwd()`, so cookies, tokens, profiles, config, and `.receipt-collector` stay where they are. `src/database.js` resolves migrations from `import.meta.url`, so migrations follow the selected release. FNS onboarding child processes now resolve `bin/receipt-collector.js` from the importing release module while keeping the old `cwd`; this avoids accidentally spawning the mutable legacy entrypoint.

The current unit's tracked argument vector is preserved in the service template. During a future one-time migration, compare the *effective* installed unit first and preserve its actual arguments exactly; if they differ, stop rather than substituting the template arguments. Do not edit the bank-ingestion, backup, or FNS-browser units.

## Build and seal an artifact offline

Use a detached worktree at the exact full SHA and a fresh empty staging directory. The release is assembled only from Git objects plus the production dependency installation:

```sh
SHA=<full-40-character-commit-sha>
git worktree add --detach "$WORKTREE" "$SHA"
mkdir -m 0755 "$STAGE"
git -C "$WORKTREE" archive --format=tar "$SHA" \
  bin src db/migrations deploy/runtime-release.mjs scripts/migrate-prod-troika-024.mjs scripts/migrate-prod-bank-only-025.mjs scripts/migrate-prod-bank-only-026.mjs package.json package-lock.json \
  | tar -xf - -C "$STAGE"
for required in scripts/migrate-prod-troika-024.mjs scripts/migrate-prod-bank-only-025.mjs scripts/migrate-prod-bank-only-026.mjs; do
  if [ ! -f "$STAGE/$required" ]; then
    printf 'required runtime runner missing from git archive: %s\n' "$required" >&2
    exit 1
  fi
done
(cd "$STAGE" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts)
node "$STAGE/deploy/runtime-release.mjs" seal \
  --source-root "$WORKTREE" --release-dir "$STAGE" --sha "$SHA"
tar -C "$STAGE" -czf "buhguy-$SHA.tar.gz" .
sha256sum "buhguy-$SHA.tar.gz"
```

`seal` compares every included repository file with the exact Git tree, checks the dependency tree and Node >=22 import closure, writes the deterministic manifest, and normalizes immutable modes. Record both the printed manifest SHA-256 and archive SHA-256 outside production. Do not put runtime state or credentials in the worktree or artifact. If runtime code requires a file outside this allowlist, stop and review that dependency before extending the package.

## Publish and select

The archive is transferred and its archive SHA checked before extraction. Extract into `/opt/accountant/releases/.staging-<SHA>` on the same filesystem as `/opt/accountant/releases`. Never extract over an existing SHA directory. Then:

```sh
SHA=<reviewed-full-sha>
MANIFEST_SHA256=<reviewed-manifest-sha256>
STAGE="/opt/accountant/releases/.staging-$SHA"
ROOT=/opt/accountant/releases

# Read-only check as the actual service user; the script is in the staged release.
sudo -u receiptcollector /usr/bin/node "$STAGE/deploy/runtime-release.mjs" verify \
  --release-dir "$STAGE" --sha "$SHA" --manifest-sha256 "$MANIFEST_SHA256"

# Required free-space/inode floors must come from the approved budget, never guessed.
sudo /usr/bin/node "$STAGE/deploy/runtime-release.mjs" publish \
  --release-root "$ROOT" --sha "$SHA" --manifest-sha256 "$MANIFEST_SHA256" \
  --minimum-free-bytes <approved-free-byte-reserve> \
  --minimum-free-inodes <approved-free-inode-reserve>

# Select only this exact release. The JSON result includes previousSha.
sudo /usr/bin/node "$ROOT/$SHA/deploy/runtime-release.mjs" activate \
  --release-root "$ROOT" --sha "$SHA" --manifest-sha256 "$MANIFEST_SHA256"
```

`publish` checks the staged manifest and content again, checks that the release root and stage share a filesystem and that the approved free reserve remains, then renames the stage directory to the absent SHA path. If that SHA already exists and verifies identically it is a no-op; a mismatch is STOP. The rename does not duplicate the staged bytes. During transfer/extraction, budget the archive and expanded staging simultaneously if they share a filesystem; keep all prior releases. The service user must pass `verify` before selection, and systemd read-only sandboxing remains unchanged.

`activate` is idempotent for the selected SHA. It verifies the complete release before and under a lock, creates a temporary relative symlink, atomically renames it over `current`, fsyncs the release directory, and reads the selector back before reporting success. A stale lock, malformed current selector, failed verification, or unconfirmed readback is STOP; the tool does not delete unrelated temporary paths or releases. Root is required for publish/activate/rollback. The selector operation changes no service, timer, state, or database.

When `current` already selects a release, activation also requires
`--previous-manifest-sha256 <current-release-manifest-sha256>` and verifies
that release before switching. This proves the exact prior runtime remains a
usable code rollback target. Omit it only on the first selection when
`current` is absent and the separate legacy-unit rollback path is preserved.

## First legacy transition and rollback

This is a separate, bounded maintenance action; this document does not authorize it.

1. Record the effective sync `ExecStart`, `WorkingDirectory`, `User`, drop-ins, timer enablement, and current run status in a protected operator record. Do not log secret values. Do not infer a sync rollback from the bank-ingestion release SHA.
2. Build, transfer, verify, publish, and service-user-check the new release before changing systemd. Keep `/opt/accountant/receipt-collector` and all state untouched. Select only the exact release SHA. Confirm `/opt/accountant/releases/current` is either absent or a valid selector; an unexpected existing path is STOP. The legacy sync timer may remain as-is during this preparation because its current `ExecStart` does not use the new selector.
3. Immediately before changing the unit, require no active sync and separately approved timer quiescence if needed to prevent a run during the switch. Confirm the legacy application path and state are still present and unchanged; if the old code path has drifted or cannot be safely returned to, STOP. Do not treat the legacy tree as a hash-verified historical release.
4. Apply a drop-in that resets `ExecStart` and then supplies `/usr/bin/node /opt/accountant/releases/current/bin/receipt-collector.js` plus the exact prior arguments. Preserve `WorkingDirectory`, user/group, `EnvironmentFile`, sandbox, timer settings, and all write paths. Run `daemon-reload`, verify effective properties, then perform only the separately approved service activation and natural-cycle checks.
5. Before first activation, rollback uses the exact original `ExecStart` and its preserved mutable directory: remove/restore only the new `ExecStart` drop-in, reload systemd, and use the separately approved service/timer recovery sequence. The old path is never overwritten, so it reads the current state in the preserved working directory. This is a path-preservation rollback, not proof of the old code's historical SHA; if that mutable tree changes, stop rather than claiming it is a verified rollback. Do not restore an old session/token snapshot.
6. After a release is selected, rollback to another immutable version is `rollback --release-root /opt/accountant/releases --sha <exact-previous-sha> --manifest-sha256 <target-manifest-sha> --previous-manifest-sha256 <currently-selected-manifest-sha>`. Never use `latest` or guess a SHA. A code rollback does not reverse database schema changes or financial writes.

STOP on any artifact/hash/mode mismatch, unknown dependency, unreadable release for `receiptcollector`, incompatible Node version, missing/ambiguous original unit arguments, active sync, failed health check, insufficient measured staging/free-space/inode/WAL/emergency reserve, or unverified backup/recovery gate. No release cleanup is part of deployment.

## Database and matching boundaries

The release tool runs no migrations and changes no grants. Rollback restores code selection only; schema changes require a separately reviewed backward-compatible migration plan and a database restore is never an automatic rollback step. PR #172's matched-purchase writer remains OFF: do not set its enable flag or scope as part of release selection. This PR does not authorize production access, backup, timer/service changes, sync, canary, or deployment.


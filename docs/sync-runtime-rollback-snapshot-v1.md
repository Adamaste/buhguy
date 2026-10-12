# Sync Runtime Rollback Snapshot v1

This procedure creates a content-verified, code-only snapshot of the current sync runtime. It does not identify a Git commit, attest historical provenance, change systemd, or copy mutable state. Production execution requires a separate explicit authorization.

## Guarantees and limits

- The snapshot follows statically declared ESM imports, literal dynamic imports, and literal CommonJS `require()` calls. Any unescaped template interpolation stops closure analysis because it may hide a runtime import. It includes the entrypoint, reached JavaScript modules, package metadata, and `package-lock.json` when present.
- Conditional package exports use Node's ordered condition matching for `node`, the active `import` or `require` condition, and `default`. Export arrays, custom or otherwise unsupported conditions, patterns, and unsupported targets stop the snapshot instead of guessing.
- Missing required imports, non-literal imports/requires, unsupported package exports, non-code paths, symlinks, hardlinks, permission/I/O errors, source races, and insufficient free space fail closed.
- An absent dependency is accepted only when the owning package metadata explicitly marks it as an optional dependency/peer. The omission is recorded in the manifest and rechecked during verification.
- The manifest records SHA-256, size, observed source mode, normalized snapshot mode, static module edges, and a content fingerprint. `gitCommit` is always `null`; a fingerprint is not a commit SHA or proof of what historically ran.
- `.env`, credentials, tokens, FNS/browser profiles, `.receipt-collector`, logs, backups, dumps, and financial data are rejected by path classification and are never copied. Dynamic filesystem-loaded code/assets and external executables are outside static module analysis: if the read-only inventory finds any runtime code/resource dependency not represented by the static import graph, STOP rather than extending the copy ad hoc.
- POSIX snapshot modes are `0755` for files that had any execute bit and `0644` otherwise; directories are `0755`; special bits and writable group/other bits are not retained. Verification must be run as the actual sync service user to prove access.
- Source mode `0777` is recorded as an observation, not trusted. The source must be quiesced by a separately authorized operator action. The tool checks stability twice, but cannot prove the operator's quiescence attestation or prevent a privileged writer from changing the source.
- Snapshot creation copies one closure into a temporary sibling directory and atomically renames it to a new fingerprinted directory on the same filesystem. The temporary directory is removed on handled errors only when its operation marker matches. A power loss can leave a marked temporary directory; the next run stops on any `.sync-rollback-tmp-*` sibling, which must be investigated and removed only under a separate exact-path authorization.

## Local rehearsal

Use the exact source/entrypoint discovered from the service contract and synthetic data only:

```sh
node --check scripts/sync-runtime-snapshot.mjs
node --test tests/sync-runtime-snapshot.test.js tests/release-manifest-readonly-helper.test.js
```

The POSIX gate must run in an isolated Linux environment. Windows mode bits are reported as unconfirmed and are not a substitute.

## One-time production snapshot gate

Do not run until a separate authorization explicitly permits the snapshot operation and the required sync quiescence. The tool can be sent to the remote Node process over SSH standard input; this avoids installing a helper file on production. The following PowerShell 7 form is a template, not permission to connect:

```powershell
$tool = [IO.File]::ReadAllText((Resolve-Path '.\scripts\sync-runtime-snapshot.mjs'), [Text.Encoding]::UTF8)
$tool | ssh -T <approved-host-alias> node --input-type=module - create `
  --source-root /opt/accountant/receipt-collector `
  --entrypoint <relative-entrypoint-confirmed-from-ExecStart> `
  --destination-parent /opt/accountant/releases `
  --minimum-free-bytes <approved-free-space-floor-in-bytes> `
  --minimum-free-inodes <approved-free-inode-floor> `
  --sync-quiesced yes
```

Before that command, independently establish and record (without printing environment values):

1. `receipt-collector-sync.service` `User`, `WorkingDirectory`, effective `ExecStart`, drop-ins, and timer state; resolve exactly one application entrypoint. If the entrypoint is uncertain or is not the one used by the service, STOP.
2. No sync run is active and no new timer invocation can start during capture. Let an active cycle drain naturally; do not kill it. Quiescing/stopping the timer is a separate production state change and needs explicit approval.
3. The runtime source, `/opt/accountant/releases`, and PostgreSQL/WAL mountpoints are known. Capacity policy supplies a positive free-space floor including independently approved WAL/emergency reserve. The tool itself requires that floor and adds a block-rounded estimate for the snapshot and metadata; unknown reserve means STOP.
4. A read-only dependency inventory has no runtime-loaded code/assets outside the static closure. An unsupported dynamic import/require or external runtime dependency is STOP, not permission to broaden the allowlist.

The only production write paths for the snapshot operation are:

- `/opt/accountant/releases/.sync-rollback-tmp-<generated-uuid>/` during atomic staging;
- `/opt/accountant/releases/sync-rollback-<first-16-fingerprint-hex>/` after publication.

No state, source, backup, database, unit, timer, permission, or service path is writable in this operation. If a separate bootstrap copy of the tool is needed instead of SSH stdin, stop and seek authorization for that additional exact path; this template does not authorize it.

## Verification and rollback preparation

After `create` returns a path and full fingerprint, verify it from the same snapshot tool as root and as the exact service account. For the latter, stream the tool again and run `verify --snapshot-root <returned-path>` under `sudo -u <sync-user>`; require `status=PASS`, exact file count/fingerprint, and readable/executable path traversal. Do not infer service access from root verification.

The library API `buildRollbackPlan()` is covered by the synthetic rehearsal: it verifies every snapshot file, replaces exactly the prior entrypoint argument, hashes but never prints the original command vector, and preserves the prior `WorkingDirectory` and all other arguments. The current task does not change a unit or apply a rollback. Before a later deploy, capture the original effective ExecStart/WorkingDirectory securely, and separately authorize the narrowly scoped sync-unit drop-in and its rollback. Never restore an old copy of FNS state or tokens; the old code must use the current WorkingDirectory/state.

## STOP conditions

- Service identity, entrypoint, owner/modes, dependency closure, quiescence, or same-filesystem destination is uncertain.
- Any non-optional dependency is missing; any optional absence is not explicitly declared by package metadata.
- Source changes between passes, symlink/hardlink/special file exists in the closure, a path is sensitive/unknown, or the manifest verification differs.
- Service-user verification fails, the snapshot is not `PASS`, the destination already exists, a stale/active temporary snapshot sibling is present, or the computed free-space check fails.
- Backup restore readiness or the independent WAL/emergency reserve is unknown. This snapshot operation does not resolve those deployment gates.

On STOP, make no unit changes and do not clean up unrelated paths. Preserve only classified diagnostics and request a fresh, narrowly scoped authorization if additional production inspection or writes are needed.

# BUHGUY Account Transfer Guide

This guide transfers project context from the old ChatGPT/Codex account to a
new account without recloning, losing local worktrees, or restarting closed
engineering stages.

## Source of truth

Start with GitHub repository `Adamaste/buhguy`, not old chat history. Read in
full:

1. `docs/BUHGUY-CURRENT-HANDOFF.md`
2. `docs/BUHGUY-ROADMAP.md`
3. `docs/BUHGUY-P0-RELIABILITY-PLAN.md`

Then verify GitHub `master` and inspect only the active task's code, tests,
documentation, PR, and CI. PR #152 is open and unmerged; do not continue or
merge its MCP work unless a new explicit decision authorizes it.

## What is complete

- FNS and Android evidence foundations, provider normalization, provenance,
  account identity, bank cash-flow and balanced-journal projections.
- Bank-to-receipt matching, matched-purchase persistence, ACTIVE-ledger
  supersession semantics, exact-decimal certification, and guarded current
  snapshot reading.
- Production migration 019 and analytics 011 rollout, controlled matched-
  purchase evidence, and the first separately authorized certification
  materialization are documented in the handoff.
- Canonical spending read API v1 and the disposable `100.00 / 20.00 / 80.00`
  return proof are merged. This is not permission to expose production data
  through a new connector.

## What is not complete

- Fully autonomous lossless capture/retry/recovery and freshness observability
  across Android, outbox, ingestion, matching, ledger, and certification.
- Automatic certification freshness/materialization.
- A production ChatGPT connector/publication path.
- MCP transport: PR #152 is deliberately open and unmerged.

## Local Windows state

The primary local project folder is already available on the old Windows user
profile. Do not reclone it. The primary worktree is intentionally dirty and
contains uncommitted Android/package/local diagnostic work; preserve it.
There are 22 existing Git worktrees under the user's Codex/Documents folders.
The metadata-only local inventory is outside the repository and is identified
by the previous session's final report. If its path is not known, locate the
file named `BUHGUY-LOCAL-ONLY-INVENTORY-*.md` under the local Codex folder;
do not upload it.

Use a new clean worktree for any code or documentation change. Never use
`reset`, `clean`, `stash`, destructive checkout, or an unreviewed move/delete
to make the primary worktree look clean.

## GitHub SSH state

The same Windows user profile already has a standard OpenSSH user config with
the alias `github-buhguy`, pointing to GitHub as user `git` and using only the
registered `github_buhguy_ed25519` identity. The project origin is:

`git@github-buhguy:Adamaste/buhguy.git`

The new account should reuse this configuration and key; do not create another
key or print private-key contents. Confirm access with a harmless SSH greeting
and `git ls-remote`, remembering that GitHub's `ssh -T` greeting can exit with
code 1 after successful authentication.

## Account actions that must be manual

The user must sign in to the new ChatGPT/Codex account and reconnect any
account-scoped GitHub, database, BlazeSQL, or other application connectors.
Chats, memory, connector sessions, browser sessions, secrets, account plan,
and account settings do not migrate automatically. Do not copy credentials,
browser profiles, database dumps, or raw financial data as a workaround.

The new account should open the existing local project folder, verify the
`github-buhguy` SSH alias, and use the transfer inventory plus this document.
No new clone is required.

## Exact first task after transfer

Read the handoff and roadmap, verify master and open PRs, then execute the
P0 reliability baseline: a read-only inventory of Android capture/outbox,
backend ingestion, deduplication/recovery, ACTIVE-ledger safety, and
certification freshness. Produce safe aggregate gaps and acceptance tests;
do not continue PR #152 and do not mutate production.

## Starter message for the new ChatGPT

```text
Continue Adamaste/buhguy from the current GitHub master. Read docs/BUHGUY-CURRENT-HANDOFF.md, docs/BUHGUY-ROADMAP.md, and docs/BUHGUY-P0-RELIABILITY-PLAN.md completely. Verify master and open PRs. PR #152 is open and must not be merged or continued. Use SIMPLE-FIRST / REUSE-FIRST. Start with the read-only P0 reliability baseline for capture/outbox, ingestion, deduplication, recovery and certification freshness. Do not deploy, migrate, grant, write production, replay, backfill, or materialize automatically.
```

## Starter message for the new Codex

```text
Continue Adamaste/buhguy in a new clean worktree from GitHub master. Read the current handoff, roadmap and P0 reliability plan first. Preserve the dirty primary worktree and all existing worktrees. Verify the github-buhguy SSH remote. PR #152 remains open and unmerged. Do not use reset/clean/stash or production mutations. Begin with a read-only reliability baseline and propose the smallest reviewed fix.
```

## Transfer acceptance checklist

- GitHub master and relevant CI verified.
- Primary worktree and all 22 worktrees preserved.
- Local-only inventory remains outside Git.
- SSH alias and repository access confirmed under the same Windows user.
- New account connectors reconnected manually where needed.
- No secret, payload, dump, browser profile, or local inventory file committed.
- First task is the P0 reliability baseline, not MCP or a repeated historical stage.

# Instructions for Codex sessions

## Bootstrap

- Read `docs/BUHGUY-CURRENT-HANDOFF.md` and `docs/BUHGUY-ROADMAP.md` before technical work.
- Treat GitHub `master` as the source of truth for code, merge state, CI, and documented artifacts.
- Inspect the active task's relevant code/tests/docs only; do not repeat closed stages.
- After a meaningful stage, update the handoff through a reviewed documentation PR.

## Engineering rules

- SIMPLE-FIRST / REUSE-FIRST is permanent. Reuse existing repository mechanisms
  before adding services, protocols, publication layers, or parallel accounting
  logic. Record why an existing mechanism cannot satisfy the contract before
  introducing a new one.
- Financial correctness is more important than recognition coverage. Fail
  closed on ambiguity, stale state, incomplete scope, conflicting provenance,
  and unsupported business meaning.
- Preserve exact decimal money, immutable evidence, idempotency, ACTIVE-ledger
  semantics, and one-economic-purchase/no-double-count invariants.
- Check the actual PR diff, exact-head CI, mergeability, and review threads
  before recommending or performing a merge.

## Safety

- Production deployment, DDL, migrations, grants, backfill, replay,
  materialization, automatic writers, and accounting catch-up require separate
  explicit user authorization. Never infer that authorization from a design
  request or a successful test.
- Do not publish raw notifications, receipts, balances, account/card
  references, source event IDs, credentials, tokens, dumps, or personal
  financial data.
- Preserve dirty worktrees and uncommitted files. Do not use reset, clean,
  stash, destructive checkout, or worktree deletion to unblock work.
- Use a fresh clean worktree for changes whenever the primary worktree is dirty.
- Keep local-only inventories, backups, browser profiles, `.env` files,
  `.blazesql` secrets, SSH private keys, and runtime archives outside GitHub.

## Priority

- P0 reliability comes before product categorization, convenience analytics,
  MCP, and assistant automation.
- The current next step is a read-only reliability baseline for capture,
  outbox, ingestion, deduplication, recovery, ACTIVE-ledger safety, and
  certification freshness.
- PR #152 is open and unmerged; do not continue or merge it without a new
  explicit decision.

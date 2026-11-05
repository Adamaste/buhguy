# Addressed historical recovery review

The ordinary funding reconciler previously wrote every eligible lifecycle in a scope. Its optional explicit targets now restrict writes to exact receipt-pair and bank identifiers. Candidate discovery and both directions of uniqueness still cover the full cohort. The target restriction is applied after candidate discovery, so excluded alternatives remain blockers. Normal automatic processing passes no targets and keeps its existing behavior.

## Preparation

Obtain a separately authorized fresh snapshot and reproduce the plan in disposable PostgreSQL. Record exact target IDs, amounts, source evidence, account ownership and current ACTIVE ledger state privately. Never publish receipt payloads or financial identifiers in this document. Validate the current production state again before a separately approved application.

Use the existing matcher with an explicit pairKeys list and an operation-local historical startAt. Keep full matcher candidate discovery. Check that every requested pair is confirmed and no manual or conflicting lifecycle links exist.

On replay, query whether the requested bank already has PREPAYMENT_BANK_FUNDING evidence. If present, revalidate it through the targeted funding reconciler and skip matcher/ledger creation. A protected funded entry must not be explicitly rebuilt: the existing ledger guard correctly rejects that request. Missing or inconsistent funding links are a blocker, not permission to bypass the guard.

For a target without funding evidence, resolve exactly the three confirmed lifecycle events through receipt evidence and lifecycle edges. Reject an unexpected component. Call rebuildLedger with those eventIds, replace false. Call reconcilePrepaymentBankFunding with the same scope, an operation-local startAt and exact targets. Require one persisted or reused funding record per target, with no ambiguous or blocked result.

For independent bank-only targets, use writeBankOnlyPurchase for each explicit bankTransactionId with an operation-local optIn. Retain all existing owner, provider, receipt competition and proof checks. Do not invoke a scope-wide bank-only catch-up.

Finish with the current certification builder using persist true, replace false and reuseUnchanged true, then validate through the current canonical reader. Certification can append a scope snapshot covering existing purchases; this is an expected derived-data effect, not permission to change other economic events.

## Application boundary

This is a staged, idempotent procedure, not one atomic transaction. Each existing writer retains its transaction and locks. A failure can leave a partial lifecycle; stop and inspect it, then retry the same explicit targets after approval. Never repair a failure by weakening evidence, expanding IDs, replacing ledger rows or changing a global cutoff.

For a future production application, separately approve a backup, a bounded maintenance window and writer coordination. Revalidate evidence and all competitors in that window. Use only the reviewed code revision. Prepayment and Alfa configuration remain unchanged. No general accounting catch-up is part of this procedure.

## Verification

Compare every source and accounting row with the fresh rehearsal baseline. Economic event, ledger, source-link and funding changes must belong to the approved targets. Record scope-wide derived certification changes separately. Repeat and require unchanged rows, identical active expense cardinality and amounts, and reused current certification. Check double-entry balance, foreign-key/link integrity and no duplicate ACTIVE expenses.

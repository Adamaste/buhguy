# Historical receipt–bank reconciliation review

This document describes the guarded one-record review path added for cases
where an old bank transaction cannot be resolved safely by the automatic
matcher. The row-level production audit is maintained separately and is not
included here; this file intentionally contains no production transaction IDs,
merchant names, or amounts.

## Review rules

- Amount and time proximity produce a candidate, not proof that two records
  describe the same purchase.
- Automatic matching retains its existing ±5-minute window and configured
  cohort cutoff. This tool does not widen either rule and has no batch mode.
- A current provider binding does not prove which account funded an older
  transaction. Historical account resolution requires independent bank
  statement or bank API transaction-detail evidence for that specific
  transaction.
- Account resolution and receipt pairing are separate decisions. Account
  evidence alone does not prove that a nearby receipt belongs to the payment.
- Advance-only and prepayment-only receipts are not settled purchase proofs.
  Returns require evidence of a matching bank credit before reducing spending.
- A previously saved approval-required link remains one active expense; it is
  not promoted to exact proof just because it is the unique nearby candidate.
- No owner attribution, historical backfill, production accounting change, or
  automatic cohort change is part of this review path.

## Evidence storage

Migration 026 adds an append-only evidence-metadata table. It stores only the
evidence type, SHA-256 of the protected evidence artifact, SHA-256 of the
transaction locator inside that artifact, a pseudonymous operator code, and
for a receipt pair the selected match key and configured cohort boundary. It
does not store statement rows, account numbers, notification text, merchant
text, or receipt payloads. The application role and PUBLIC have no access to
this table or its sequence. Updates and deletes are rejected by a trigger.

The strict migration runner accepts only migration 026 as pending and pins the
canonical SQL checksum. It uses bounded lock and statement timeouts. It does
not change application grants or existing financial rows.

## Operator command

`scripts/manual-bank-reconciliation-review.mjs` is dry-run by default and
accepts one bank transaction per invocation.

1. Inspect a protected external bank statement/API detail in the approved
   evidence vault. Confirm the exact transaction and account independently.
2. Run account mode without `--persist`. Confirm the selected account is
   active and matches the source scope and currency.
3. Only after independent review, persist that account resolution with hashes
   of the evidence artifact and exact transaction locator plus the exact
   `--confirm-target`. This operation changes only that transaction's account
   resolution and appends evidence metadata; it does not write a ledger entry.
4. Run pair mode in dry-run. The existing matcher must return exactly one
   compatible pair with the same scope/currency and a resolved account. It
   must still satisfy the unchanged time window and settlement-stage rules.
5. Confirm the payment-to-receipt relationship from independent evidence.
   If it is missing, ambiguous, already conflicted, or outside the existing
   matcher window, leave the pair unlinked.
6. Pair persistence requires the exact previewed match key, a single explicit
   target confirmation, evidence hashes, and a cutoff exactly equal to
   `MATCHED_PURCHASE_RECONCILIATION_START_AT`. The operation refuses an unset
   or different configured cutoff. All guards are repeated inside the
   existing matched-purchase writer before persistence.
7. Recheck that one active acquisition remains, supersession is valid,
   postings balance, and no duplicate active ledger entry was created.

The tool cannot inspect or authenticate the contents of an external statement.
An authorized reviewer must retain and verify the original evidence in the
approved vault before using `--persist`. The application database role is not
given review-table access.

## Reporting and analytics

Use the existing `chatgpt_accounting` read-only semantic layer for approved
BlazeSQL access. This change adds no production view, grant, or raw-table
access. Canonical spending analytics must count each purchase once from the
validated current snapshot, using its exact scope, certification run, source
state key, and unique purchase identity. Do not sum all certification facts or
join receipt headers directly to multiple source observations. Those SQL grain
corrections are tracked separately in PR #193; this PR does not duplicate
them.

The operator report for a historical period and the current month-to-date
report are separate, read-only calculations. Moscow-local date bounds must be
half-open and kept separate. Receipt totals with unknown currency are not
reported as confirmed rubles; advances, prepayments, and unproven returns are
reported separately from settled spending.

No production report query or database mutation was run by this change.

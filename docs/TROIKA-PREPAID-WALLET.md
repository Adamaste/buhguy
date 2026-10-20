# Troika prepaid wallet accounting

## Scope and current state

This is an opt-in, append-only accounting path for a user-confirmed Troika
stored-value wallet. It is limited to Alfa Bank, the confirmed `****5580` card,
and an explicit user-selected financial account, payment instrument, owner, and
accounting scope. It does not infer a card from provider, time, amount, or a
companion notification.

The production events historically described as 21 RUB and 34 RUB are not
seeded by this change and are not replayed or modified. Their confirmed meaning
is wallet top-up, not transport expense. The two amounts sum to 55 RUB of
historical deposits; this is not the wallet's present balance. The first
confirmation may cite a bank document plus user confirmation. The second must
remain `USER_CONFIRMED`; it is not promoted to notification-derived `EXACT`.

## Accounting model

- A top-up is a stored-value acquisition: debit a separate prepaid-wallet asset
  and credit the selected bank-account asset. It creates no expense.
- A confirmed ride is a stored-value redemption: debit transport expense and
  credit the wallet asset. It creates no bank outflow.
- A ride posting requires the exact `SETTLEMENT_ONLY` receipt ID and records
  that receipt link in the same scope-locked transaction as the movement and
  ledger entry. This closes the race where standalone or lifecycle FNS matching
  could otherwise create an expense before the manual receipt link.
- A ride cannot be posted until a user-confirmed balance snapshot strictly
  before the ride exists. The snapshot is the baseline; historical top-ups are
  not assumed to be the current balance.
- Only one balance snapshot may exist for the same wallet and exact observation
  time; conflicting snapshots fail closed.
- Monetary math uses integer cents. Missing, ambiguous, stale, or insufficient
  balance evidence fails closed.

## Receipt evidence and reconciliation

FNS evidence is attached only by an exact receipt ID after explicit user
confirmation, with matching scope, amount, currency, normalized content, and
payment stage. A top-up receipt remains `PREPAYMENT_ONLY`; a ride receipt must
remain `SETTLEMENT_ONLY`. This code never changes fiscal facts or equates the
two stages. It does not correlate receipts by time and amount.

An explicitly linked receipt is excluded from standalone-purchase, bank/FNS
matching, and prepayment-settlement candidate selection. The bank transaction
is excluded from bank/FNS matching once its top-up is committed. Matching
writers recheck these exclusions under the same scope and transaction locks
immediately before persistence. A receipt already matched, represented in the
business-event graph, or linked to ledger entries is rejected for late linking;
the code never deletes or silently reverses prior accounting.

The V2 policy, scope, cutoff, and time window are unchanged. The runtime role
receives only column-level `SELECT` access to the exclusion identifiers; this
migration grants no write access to the new wallet tables.

## Activation and operation

Migration `024_troika_prepaid_wallet.sql` creates only empty schema and
select-only reconciliation lookup grants. It creates no wallet, balance,
movement, account, card, or financial posting.

Writes are disabled unless `TROIKA_PREPAID_WALLET_MANUAL_ENABLED=true` is set in
the process environment. The flag is absent by default. The module is not
automatically called by bank ingestion, FNS sync, or a reconciliation timer.
Manual writes require an explicitly authorized operator workflow and the exact
user-confirmed transaction, account, instrument, owner, scope, amount, and
reason. No production activation is included in this change.

## Rollback and recovery

To stop new manual wallet writes, unset the feature flag and restart only the
service that explicitly hosts the approved manual workflow. Keep the
read-side exclusions active so existing append-only movements cannot be
matched again. The migration is additive and must not be rolled back by
dropping wallet tables or deleting ledger evidence. Any future correction must
be a separately reviewed append-only accounting event; this implementation
does not provide deletion or reversal operations.

## Verification boundaries

All examples and PostgreSQL tests use synthetic data in a disposable local
database named `finance_receipt_collector_test_*`. The database preparation
script rejects non-local hosts and other database names before dropping the
test schema. No production history is included in fixtures or written by the
tests.

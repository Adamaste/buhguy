# Bank Account Resolution Foundation

This layer separates an observed bank transaction from the financial account
to which it belongs. A bank source and its `bank_source_person` relation are
capture context only; they do not establish ownership of a financial account.

## Model

- `financial_accounts` stores the real money account, institution/provider,
  currency, safe display name, scope, and active state.
- `financial_account_person_relations` stores explicit `OWNER` and
  `AUTHORIZED_USER` relations with provenance and reason.
- `payment_instruments` stores cards or virtual cards as instruments that
  reference an account; an instrument is not an account.
- `bank_account_references` stores provider-scoped masked account/card
  references only when explicitly observed or supplied. No reference is
  guessed from a person, source, or display name.
- `bank_transaction_account_resolution` stores `EXACT`, `MANUAL`,
  `RECONCILED`, or explicit `UNKNOWN` resolution with provenance and reason.

Every newly ingested bank transaction receives an `UNKNOWN` resolution in the
same database transaction. An operator or later reconciliation step may
replace it with an explicit account resolution. No ledger posting, business
event, transfer matching, or ownership inference is performed here.

The exported `bankTransactionAccountCoverage()` report enforces:

`TOTAL_BANK_TRANSACTIONS = RESOLVED_ACCOUNT + UNRESOLVED_ACCOUNT`

This foundation is intentionally separate from provider parsers and from the
double-entry ledger. Raw bank observations remain immutable.

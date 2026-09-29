# Bank Account Resolution Foundation

This layer separates an observed bank transaction from the financial account
to which it belongs. A bank source and its `bank_source_person` relation are
capture context only; they do not establish ownership of a financial account.

## Model

- `financial_accounts` stores the real money account, institution/provider,
  currency, safe display name, scope, and active state.
- `financial_account_person_relations` stores explicit `OWNER` and
  `AUTHORIZED_USER` relations with provenance and reason.
- `payment_instruments` stores cards or virtual cards as independent identities.
  A card may have an owner and may exist before its underlying account is
  proven; `financial_account_id` is an optional explicit link.
- `payment_instrument_person_relations` stores explicit card OWNER or
  AUTHORIZED_USER evidence independently from account ownership.
- `bank_account_references` targets exactly one identity: either a financial
  account or a payment instrument. `MASKED_CARD` references target instruments;
  account references target financial accounts. Duplicate visible masks remain
  allowed because they can be ambiguous.
- `bank_transactions.account_reference_kind` preserves whether a proven
  transaction reference is `MASKED_ACCOUNT`, `MASKED_CARD`, or `OTHER`.
  Historical rows may keep both reference fields NULL.
- `bank_transaction_account_resolution` stores `EXACT`, `MANUAL`,
  `RECONCILED`, or explicit `UNKNOWN` resolution with provenance and reason.

Every newly ingested bank transaction receives an `UNKNOWN` resolution in the
same database transaction. An operator or later reconciliation step may
replace it with an explicit account resolution. No ledger posting, business
event, transfer matching, or ownership inference is performed here.

`resolveBankTransactionAccountFromReference()` is the only `EXACT` path. It
uses the observation provider, stored reference kind and value, and the
transaction's unique accounting scope: zero candidates stays `UNKNOWN`, one
candidate becomes `EXACT`, and multiple candidates stay `UNKNOWN` with an
ambiguity reason. A missing kind also fails closed. The generic resolver only
allows `MANUAL`, `RECONCILED`, and `UNKNOWN`.

`resolveBankTransactionPaymentInstrumentFromReference()` is the separate card
identity path. A proven card reference may resolve to a payment instrument
without resolving the transaction to an account. An explicit later card-to-
account link is required before account resolution can become concrete. Equal
masked suffixes never prove that a card and account are the same product.

Resolution requires exactly one accounting scope among the source's linked
context persons. Zero or multiple scopes fail closed; source context is never
used as financial-account ownership.

## Administrative operator surface

The `receipt-collector bank-account` CLI is an administrative operation. It
supports `create`, `list`, `list-instruments`, `link-person`, `add-instrument`,
`link-instrument-person`, `link-instrument-account`, `add-reference`,
`resolve-reference`, `resolve-instrument-reference`, `resolve-manual`, and
`coverage`. It must run through the
existing administrative/peer-access model; the `receipt_collector` runtime role
does not receive account provisioning or resolution mutation privileges.

`list` and `coverage` emit safe account/resolution metadata only. They do not
emit raw notification payloads, source event ids, credentials, or secret
material. `resolve-manual` requires an explicit reason and the CLI has no
manual `EXACT` operation.

The exported `bankTransactionAccountCoverage()` report enforces:

`TOTAL_BANK_TRANSACTIONS = RESOLVED_ACCOUNT + UNRESOLVED_ACCOUNT`

This foundation is intentionally separate from provider parsers and from the
double-entry ledger. Raw bank observations remain immutable.

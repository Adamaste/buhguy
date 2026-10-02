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
- Card references never prove an underlying financial account. Account
  resolution therefore returns `NOT_APPLICABLE` without changing an existing
  account-resolution row for `MASKED_CARD` transactions. Instrument `EXACT`
  results are idempotent and cannot be silently downgraded by later ambiguity
  or missing candidates.
- `bank_transactions.account_reference_kind` preserves whether a proven
  transaction reference is `MASKED_ACCOUNT`, `MASKED_CARD`, or `OTHER`.
  Historical rows may keep both reference fields NULL.
- `bank_transaction_account_resolution` stores `EXACT`, `MANUAL`,
  `RECONCILED`, or explicit `UNKNOWN` resolution with provenance and reason.

Every newly ingested bank transaction receives an identity resolution in the
same database transaction. A proven, unique account reference may produce
`EXACT`; absent, ambiguous, card-only, or out-of-scope evidence remains
explicit `UNKNOWN`. An operator or later reconciliation step may replace it
with an explicit account resolution. No ledger posting, business
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

The automatic ingestion path is intentionally narrow: it uses only provider
and reference evidence already stored on the transaction, and inserts account
and payment-instrument resolution rows atomically with the observation and
transaction. The runtime role receives only the column-level lookup grants and
resolution-row insert privileges needed for this path; provisioning and
administrative resolution remain separate.

## Explicit source/provider bindings

`bank_source_provider_account_bindings` is an administrative, user-confirmed
fallback for a source/provider pair when a newly ingested transaction contains
no account or card reference at all. It targets an existing financial account,
requires a non-empty reason, and keeps provenance
`USER_CONFIRMED_SOURCE_PROVIDER_ACCOUNT`. A source/provider pair has at most
one active binding; an identical re-bind is idempotent, while replacing an
active binding requires an explicit disable first.

Binding creation requires exactly one accounting scope among all persons linked
to the bank source, and the target account must be in that same scope. Zero or
multiple source scopes fail closed. The relation is capture/accounting context,
not financial-account ownership, and no OWNER relation is created.

During ingestion the precedence is: proven account/card reference resolution
first; otherwise one active source/provider binding may produce account
resolution `MANUAL` with the binding provenance; otherwise `UNKNOWN`. Bindings
never apply to a `MASKED_CARD` reference, an account reference with an unknown
kind, a different provider, a different source, or an ambiguous scope. Existing
transactions are not re-evaluated when a binding is added or disabled.

The administrative surface is `bank-account bind-source-provider`,
`list-source-provider-bindings`, and `disable-source-provider`. The runtime
role has only column-level SELECT for the lookup and no binding DML privilege.

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

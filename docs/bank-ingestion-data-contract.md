# Bank Ingestion Data Contract

## Scope

This change adds a server-side foundation for receiving bank events. It does
not add an Android application, transport authentication, receipt matching, or
bank-to-ledger certification.

The intended evidence chain is:

```text
bank source -> immutable observation/evidence -> normalized bank transaction
            -> future reconciliation candidate -> receipt/purchase linkage
            -> future ledger funding proof
```

The final two stages are deliberately outside this foundation.

## Semantic rules

- `bank transaction != purchase`;
- `receipt != cash flow`;
- a source person mapping does not prove payer or beneficiary identity;
- a bank debit or credit is cash-flow evidence, not an automatic receipt match;
- missing receipt linkage is an explicit absence of linkage, not a validation error;
- direction and amount remain `UNKNOWN`/partial when the source evidence does not provide them;
- no heuristic receipt-to-bank matching is performed.

## Objects

`bank_sources` identifies a source adapter independently of its transport.
Supported source types are `ANDROID_NOTIFICATION`, `BANK_API`, and
`MANUAL_IMPORT`.

`bank_source_person` associates a source with an existing accounting person.
This is an ownership/context mapping only and is not payer evidence.

`bank_event_observations` is append-only evidence. Its payload is validated,
hashed with SHA-256, and deduplicated per source. A repeated event returns
`duplicate`; a changed payload under the same source event id is rejected as a
conflict. Raw payloads are not exposed through the ChatGPT semantic layer.

`bank_transactions` stores the normalized projection of one observation. It
contains no receipt or purchase foreign key by design. Normalization statuses
are `READY`, `PARTIAL`, `UNKNOWN`, and `REJECTED`; direction is `DEBIT`,
`CREDIT`, or `UNKNOWN`. An internal account reference may be retained for
future controlled reconciliation, but it is intentionally excluded from the
ChatGPT semantic view. `event_type` is an evidence-level classification, not a
future accounting business event; the initial values are `UNKNOWN`, `PURCHASE`,
and `INCOMING_TRANSFER`.

## Versioned provider normalization

Provider-specific parsing is selected only from the structured ingestion
metadata. The first versioned parser supports `com.yandex.bank` notification
evidence with exact, deterministic forms for `PURCHASE` and
`INCOMING_TRANSFER`. It prefers the notification description over text,
normalizes whitespace, and accepts only the observed two-decimal RUB amount
format. Missing, malformed, unsupported, or partial evidence remains
`UNKNOWN`/`PARTIAL`; the parser never guesses merchant, counterparty, or
direction.

Raw observations remain immutable. Re-normalization is an explicit, versioned
projection operation; this change does not rewrite historical observations or
run a production backfill.

The `ru.alfabank.mobile.android` parser is currently fail-closed at
`alfa-bank-normalizer-v1`. The three reviewed production observations do not
provide a deterministic amount/currency grammar or unambiguous direction, so
they remain `UNKNOWN`/`PARTIAL`; no Alfa format is promoted to `READY` by this
change. The provider boundary is versioned now so a future evidence-backed
format can be added without changing generic normalization or historical raw
observations.

## Ingestion boundary

The internal handler is `createBankIngestionHandler({ pool })`. It accepts a
validated event envelope with `sourceKey`, `observedAt`, optional
`sourceEventId`/`eventTime`, a bounded scalar payload, and bounded ingestion
metadata. Secret-shaped fields such as tokens, cookies, passwords, session
values, and private keys are rejected. The handler returns `created`,
`duplicate`, or `rejected` with a stable reason code.

Transport authentication is intentionally a separate future task because the
repository does not currently define a suitable internal API authentication
contract.

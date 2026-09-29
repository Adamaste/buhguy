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

## Sber Android normalization v1

The provider-specific `sber-bank-normalizer-v1` applies only when ingestion
metadata identifies provider `ru.sberbankmobile` and adapter
`android-notification`. It supports the one controlled, real-derived incoming
transfer format proven by two samples: the first comma-decimal RUB-symbol
amount after the incoming marker is normalized as `INCOMING_TRANSFER` / `CREDIT`
with `RUB`. A second monetary field in the same notification is treated as a
distinct balance field and is not extracted.

`occurredAt` comes from the envelope `eventTime`, which Android supplies from
`StatusBarNotification.postTime`; the parser never parses a timestamp from
notification text. Sender, merchant, account and card references are not
inferred. Summary/reference-only, ambiguous, malformed, unsupported, and
provider/adapter-mismatched notifications remain `UNKNOWN` or `PARTIAL`.

The raw observation remains immutable. No historical backfill is performed, and
deduplication and source-event conflict behavior remain the existing ingestion
contract.

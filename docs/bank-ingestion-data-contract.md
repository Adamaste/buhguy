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

The `ru.alfabank.mobile.android` parser is intentionally narrow. The historical
`alfa-bank-normalizer-v1` revision accepted only the proven integer-RUB title
amount when it equaled the comma-decimal uppercase-RUB body amount. The active
`alfa-bank-normalizer-v2` revision accepts exactly that integer title form or
the separately observed comma-decimal(two digits) title form; in both cases it
requires normalized title/body monetary equality before extracting the amount,
the proven masked-reference position, and Android envelope event time. It
returns `PARTIAL` with `eventType=UNKNOWN`, `direction=UNKNOWN`, and
`accountReferenceKind=NULL`; no card/account kind or ownership is inferred.
Other Alfa families, metadata mismatches, malformed variants, and ambiguous
notifications remain on the generic normalizer.

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

## Sber Android normalization v4

The active provider-specific `sber-bank-normalizer-v4` preserves the exact
incoming v3 envelope and adds one separately proven Sber Android outgoing-shaped
partial envelope. The dispatch remains scoped to provider
`ru.sberbankmobile`, adapter `android-notification`, and schema version `1`.

For the incoming envelope, normalization remains `INCOMING_TRANSFER` / `CREDIT`
with `READY` / `EXACT`, integer RUB amount, Android envelope event time, and the
proven payment-account `MASKED_ACCOUNT` suffix.

The outgoing-shaped envelope is intentionally partial. Its exact title/body
structure contains an integer RUB amount before the stable `Баланс:` marker,
the comma-decimal balance after that marker, and the proven payment-account
suffix. It produces the integer amount, `currency=RUB`, and
`accountReferenceKind=MASKED_ACCOUNT`, while preserving
`eventType=UNKNOWN`, `direction=UNKNOWN`, `normalizationStatus=PARTIAL`, and
`evidenceQuality=PARTIAL`. No outgoing/debit meaning is inferred.

Reference-only companions, malformed or ambiguous envelopes, missing event
time, and provider/adapter/schema mismatches remain fail-closed. Historical
rows are immutable and are not backfilled or replayed.

## Sber Android normalization v3 (historical revision)

The historical provider-specific revision `sber-bank-normalizer-v3` applied only
when
ingestion metadata identifies provider `ru.sberbankmobile`, adapter
`android-notification`, and schema version `1`. Two newest controlled primary
incoming observations establish the only active current envelope:

`Перевод по СБП от <sender>.`

with body:

`+ <integer> ₽ — Баланс: <grouped comma-decimal balance> ₽ Плат. счёт ••<four digits>`

The first integer-ruble RUB-symbol amount after the incoming marker is
normalized as `INCOMING_TRANSFER` / `CREDIT` with `RUB`. The grouped
comma-decimal field is a distinct balance and is not extracted as the
transaction amount.

`occurredAt` comes from the envelope `eventTime`, which Android supplies from
`StatusBarNotification.postTime`; the parser never parses a timestamp from
notification text. Sender, merchant, and card references are not extracted or
inferred. The account reference is extracted only from the exact proven
payment-account suffix `Плат. счёт ••dddd` and canonicalized as
`MASKED_ACCOUNT`; no other account/card inference is performed.
Summary/reference-only, ambiguous, malformed, unsupported, and
provider/adapter-mismatched notifications remain `UNKNOWN` or `PARTIAL`.

The older v1/v2 envelopes remain historical evidence only and are intentionally
not accepted by the active v3 parser. Raw observations and persisted historical
rows remain immutable; no historical backfill is performed. Deduplication and
source-event conflict behavior remain the existing ingestion contract.

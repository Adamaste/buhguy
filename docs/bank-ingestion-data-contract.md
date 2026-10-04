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

Android ingestion may preserve optional transport provenance in
`ingestionMetadata.sourcePackage` and `ingestionMetadata.notificationChannel`.
`provider` remains the canonical financial provider used for normalization;
the physical Android package and channel are transport evidence only. These
fields do not prove ownership, event type, direction, reconciliation, or that
two packages should be merged. The channel is metadata only and is excluded
from `sourceEventId` identity, so replay and deduplication semantics are
unchanged. Legacy envelopes without either field remain valid.

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
`alfa-bank-normalizer-v1` and v2 revisions used an inaccurate synthetic
reconstruction of the production body grammar and remain historical revisions.
The historical `alfa-bank-normalizer-v3` used the real-derived four-section
body skeleton: title-case transfer and recipient anchors, two proven
masked-reference positions, one comma-decimal(two digits) uppercase-RUB body
amount, and the observed trailing time section. It required normalized
title/body monetary equality, both reference sections, and Android envelope
event time, but returned `PARTIAL` with `eventType=UNKNOWN` and
`direction=UNKNOWN`.

The active `alfa-bank-normalizer-v4` keeps that exact v3 grammar unchanged and
promotes only the complete F5 envelope to `OUTGOING_TRANSFER` / `DEBIT` with
`READY` / `EXACT`, based on additional controlled outgoing evidence. It
preserves amount, `RUB`, event time, and the first proven reference value while
keeping `accountReferenceKind=NULL`; no card/account kind, ownership, or
destination identity is inferred. Other Alfa families, metadata mismatches,
malformed variants, and ambiguous notifications remain on the generic
normalizer. Historical v3 rows are not rewritten or backfilled.

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

## Sber Android normalization v5

The active provider-specific `sber-bank-normalizer-v5` preserves the exact
incoming envelope and promotes one separately proven Sber Android
outgoing-shaped envelope. The dispatch remains scoped to provider
`ru.sberbankmobile`, adapter `android-notification`, and schema version `1`.

For the incoming envelope, normalization remains `INCOMING_TRANSFER` / `CREDIT`
with `READY` / `EXACT`, integer RUB amount, Android envelope event time, and the
proven payment-account `MASKED_ACCOUNT` suffix.

The outgoing-shaped envelope has an exact title/body structure containing an
integer RUB amount before the stable `Баланс:` marker, the comma-decimal
balance after that marker, and the proven payment-account suffix. It produces
`OUTGOING_TRANSFER` / `DEBIT` with `READY` / `EXACT`, the integer amount,
`currency=RUB`, and `accountReferenceKind=MASKED_ACCOUNT`. The promotion is
limited to the unchanged v4 grammar and does not infer recipient identity,
destination account, purchase, or expense semantics.

Reference-only companions, malformed or ambiguous envelopes, missing event
time, and provider/adapter/schema mismatches remain fail-closed. Historical
rows are immutable and are not backfilled or replayed. Existing v4 rows retain
their persisted version and semantics.

## Sber Android normalization v4 (historical revision)

The historical v4 outgoing-shaped envelope had the same exact grammar but
remained `PARTIAL` with `eventType=UNKNOWN` and `direction=UNKNOWN` until the
additional controlled evidence established the v5 semantic revision.

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

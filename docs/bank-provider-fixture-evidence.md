# Bank Provider Fixture Evidence

This document records the privacy-safe result of the September 2026 real-device
capture campaign. The committed fixtures contain only synthetic replacements and
structural shapes; no notification text, real amount, recipient, merchant,
account, card, or source-event identifier is stored.

## Scope

Reviewed providers:

- Alfa Bank: `ru.alfabank.mobile.android`
- T-Bank: `com.idamob.tinkoff.android`
- Sber: `ru.sberbankmobile`
- Ozon Finance: `ru.ozon.fintech.finance`

The campaign proved transport through callback, Room, delivery, and backend for
these providers. Sber evidence preserves the older v1/v2 envelopes as
historical evidence and separately records the two newest controlled primary
samples, observations 147 and 154, which established the exact incoming
envelope that remains active under the current sber-bank-normalizer-v5. Their
reference-only companions 149 and 152 remain unsupported and are never
combined with a primary event.

## Fixture policy

The fixtures under `tests/fixtures/bank-normalization/` preserve only field
presence, whitespace/punctuation shape, and safe marker categories. Values are
synthetic and cannot be correlated with a user's operation. The exact proven
Sber incoming/outgoing clusters and the exact Alfa F5 v4 clusters are marked
`readyCapable: true`; the exact T-Bank top-up v2 cluster is also ready-capable,
while Ozon remains generic/fail-closed.
All unsupported clusters remain fail-closed with `eventType`/`direction`
`NOT_PROVEN`.

### T-Bank

The historical corpus contains 51 observations across 22 exact structural
families. Most money, informational, and empty families remain fail-closed.
Three independent controlled top-up samples establish one narrow exact family:

- body: `Пополнение на <integer> ₽, счет RUB. <dynamic words> Доступно <comma-decimal> ₽`;
- title is optional and is not part of the dispatch grammar;
- the first integer-RUB position is the transaction amount;
- the comma-decimal RUB position after `Доступно` is a balance/availability
  value and is ignored;
- event time comes from the Android envelope `eventTime`.

The historical `tbank-bank-normalizer-v1` result was always `PARTIAL` with
`eventType=UNKNOWN` and `direction=UNKNOWN`. The active
`tbank-bank-normalizer-v2` reuses the exact same body boundary and promotes
only the proven incoming cash-flow direction: exact top-up matches are
`READY`/`EXACT` with `direction=CREDIT`, while `eventType=UNKNOWN` because the
evidence does not establish a unique business subtype for every notification
in the family. The corpus contains three controlled independent top-up samples
and one production E2E top-up sample, represented by four primary observations.
No merchant, counterparty, account, card, or ownership inference is performed.
Malformed, near-miss, historical, informational, and empty families remain
fail-closed.

### Alfa Bank

The current forensic taxonomy contains 24 observations across four top-level
families: integer-title F5, decimal-title F5, empty/companion, and other
historical envelopes. An earlier exact structural classification of the same
corpus retained 11 historical subfamilies; that is a separate metric and is
recorded as `historicalExactStructuralFamilyCount`, not as the current forensic
family count. The corpus includes eight F5 primary observations and four
empty/companion observations after the fresh controlled Alfa outgoing sample.
The eight F5 primaries share one deterministic four-section body skeleton.
Five use the proven minus-integer title and three use the proven
minus-comma-decimal(two digits) title. The body has title-case transfer
and recipient anchors, two masked-reference positions, one comma-decimal(two
digits) uppercase `RUB` amount, and a trailing dynamic/time section. The prior
v1/v2 synthetic body grammar used lowercase anchors and was too restrictive;
production fail-closed behavior prevented incorrect persistence. The historical
`alfa-bank-normalizer-v3` is based on staged real-derived segment evidence and
left `eventType=UNKNOWN` and `direction=UNKNOWN`; its sanitized record is
immutable in `evidence-v3.json`. A fresh controlled outgoing sample
(observation 353) matched that unchanged exact F5 envelope and proves
`OUTGOING_TRANSFER / DEBIT` for the family. The active
`alfa-bank-normalizer-v4` therefore promotes only the exact F5 envelope to
`READY / EXACT`, while preserving title/body amount equality, both reference
positions, uppercase `RUB`, Android envelope event time, and the first proven
reference value. `accountReferenceKind=NULL` remains intentional: no account or
card kind, ownership, or destination identity is inferred. Other Alfa families,
companions, missing sections, and unobserved title/reference combinations remain
on generic normalization. The sanitized v4 evidence is recorded in
`evidence-v4.json`; no real amount or raw payload is committed.

### Sber

The three historical/proven v1 incoming observations and observation 128 remain
immutable historical evidence. They were not active runtime formats under v3
and remain historical/non-active under current v5.
The two newest controlled primary samples (observations 147 and 154) establish
the current exact envelope:

- title: `Перевод по СБП от <sender>.`;
- body: `+ <integer> ₽ — Баланс: <grouped comma-decimal balance> ₽ Плат. счёт ••<four digits>`;
- the first monetary token is the transaction amount;
- the second monetary field is a distinct balance and is ignored;
- semantic result: `INCOMING_TRANSFER` / `CREDIT` / `RUB`;
- event time comes from Android `StatusBarNotification.postTime`, not text.

The historical v4 runtime parser was scoped to provider `ru.sberbankmobile`
with adapter `android-notification` and schema version `1`. Sender, merchant,
and card references are not
extracted or displayed. The account reference is extracted only from the exact
payment-account suffix `Плат. счёт ••dddd` and canonicalized as
`MASKED_ACCOUNT`; no other account/card inference is performed. Reference-only,
summary, ambiguous, malformed, and unsupported notifications remain
`UNKNOWN`/`PARTIAL`.

The separately proven outgoing-shaped partial family is preserved as historical
v4 evidence: it extracts only the integer transaction amount, `RUB`, and the
same payment-account reference, while keeping `PARTIAL`, `UNKNOWN`, and
`UNKNOWN` semantics. A new independent controlled real sample matched that
exact unchanged envelope and proved its outgoing/debit semantics. The v5
revision therefore promotes only that exact provider/adapter/schema-scoped
family to `OUTGOING_TRANSFER` / `DEBIT` / `READY` / `EXACT`. It does not widen
the title or body grammar, and reference-only, malformed, unsupported, and
near-miss envelopes remain fail-closed.

### Ozon Finance

The historical `evidence-v1.json` records a distinct decimal-dot RUB monetary
family with title and body fields, plus an empty-payload family; those fixture
clusters remain immutable. Controlled observation `339` / transaction `273`
belongs to a different integer-RUB/balance family. Observation `341` /
transaction `274` is the separate empty companion from the same controlled
capture time.

For observation `339`, the description and text are structurally equivalent,
contain an integer-RUB monetary position followed by a separate
balance/availability monetary position, and carry explicit top-up/SBP/incoming
markers. The controlled operation proves `CREDIT` for that observation, and
the lexical markers support `INCOMING_TRANSFER` at the observation level. No
account, card, reference, merchant, counterparty, or ownership evidence is
proven. The exact reusable grammar is not proven, the independent matching
sample count is unknown, and observation `339` does not match the historical
v1 family. Therefore no `evidence-v2.json`, `readyCapable` cluster, or runtime
parser is authorized yet; Ozon remains generic/fail-closed. No additional bank
operation should be manufactured solely to obtain another Ozon sample. A
naturally occurring matching notification may later close the grammar gate.

## Future parser acceptance matrix

For each provider, a future parser must cover canonical positive cases only after
the event type, direction, amount, currency, and event-time facts are proven.
Whitespace variants, missing markers, missing/malformed amounts, unsupported
currency, partial notifications, provider isolation, raw immutability, exact
replay, and source-event conflicts must be tested. Cases requiring an
unobserved wording are `NOT_PROVEN`, not invented fixtures.

Generic normalization, Yandex normalization, deduplication, and conflict
semantics remain unchanged. The registered provider-specific runtime paths are
Yandex, Sber v5, T-Bank v2 exact top-up CREDIT, and Alfa v4; Ozon remains
generic/fail-closed.

## Gate

The historical `PARSER_V3_POSSIBLE=YES` gate applied only to the then-current
Sber incoming-transfer envelope recorded in `evidence-v3.json`; it is not the
current project gate. Current fixture authorization is provider-specific:
exact Sber incoming/outgoing v5 clusters, exact Alfa F5 v4 clusters, and the
exact T-Bank v2 top-up cluster are ready-capable. T-Bank v1 remains a
historical `PARTIAL` revision; T-Bank v2 keeps event semantics fail-closed at
`eventType=UNKNOWN` while proving `direction=CREDIT`. Ozon remains
generic/fail-closed. Existing historical fixtures and rows remain immutable;
no historical backfill or parser inference for them is allowed.

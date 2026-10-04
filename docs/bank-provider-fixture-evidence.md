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
samples, observations 147 and 154, for the current v3 envelope. Their
reference-only companions 149 and 152 remain unsupported and are never
combined with a primary event.

## Fixture policy

The fixtures under `tests/fixtures/bank-normalization/` preserve only field
presence, whitespace/punctuation shape, and safe marker categories. Values are
synthetic and cannot be correlated with a user's operation. The exact proven
Sber incoming/outgoing clusters and the exact Alfa F5 v4 clusters are marked
`readyCapable: true`; T-Bank remains partial and Ozon remains generic/fail-closed.
All unsupported clusters remain fail-closed with `eventType`/`direction`
`NOT_PROVEN`.

### T-Bank

The historical corpus contains 51 observations across 22 exact structural
families. Most money, informational, and empty families remain fail-closed.
Two independent controlled top-up samples establish one narrow partial family:

- body: `Пополнение на <integer> ₽, счет RUB. <dynamic words> Доступно <comma-decimal> ₽`;
- title is optional and is not part of the dispatch grammar;
- the first integer-RUB position is the transaction amount;
- the comma-decimal RUB position after `Доступно` is a balance/availability
  value and is ignored;
- event time comes from the Android envelope `eventTime`.

The provider-specific result is always `PARTIAL` with `eventType=UNKNOWN` and
`direction=UNKNOWN`. No merchant, counterparty, account, card, or ownership
inference is performed. Malformed, near-miss, historical, informational, and
empty families remain fail-closed; no READY T-Bank parser is authorized.

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
immutable historical evidence. They are not active runtime formats under v3.
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

One family contains a RUB-symbol/decimal form with title and body fields; another
has an empty payload. Event type, direction, merchant, and counterparty are not
proven.

## Future parser acceptance matrix

For each provider, a future parser must cover canonical positive cases only after
the event type, direction, amount, currency, and event-time facts are proven.
Whitespace variants, missing markers, missing/malformed amounts, unsupported
currency, partial notifications, provider isolation, raw immutability, exact
replay, and source-event conflicts must be tested. Cases requiring an
unobserved wording are `NOT_PROVEN`, not invented fixtures.

Generic normalization, Yandex normalization, deduplication, and conflict
semantics remain unchanged. The registered provider-specific runtime paths are
Yandex, Sber v5, T-Bank v1 partial, and Alfa v4; Ozon remains generic/fail-closed.

## Gate

The historical `PARSER_V3_POSSIBLE=YES` gate applied only to the then-current
Sber incoming-transfer envelope recorded in `evidence-v3.json`; it is not the
current project gate. Current fixture authorization is provider-specific:
exact Sber incoming/outgoing v5 clusters and exact Alfa F5 v4 clusters are
ready-capable, T-Bank v1 remains `PARTIAL` with unknown event semantics, and
Ozon remains generic/fail-closed. Existing historical fixtures and rows remain
immutable; no historical backfill or parser inference for them is allowed.

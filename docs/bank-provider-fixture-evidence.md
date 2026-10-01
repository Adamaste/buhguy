# Bank Provider Fixture Evidence

This document records the privacy-safe result of the September 2026 real-device
capture campaign. The committed fixtures contain only synthetic replacements and
structural shapes; no notification text, real amount, recipient, merchant,
account, card, or source-event identifier is stored.

## Scope

Reviewed providers:

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
synthetic and cannot be correlated with a user's operation. Only the proven Sber
incoming cluster is marked `readyCapable: true`; all other clusters remain
fail-closed with `eventType`/`direction` `NOT_PROVEN`.

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

The active runtime parser is scoped to provider `ru.sberbankmobile` with adapter
`android-notification`, schema version `1`, and version
`sber-bank-normalizer-v4`. Sender, merchant, and card references are not
extracted or displayed. The account reference is extracted only from the exact
payment-account suffix `Плат. счёт ••dddd` and canonicalized as
`MASKED_ACCOUNT`; no other account/card inference is performed. Reference-only,
summary, ambiguous, malformed, and unsupported notifications remain
`UNKNOWN`/`PARTIAL`.

The separately proven outgoing-shaped partial family extracts only the integer
transaction amount, `RUB`, and the same payment-account reference. It remains
`PARTIAL` with `eventType=UNKNOWN` and `direction=UNKNOWN`; no outgoing/debit
semantics are inferred.

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
semantics remain unchanged. Only the scoped Sber Android parser is registered.

## Gate

`PARSER_V3_POSSIBLE=YES` for the exact current controlled Sber
incoming-transfer envelope recorded in `evidence-v3.json` only. Existing v1/v2
fixtures and rows remain immutable historical evidence; no historical backfill
or parser inference for those formats is allowed. T-Bank and Ozon remain
fail-closed.

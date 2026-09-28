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
these providers. The normalized projections remained `PARTIAL` with unknown
direction and no amount/currency projection. Transport success is therefore not
parser readiness.

## Fixture policy

The fixtures under `tests/fixtures/bank-normalization/` preserve only field
presence, whitespace/punctuation shape, and safe marker categories. Values are
synthetic and cannot be correlated with a user's operation. Every current
cluster is marked `readyCapable: false` and `eventType`/`direction` remain
`NOT_PROVEN`.

### T-Bank

Observed structural families include a RUB-symbol amount form with NBSP and
comma-decimal punctuation, informational percentage text, and empty payloads.
The evidence does not prove transaction type, direction, merchant, or
counterparty extraction. A parser must remain `UNKNOWN`/`PARTIAL` for these
families until a safe positive format is captured.

### Sber

One financial-looking family contains a plus marker, RUB-symbol amounts,
punctuation, and a masked suffix. A separate reference-only family has no amount
or currency. Neither proves a complete event type and direction contract.

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
semantics remain unchanged. No provider parser is registered by this change.

## Gate

`PARSER_V1_POSSIBLE=NO` for T-Bank, Sber, and Ozon from this evidence set.
The next minimal step is to capture a privacy-safe positive format with enough
facts for one provider, then implement only that provider-scoped parser.

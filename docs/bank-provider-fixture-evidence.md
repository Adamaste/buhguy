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
these providers. Two consecutive controlled Sber incoming captures additionally
proved one narrow parser-ready format; other Sber notification families remain
fail-closed.

## Fixture policy

The fixtures under `tests/fixtures/bank-normalization/` preserve only field
presence, whitespace/punctuation shape, and safe marker categories. Values are
synthetic and cannot be correlated with a user's operation. Only the proven Sber
incoming cluster is marked `readyCapable: true`; all other clusters remain
fail-closed with `eventType`/`direction` `NOT_PROVEN`.

### T-Bank

Observed structural families include a RUB-symbol amount form with NBSP and
comma-decimal punctuation, informational percentage text, and empty payloads.
The evidence does not prove transaction type, direction, merchant, or
counterparty extraction. A parser must remain `UNKNOWN`/`PARTIAL` for these
families until a safe positive format is captured.

### Sber

Three controlled incoming captures share the proven title/body structures: an
incoming-balance marker, a plus sign, a comma-decimal RUB-symbol amount, a
separator and a distinct balance field. The first monetary token is the proven
transaction amount; the second monetary field is ignored. The semantic result is
`INCOMING_TRANSFER` / `CREDIT` / `RUB`, and event time comes from Android
`StatusBarNotification.postTime`, not notification text.

The runtime parser is scoped to provider `ru.sberbankmobile` with adapter
`android-notification` and is now versioned as `sber-bank-normalizer-v2`. In
addition to the two v1 title forms, the controlled observation 128 proved the
exact sanitized title envelope `✅ Поступление от <sender>`. It does not
extract sender, merchant, account or card references. Related transfer/summary,
reference-only, ambiguous, malformed, and unsupported notifications remain
`UNKNOWN`/`PARTIAL`.

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

`PARSER_V2_POSSIBLE=YES` for the exact controlled Sber incoming-transfer
envelopes recorded in `evidence-v2.json` only. Existing v1 rows remain
immutable; no historical backfill or parser inference for other Sber formats is
allowed. T-Bank and Ozon remain fail-closed.

# Android Bank Notification Collector V1

## Scope

The Android application collects explicitly allowlisted bank notifications and
delivers minimized evidence to the existing bank ingestion contract. It does
not read receipts, identify purchase contents, match receipts, or create
ledger postings.

```text
Android bank app
  -> NotificationListenerService
  -> package allowlist and payload minimization
  -> Room durable outbox
  -> WorkManager HTTPS delivery/retry
  -> bank ingestion envelope
  -> bank_event_observations
  -> bank_transactions
```

## Privacy boundary

Explicitly configured package-only sources are accepted. A logical provider may
also define a narrowly scoped transport alias with a channel gate and local
provider-specific classifier. Non-financial and ordinary unknown alias
notifications are discarded before persistence. A classifier may explicitly
mark a notification `StrongUnknown` only when one of its exact, evidence-backed
financial anchors is present; that state is persisted as immutable evidence but
does not prove event type, direction, amount, or currency. Notifications from all other applications,
including SMS, email, messaging, and system packages, are ignored before
persistence. V1 stores title, text, optional bigText/subText,
package name, notification identity, post time, and capture time. Arbitrary
Android extras and images are not collected.

For the Yandex Pro transport alias, the only strong financial anchors are a
normalized body beginning with `Покупка на`, a title exactly equal to
`Входящий перевод`, or a normalized body beginning with `Пополнение на`.
Complete supported grammar remains `Financial`; an anchored but incomplete or
unsupported format is `StrongUnknown` and is captured for immutable evidence.
The backend normalizer remains fail-closed for that evidence.

The delivered envelope may also preserve `sourcePackage` and the non-blank
`notificationChannel` as bounded transport provenance. For the Yandex
transport alias, `ru.yandex.taximeter` with its proven channel still uses the
canonical provider `com.yandex.bank`; direct Yandex notifications likewise
keep the canonical provider while recording their physical package/channel.
This provenance does not infer ownership, event type, direction,
reconciliation, or a package merge.

Logs contain only a short event-id hash prefix, package name, delivery status,
HTTP status, and retry count. Full notification text, amounts, account/card
references, and authentication material are not logged.

## Outbox and delivery

The local Room outbox is durable across process termination and reboot. Events
are `PENDING`, `SENT`, or `PERMANENTLY_REJECTED`. A deterministic SHA-256
`sourceEventId` is derived from package name, notification key/id/tag, and
post time. It is not a random UUID, so retries reuse the same server identity.

`created` and `duplicate` responses become `SENT`. Network failures, timeouts,
HTTP 429, and HTTP 5xx return WorkManager retry. HTTP 4xx and permanent server
rejections become `PERMANENTLY_REJECTED` and are not retried endlessly.

The transport uses an auth-provider abstraction in the delivery boundary; V1
does not hardcode or provision production credentials. Production delivery
must use HTTPS and a separately reviewed authentication mechanism.

## Configuration

The minimal UI exposes notification access status, the system settings button,
server URL, source key, allowlisted packages, pending count, last successful
delivery, and a connection test. Bank mappings use a registry with
`RAW_ONLY` parser strategy so later bank-specific parsers can be added without
spreading package checks through the listener.

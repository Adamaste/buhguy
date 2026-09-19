# Bank Device Authentication

The Android collector sends sanitized notification evidence through:

`NotificationListenerService -> Room outbox -> HTTPS -> bearer device credential -> bank source -> bank_event_observations -> bank_transactions`

Bank transactions remain separate from receipts, purchases, payer proof and ledger postings. This feature does not perform receipt matching or accounting posting.

## Provisioning

Create a credential for an existing enabled or disabled bank source:

```text
receipt-collector bank-device create --source-key android-phone-1 --display-name "Android phone"
```

The command prints a `bg1.<credential_key>.<secret>` token once. PostgreSQL stores only the SHA-256 hash of the random 256-bit secret. `list` shows metadata without token or hash, and `revoke --credential-key <key>` disables the credential immediately.

The HTTP service binds to `127.0.0.1:8787` by default. Configure `BANK_INGESTION_BIND_HOST` and `BANK_INGESTION_PORT` only for a reviewed deployment; the Node service does not terminate TLS.

## HTTP Contract

`POST /api/v1/bank/events` requires `Content-Type: application/json` and `Authorization: Bearer bg1...`. The authenticated credential determines the allowed `sourceKey`; a mismatching body is rejected with `403 SOURCE_MISMATCH` and is never ingested.

| Response | Meaning |
| --- | --- |
| `201 created` | New immutable observation and normalized bank transaction |
| `200 duplicate` | Safe replay of the same source event and payload |
| `409 SOURCE_EVENT_CONFLICT` | Same source event id with different payload |
| `400 INVALID_EVENT` | Malformed event |
| `401 AUTHENTICATION_FAILED` | Missing, malformed, invalid, disabled or revoked credential |
| `403 SOURCE_MISMATCH` | Body source does not belong to the credential |
| `413 BODY_TOO_LARGE` | Body exceeds 32 KiB |
| `405 METHOD_NOT_ALLOWED` | Wrong method |
| `415 UNSUPPORTED_MEDIA_TYPE` | Wrong content type |
| `500 INTERNAL_ERROR` | Unexpected infrastructure failure; no internals are returned |

## Android Storage

The token is entered once in the Android collector UI. It is encrypted with an AES-GCM key held in Android Keystore and stored as an encrypted blob in private SharedPreferences. The UI displays only whether a credential is configured. The Authorization header is created at delivery time and is never logged.

`401 AUTHENTICATION_FAILED` and `403 SOURCE_MISMATCH` preserve captured evidence as `PENDING` and record a local configuration/auth problem. They do not become permanent event rejection and do not delete the outbox row. Timeouts, disconnects and 5xx responses retry the same deterministic `sourceEventId`. A lost response therefore converges through the server's `duplicate` response.

## Threat Model

- A stolen bearer token is scoped to one enabled bank source and can be revoked without changing other devices.
- A database leak does not reveal the high-entropy bearer secret because only its hash is stored.
- A source impersonation attempt fails closed because the server ignores the claimed source identity for authorization and checks it against the credential binding.
- Replay of one exact event is safe and idempotent; conflicting replay is rejected without a second observation.
- Raw notification text and Authorization headers are excluded from application logs.
- Production exposure, reverse proxy TLS and real device provisioning are separate reviewed operations and are not part of this change.

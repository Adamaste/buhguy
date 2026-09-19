# Bank Source Provisioning

Provisioning is an administrative, DML-only operation against the schema prepared by migrations. It is not part of the long-running ingestion service and does not run migrations or require DDL privileges.

## Operator sequence

1. Create a source: `receipt-collector bank-source create --source-key android-phone-1 --display-name "Android phone" --source-type ANDROID_NOTIFICATION`
2. Optionally link it to a person: `receipt-collector bank-source link-person --source-key android-phone-1 --person-key <person-key>`
3. Create the separate device credential: `receipt-collector bank-device create --source-key android-phone-1 --display-name "Android phone"`
4. Configure the Android collector with the one-time token.
5. Enable Android notification access.
6. Enable the source explicitly when it is ready: `receipt-collector bank-source enable --source-key android-phone-1`.

## Commands

- `bank-source create` accepts `ANDROID_NOTIFICATION` by default, or `BANK_API` / `MANUAL_IMPORT` explicitly. A repeated `source_key` returns `SOURCE_ALREADY_EXISTS` and never changes the existing row.
- `bank-source list` returns operational metadata and optional person mappings only. It never returns credential hashes, tokens, raw payloads, account references, or secrets.
- `bank-source enable` and `bank-source disable` change only `enabled` and `updated_at`. Both are idempotent; an unknown key returns `SOURCE_NOT_FOUND`.
- `bank-source link-person` resolves an existing `person_key` in the accounting scope and defaults to relation `OWNER`. Repeating the same link is idempotent; missing entities return `SOURCE_NOT_FOUND` or `PERSON_NOT_FOUND`.

The `bank_source_person` relation is context only. `OWNER` is not proof of the payer, beneficiary, purchase ownership, or receipt matching for any transaction.

Source creation and credential generation are intentionally separate security boundaries. Credential provisioning remains `bank-device create/list/revoke`.

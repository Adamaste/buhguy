# Provider Balance Observations

`bank_balance_observations` stores immutable provider-reported balance evidence separately from `bank_transactions`. The first slice accepts only the exact Sber v4 Android notification envelopes already proven for transaction normalization, and stores `PROVIDER_REPORTED_BALANCE` in RUB with the Android envelope event time.

This is an observed provider balance, not a calculated current balance, an accounting-certified balance, or proof of account ownership. Transaction amount and direction semantics remain unchanged. Ingestion writes the observation, transaction, identity-resolution rows, and balance evidence in one transaction; duplicate delivery is idempotent and source-event conflicts remain fail-closed.

ChatGPT access is limited to the safe `chatgpt_accounting.bank_balance_observations` view, which exposes structural balance evidence and current explicit account-resolution state without raw payload or source identifiers.

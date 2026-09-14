# FNS Auth Session

## State model

The collector treats the FNS session as one bound identity, not as a token pair. The protected `session.json` contains the access token, refresh token, expiry timestamps, a stable `deviceId`, the persisted FNS `deviceInfo`, and the browser `userAgent` used for the login. Tokens are never printed by the CLI or logger.

`deviceInfo` is sent together with the refresh token to `POST /api/v1/auth/token`. A token-only import is rejected because FNS can return `422 refresh.token.device.change.error.code` when the device-bound metadata is absent or inconsistent. The importer therefore fails closed instead of creating a session that cannot refresh.

## Refresh flow

When the access token is expired, or a protected request returns an authentication failure, the client sends the persisted refresh token and device metadata. Refresh responses replace the access token, refresh token when rotated, and expiry values in one session-state save. The state file is written to a unique temporary file with mode `0600`, then renamed into place; this prevents a crash from leaving a partially written JSON document.

The `auth status` command reports only non-secret state presence and expiry metadata. `auth refresh-test` performs a refresh without ingesting receipts or changing the accounting graph and returns a non-zero exit code on failure.

## Initial login and re-authentication

Initial login must use the official FNS browser flow when CAPTCHA or SMS is required. After login, import is allowed only when the browser exposes both tokens and compatible device metadata. Do not copy tokens manually or bypass CAPTCHA/device binding. Keep the browser profile available until a browserless refresh has been proven.

## Recovery

Before replacing a production session, create a protected backup outside git. If refresh returns a device-binding error, preserve the existing state and use one controlled official re-authentication on the VPS. Do not clear tokens blindly: a failed refresh must be observable and must not be reported as an empty successful sync.

## Observability and steady state

Authentication and refresh failures are non-zero process failures. The sync service reports `authError` and systemd marks the unit failed. Journals contain status and safe error codes only; tokens, cookies, authorization headers, passwords, and session contents are excluded.

The current known production limitation is FNS device binding of the previously imported session. A browserless steady state is accepted only after refresh succeeds with Chromium stopped, after process restart, and after service restart, followed by a successful list/sync.

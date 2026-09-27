# BUHGUY Current Handoff

This document is the operational starting point for a new ChatGPT/Codex session.

## Session rule

Do not repeat closed stages. Read this document first, then verify the current GitHub `master`, relevant PRs, CI, and detailed docs. If this document disagrees with GitHub about code, merge status, or artifacts, GitHub wins.

- Last updated: 2026-09-27
- Current master: `77be9493d78076247f590935fd02865e7f175da3`
- Current phase: Android bank-notification real-device diagnostics
- Current blocker: a real T-Bank -> Yandex Bank transfer produced user-visible bank activity, but no collector callback was observed for either expected bank package
- Next action: read-only Android NotificationManager/package/delegation forensics on the already completed `real2` test; do **not** perform another transfer yet

## Read next when needed

Detailed architecture and operating contracts already live in:

- `README.md`
- `docs/OPERATIONS.md`
- `docs/android-bank-notification-collector.md`
- `docs/bank-device-auth.md`
- `docs/bank-ingestion-data-contract.md`
- `docs/bank-source-provisioning.md`

Relevant implementation history is in PRs #14 through #21. Do not duplicate those documents here unless the operational state depends on a result that is not obvious from code.

## Project invariants

The project combines independent financial evidence sources into a verifiable accounting model.

Key semantic rules:

- bank transaction != purchase
- receipt != cash flow
- source/person ownership is context, not proof of payer or beneficiary
- raw evidence and normalized projections remain separate
- reconciliation must preserve evidence, provenance, reason, and uncertainty
- unknown/partial is preferable to guessing

The existing receipt/FNS pipeline and the newer bank cash-flow pipeline are intentionally separate evidence paths that may later be reconciled.

## Bank ingestion backend: proven

The production bank-ingestion path is already implemented and has passed synthetic E2E.

Proven behavior:

- first valid event -> HTTP 201 `created`
- exact replay -> HTTP 200 `duplicate`
- same source event id with changed payload -> HTTP 409 `SOURCE_EVENT_CONFLICT`
- conflict creates no extra observation/transaction
- authenticated source binding works
- observation creation works
- normalized bank transaction creation works
- duplicate handling is idempotent

Do not restart backend design work merely because the current Android callback test fails.

## Production privilege history

Runtime DB role: `receipt_collector`.

It is intentionally least-privilege.

Previously fixed issues included narrowly scoped access for runtime authentication/ingestion, including `UPDATE(last_used_at)` on device credentials and `SELECT(id)` where required by `RETURNING`.

PR #17 removed an unnecessary observation row lock so ingestion works under the restricted runtime role without granting broad table access.

Important boundary:

- runtime ingestion must **not** receive provisioning privileges such as `INSERT` on `bank_device_credentials`
- device credential provisioning is an administrative operation
- when a replacement credential was needed, it was provisioned one-shot through PostgreSQL peer auth as `postgres`, without changing runtime grants

Do not broaden production grants to solve application problems.

## Android device/source state

Expected physical device:

- model: Samsung SM-S938B
- ADB serial: `R5GL30GK60F`

Collector package:

- `com.adamaste.buhguy.bankcollector`

Bank source:

- `android-adam-samsung-s938b`
- source type: `ANDROID_NOTIFICATION`
- source is associated with the existing accounting person context

Server endpoint:

- `https://v3234257.hosted-by-vdsina.ru/api/v1/bank/events`

Configured allowlist:

- `ru.alfabank.mobile.android`
- `com.idamob.tinkoff.android`
- `ru.sberbankmobile`
- `com.yandex.bank`
- `ru.vtb24.mobilebanking.android`
- `ru.ozon.fintech.finance`

There may be a second ADB endpoint shown as `offline`. Use the explicit physical target when running ADB commands:

`adb -s R5GL30GK60F ...`

## Device credential state

A replacement device credential was created during the signing migration and is active for source `android-adam-samsung-s938b`.

The old credential has intentionally not yet been revoked.

The replacement token was stored safely and entered into the Android UI without printing it. Do not log, print, recommit, or recreate it unless a new security event requires rotation.

The replacement credential has already been used successfully by a real bank delivery, so authentication is not the current blocker.

## Android signing: closed

The old installation originally used an ephemeral debug signing certificate, which prevented safe in-place updates from CI builds.

PRs #19 and #20 established permanent release signing for trusted `master` builds.

Stable certificate SHA-256:

`cb619643bbfb6b9235c85c560ba26967d2ca0f28db01fb6a7b9b3d6be484486a`

CI verifies the signed APK certificate before artifact upload.

The one-time controlled uninstall/reinstall migration has already been completed. Current and future application updates must normally use:

`adb install -r`

Do not propose another uninstall/reinstall merely because older debug-signing history exists.

## Android observability history

PR #18 introduced safe capture diagnostics around:

- `CAPTURED`
- `INSERTED`
- `DUPLICATE`
- Room insert error
- enqueue error

A diagnostic blind spot was then discovered: the original `BankCapture` entry happened only after preferences/allowlist/capture processing, so absence of `CAPTURED` did not prove absence of `onNotificationPosted()`.

PR #21 fixed that blind spot and is merged in current master.

Current observable chain includes:

- listener connected/disconnected
- callback entry
- filtered/not-allowed
- capture-null
- captured
- inserted/duplicate
- Room error
- enqueue error

Callback entry is recorded before preferences and allowlist evaluation.

Persistent UI diagnostics include last callback and listener lifecycle in addition to last capture, pending events, and last successful delivery.

A follow-up review restored separate enqueue error diagnostics and their regression test before PR #21 was merged.

## Stable PR #21 build installed

PR #21 merge SHA:

`77be9493d78076247f590935fd02865e7f175da3`

Master CI run:

`36324042145`

Signed artifact:

- name: `buhguy-bank-collector-signed`
- artifact id: `10933711781`
- APK SHA-256: `e3ba6dcd7a6152f1ccc9122cec782549b14f40d79ab15087968348edf67982b0`
- certificate matches the stable certificate above

This APK was already installed **in place** with `adb install -r`.

Post-update checks passed:

- config preserved
- source key preserved
- server URL preserved
- allowlist preserved
- credential preserved
- pending = 0
- notification access enabled
- listener connected
- no uninstall
- no app-data clear

## Synthetic callback test: passed

A harmless synthetic notification was posted from `com.android.shell`.

Observed:

- `CALLBACK_ENTRY_FOUND=YES`
- `FILTERED_NOT_ALLOWED_FOUND=YES`
- callback package matched
- Room unchanged
- pending remained 0
- no Android runtime crash

Conclusion: Android NotificationManager -> collector NotificationListenerService -> `onNotificationPosted()` -> allowlist filtering is proven to work in this installed build.

Do not repeat this test unless a later change invalidates that proof.

## Real bank proof: Alfa passed

A real Alfa Bank notification has already passed the complete Android delivery path.

Baseline immediately before the second Yandex/T-Bank real test included:

- pending = 0
- last capture = `INSERTED ru.alfabank.mobile.android ...`
- last successful delivery = 2026-09-27T13:48:18.119872Z
- listener lifecycle = connected
- backend observation count = 14, max id = 17
- backend transaction count = 14, max id = 15
- replacement credential `last_used_at` updated at the corresponding successful delivery

This proves the real-device collector, Room, WorkManager, HTTPS transport, authentication, and backend ingestion can work end-to-end. The current issue is narrower than “collector is broken”.

## Real2 test: current evidence

A controlled real transfer was performed:

- amount: 100 RUB
- source: T-Bank
- destination: Yandex Bank
- both bank apps are installed on the same Samsung device

Evidence log:

`C:\Users\Адам\Documents\Codex\bank-collector-real2-20260927-171721.log`

Result from the completed test:

### `com.yandex.bank`

- expected callback entry: **not found**
- no capture/insert evidence
- no Room change attributable to the transfer
- no backend observation/transaction attributable to the transfer

### `com.idamob.tinkoff.android`

- expected callback entry: **not found**
- no capture/insert evidence
- no Room/backend change attributable to the transfer

### Other observations

- pending remained 0
- replacement credential `last_used_at` did not advance for this test
- no Android runtime crash was found
- only `ru.yandex.taximeter` was observed in the relevant listener log and it was correctly `filtered_not_allowed`
- synthetic callback path had already passed
- a real Alfa notification had already passed the full path

Therefore the strongest current boundary is **before the collector’s bank-specific capture logic** for this real2 event. There is currently no evidence that either expected bank package reached `onNotificationPosted()`.

## Samsung Freecess / MARs

Historical diagnostics showed Samsung Freecess/MARs freezing and unfreezing the collector and some Yandex-related background freeze messages.

However, Freecess is **not** a proven root cause.

Do not state that Samsung Freecess caused the missed bank callback unless new evidence directly supports that conclusion.

## Immediate next action

Do **not** perform another transfer yet.

Preserve the current test evidence and perform read-only Android NotificationManager/package/delegation forensics around the already completed real2 event.

The purpose is to determine whether the user-visible banking notifications were represented by Android under:

- `com.yandex.bank`
- `com.idamob.tinkoff.android`
- another package/delegate
- another Android user/profile
- or no retained system notification record

Investigate, without changing settings:

- NotificationManager current/history metadata where available
- actual posting package identity
- notification delegate information
- app notification permission/AppOps state
- channels and block state
- Android user/profile identity
- listener binding state
- relevant Samsung notification/freezer metadata
- timestamp correlation with the existing real2 log

Do not expose notification text or credentials in reports.

### Do not do before the forensic snapshot is complete

- no second bank transfer
- no `adb logcat -c`
- no phone reboot
- no force-stop/restart of collector
- no Notification Access toggle/rebind
- no app reinstall
- no credential rotation
- no backend/DB mutation
- no DB grant changes

## How to interpret the next evidence

If Android shows the notification was posted under a different package or delegate, fix package identity/allowlist assumptions.

If Android shows the expected bank package posted a notification but no listener dispatch occurred, investigate Android/Samsung dispatch/lifecycle behavior.

If a future bank callback reaches `CALLBACK_ENTRY` but stops at `FILTERED_NOT_ALLOWED`, investigate actual package identity.

If it reaches `CAPTURE_NULL`, investigate capture conversion.

If it reaches `CAPTURED` but not Room insert, investigate Room/duplicate/error.

If it reaches `INSERTED` but not backend, investigate WorkManager/network/auth; note that this path has already succeeded for Alfa.

## What comes after the current blocker

Once reliable capture/delivery is established for supported banks, the next functional milestone is bank-specific parsing and normalization.

The collector is intentionally RAW_ONLY-oriented today. Future parsers should extract only evidence actually present, such as:

- debit/credit direction
- amount
- currency
- event time
- counterparty/merchant when supported
- controlled account/card reference when supported
- transfer/payment/refund/fee classification when supported

Unknown or partial evidence must remain `UNKNOWN`/`PARTIAL`; do not guess.

Reconciliation with receipts/purchases belongs to a later separate evidence layer.

## Maintenance rule for this file

After a significant completed stage, update this document in a reviewed PR so the next chat begins at the new operational point.

Never commit:

- bearer/device tokens
- DB passwords
- signing private material/passwords
- private keys
- raw sensitive notification payloads
- secret hashes unless a reviewed security design explicitly requires them

# BUHGUY Current Handoff

This document is the operational starting point for a new ChatGPT/Codex session.

## Session bootstrap rule

This file is the authoritative operational handoff for a new ChatGPT/Codex session. A new session must not ask the user to reconstruct project history that is available here or in GitHub.

At the start of any technical work on `Adamaste/buhguy`:

1. read this file completely;
2. read `docs/BUHGUY-ROADMAP.md`;
3. verify the current GitHub `master`;
4. inspect only the relevant detailed docs/code/PR/CI needed for the active task;
5. continue from the explicit current blocker/next action below rather than restarting diagnostics.

Do not repeat closed stages. If this document disagrees with GitHub about code, merge status, CI, or artifacts, GitHub wins. After a meaningful completed stage, update this handoff in a reviewed PR before moving on.

- Last updated: 2026-09-27
- Current master: `77be9493d78076247f590935fd02865e7f175da3`
- Current phase: Android bank-notification real-device diagnostics
- Current blocker: REAL2 strongly indicates that Yandex financial notifications are actually posted by `ru.yandex.taximeter` (Yandex Pro), not `com.yandex.bank`; the collector received that package and rejected it as `FILTERED_NOT_ALLOWED`
- Current Yandex evidence: REAL2 callback `ru.yandex.taximeter`, notification id `52091223`, callback time 17:28:11; a saved live NotificationManager record has the same package/id on `notification_channel_1`; six active `ru.yandex.taximeter` records were on that channel while the visible Yandex Pro shade showed six financial cards
- Current uncertainty: `notification_channel_1` is used by all six currently observed financial Yandex Pro cards, but static analysis of the Flutter/AOT `ru.yandex.taximeter` APK could not prove that the channel is finance-exclusive; channel-only filtering is therefore not safe yet
- Next action: inspect privacy-safe per-notification metadata for the six known financial `ru.yandex.taximeter` records (tag/group/category/intent/other stable metadata) to find a provider-specific discriminator; only if a reliable discriminator exists should the collector be changed

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

## Real2 test and completed post-test forensics

A controlled real transfer was performed:

- amount: 100 RUB
- source: T-Bank
- destination: Yandex Bank
- both bank apps are installed on the same Samsung device

Evidence log:

`C:\\Users\\Адам\\Documents\\Codex\\bank-collector-real2-20260927-171721.log`

Preserved evidence metadata:

- log size: 5475 bytes
- SHA-256: `37692bc4639520fe3f7f1952bec54fb98ee400a1642c65e4775c57de81f48392`

### Collector/backend result

For both `com.yandex.bank` and `com.idamob.tinkoff.android` during REAL2:

- `CALLBACK_ENTRY`: not found
- capture/insert: not observed
- Room: unchanged
- backend observations: unchanged
- backend transactions: unchanged
- replacement credential `last_used_at`: unchanged
- pending remained 0
- no Android runtime crash was found

Only `ru.yandex.taximeter` was seen in the relevant collector log and was correctly filtered as `not_allowed`.

This placed the REAL2 failure before the collector's bank-specific capture logic.

### T-Bank: concrete system policy blocker found

Package:

- `com.idamob.tinkoff.android`
- Android user: 0
- version observed during forensics: 8.3.0 / 13196

Read-only Android policy inspection found:

- `POST_NOTIFICATIONS=DENIED`
- notification AppOps: `POST_NOTIFICATION=IGNORE`

This is a concrete explanation for why T-Bank produced no NotificationManager record and no collector callback in REAL2.

Treat the T-Bank branch of this test as **policy-blocked**, not as evidence of a collector failure.

Do not continue T-Bank callback debugging unless notification policy is intentionally changed in a separately reviewed/user-approved step and a later test is needed.

### Yandex Bank: Android notification policy looks healthy, post still not proven

Package:

- `com.yandex.bank`
- Android user: 0
- version: 0.241.2 / 11917
- stopped: false
- suspended: false

Read-only policy evidence:

- `POST_NOTIFICATIONS=GRANTED`
- AppOps: default/allow
- app importance: default
- app user-set importance: false
- no package/channel group block was found
- no profile/user boundary was found
- no notification delegation evidence was found
- collector listener remained enabled/live under user 0

Observed Yandex channels included:

- `appmetrica_push`: importance 2, not deleted
- `notification_channel_1`: importance 5, not deleted
- `notification_channel_2`: importance 5, not deleted
- security/sign-in channels: importance 4, not deleted

Push-related components are present, including Firebase Messaging and AppMetrica push components/receivers.

However:

- no Yandex NotificationManager record for the REAL2 event was found
- no current Yandex notification key was found
- no Yandex collector callback was found
- system notification post evidence for the REAL2 event remains absent

Therefore:

- collector callback/capture/Room/backend are not the current Yandex investigation boundary
- Android permission/AppOps/channel policy is not showing a blocker
- the unresolved interval is now specifically:
  remote push delivery -> Firebase/AppMetrica/Yandex push handling -> Yandex application decision/suppression -> Android NotificationManager publication

Do not claim that the Yandex push definitely arrived at the app. That runtime fact has not been proven.

## Latest Yandex Pro live-notification finding

A later live NotificationManager capture materially changed the Yandex diagnosis.

While the notification shade visibly contained six Yandex Pro financial cards (purchases/incoming transfers), a read-only active notification capture found exactly six active records for:

- package: `ru.yandex.taximeter`
- Android user: 0
- channel: `notification_channel_1`
- importance: 4

Active ids included `52091223`.

The preserved REAL2 collector log contains:

- callback package: `ru.yandex.taximeter`
- notification id: `52091223`
- callback wall-clock time: 17:28:11
- result: `FILTERED_NOT_ALLOWED`

The visible shade also contained an incoming-transfer card timestamped 17:28.

The saved live `dumpsys notification` record does not expose `postTime`, so the previously defined strict package+id+postTime join cannot be completed from preserved metadata. For that reason, the formal forensic label remains a strong/partial causal match rather than a mathematically exact two-field join.

Operational interpretation:

- the old assumption that REAL2 should appear as `com.yandex.bank` is no longer the leading hypothesis
- there is strong evidence that the relevant Yandex financial notifications are posted by `ru.yandex.taximeter` / Yandex Pro
- current collector filtering is package-only
- `ru.yandex.taximeter` is not in the configured allowlist
- the callback is therefore rejected before capture/Room/backend
- all six currently observed `ru.yandex.taximeter` active records used `notification_channel_1`
- however, historical exclusivity of that channel to financial notifications is not yet proven

Do not simply add all of `ru.yandex.taximeter` to the allowlist. First establish whether `notification_channel_1` is sufficiently finance-specific. If it is, prefer a backward-compatible package+optional-channel rule while preserving existing package-only behavior for normal bank apps.

The earlier static-analysis branch for `com.yandex.bank` is suspended unless later evidence makes it relevant again.


### Yandex Pro channel-isolation follow-up

Read-only APK analysis of the installed Yandex Pro package used the complete local APK set:

- `base.apk` SHA-256 `d75f5191e1ba887441fb65f084f3090414b344171dbbdb3d1d3186ff2da19278`
- `split_config.arm64_v8a.apk` SHA-256 `f4f8332c43704c355bee19941b1faea7fc651859ce96c7045ecfd57157ae8331`
- `split_config.xxhdpi.apk` SHA-256 `3ab753390bdc0bfa8c02713226bf03ee9e7ba9e74f05f788da8a2ac5d970724d`

Result:

- all six currently visible/active Yandex Pro financial cards used `notification_channel_1`
- no non-financial use of the channel was observed in the captured current set
- historical channel usage was unavailable
- exact static xrefs for `notification_channel_1` were not recovered
- the app uses Flutter/AOT code in `libapp.so`; generic notification-channel APIs were visible but did not prove module exclusivity
- therefore `FINANCIAL_CHANNEL_ISOLATION=NOT_PROVEN`

Do not implement a channel-only allow rule yet. The next useful evidence is a privacy-safe discriminator available on the `StatusBarNotification`/Notification metadata of the six known financial records (for example tag shape/prefix, group, category, creator/intent identity, or another stable non-content field). If no reliable metadata discriminator exists, a deliberately scoped provider-specific content classifier with regression fixtures may be required, but do not introduce brittle regex heuristics without evidence.

## Samsung Freecess / MARs

Historical diagnostics showed Samsung Freecess/MARs freezing and unfreezing the collector and some Yandex-related background freeze messages.

However, Freecess is **not** a proven root cause.

Do not state that Samsung Freecess caused the missed bank callback unless new evidence directly supports that conclusion.

## Immediate next action

Do **not** perform another bank transfer yet.

The next stage is read-only static forensics of the installed Yandex Bank application (`com.yandex.bank`) to reconstruct the narrow push-to-notification path.

Use the already installed APK/split APK set and inspect only notification-related metadata/code. The target questions are:

1. Which Firebase/AppMetrica/Yandex components receive push messages?
2. What are the actual push entrypoints and call chains?
3. Where does Yandex create Android notifications (`NotificationManager.notify`, `NotificationManagerCompat.notify`, wrappers, or equivalent)?
4. Which channel IDs are selected for which paths?
5. Which explicit conditions can suppress notification creation after a push has been received?
6. Are there silent/data-only, foreground, duplicate, TTL/freshness, feature-flag, or payload-dependent branches?
7. Does any path use notification delegation or an alternate posting package?
8. Are there safe log tags/stages that can be captured in a future runtime test without exposing financial content?

Keep the static analysis narrowly scoped to push -> notification behavior. Do not inspect banking protocols, authentication, transaction signing, private keys, TLS pinning, account data, or unrelated application internals.

Important interpretation rule:

- finding a static suppression branch proves that the branch exists;
- it does **not** prove REAL2 used that branch;
- the REAL2 root cause remains unproven until runtime evidence connects the event to one path.

### Do not do before this static forensic stage is complete

- no second bank transfer
- no new financial operation
- no `adb logcat -c`
- no phone reboot
- no force-stop/restart of collector
- no Notification Access toggle/rebind
- no app reinstall/update
- no permission/AppOps/channel mutation
- no credential rotation
- no backend/DB mutation
- no DB grant changes
- no APK patching/runtime hooks/instrumentation

## How to interpret the next evidence

For Yandex static APK forensics:

- if explicit received-push -> no-notification branches exist, record them as candidate suppression paths, not as the REAL2 root cause
- if the relevant push path can be shown to always publish a notification, identify what runtime evidence would be required to distinguish push non-delivery from an unexpected alternate path
- if notification delegation/alternate posting identity exists, document the exact mechanism without changing the collector allowlist yet
- if static analysis is inconclusive, state exactly which code boundary is opaque/obfuscated and design the smallest safe runtime observation needed next

For future collector evidence, the already established stage interpretation remains:

- `CALLBACK_ENTRY -> FILTERED_NOT_ALLOWED`: actual package identity/allowlist issue
- `CALLBACK_ENTRY -> CAPTURE_NULL`: capture conversion issue
- `CAPTURED` without Room insert: Room/duplicate/error issue
- `INSERTED` without backend: WorkManager/network/auth issue; this path has already succeeded for Alfa

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

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

- Last updated: 2026-09-29
- Current master: `0d84fff53d424b7878c215ec5bc5be0e070054a3`
- Current phase: Sber account identity/reference provisioning is complete for the explicitly confirmed first user; historical resolution remains a separate reviewed step
- Current blocker: historical Sber transactions still lack persisted reference fields and remain `UNKNOWN`; reviewed historical evidence resolution is required before any `INTERNAL_TRANSFER` reconciliation
- Current Yandex evidence: master-signed APK is installed; observation 18 / transaction 16 has provider `com.yandex.bank`; its full source event id exactly matches a current `ru.yandex.taximeter` record on `notification_channel_1` when using the stored event-time millisecond as postTime; credential use and backend creation are corroborated
- Current observability anomaly: fresh UI diagnostics still show the previous Alfa capture and delivery values; no raw notification content was retained, and the cause of this stale persistent state is not yet proven
- Current evidence: exact controlled Sber observations 72, 75, and 79 pass the deployed parser in memory; related summary observations 74, 76, and 80 remain fail-closed. No historical backfill was performed
- Current Yandex status: normalizer v1 is deployed and unchanged
- Next action: review explicit historical Sber resolution for observations 72/75/79, without backfilling transaction evidence. Do not infer ownership from a bank source or device. UI is not the current target

## Sber normalization v1 production validation

PR #28 and the corrective evidence-contract fix are merged in master commit
`019b89102ca91d91cd9f6b2db1647e74cc7bad95`. The corrective runtime was
promoted from an immutable LF-normalized 39-file closure with artifact SHA-256
`9c8d81c5f55d9c068133265efc6cf70cdf07345af22062f1a15727ec7fe843d1`.

Deployment validation completed for:

- exact staged and installed manifest hashes;
- `/healthz` HTTP 200 with `{"status":"ok"}`;
- JavaScript syntax, module imports, and CLI smoke;
- schema unchanged with migration `012_bank_transaction_event_type.sql` already current;
- timer restored to `enabled/active` and sync service left inactive after deployment;
- no migration execution, backfill, phone use, credential mutation, grant change, or new bank operation.

The deployed and validated Sber envelope is intentionally narrow:

- provider `ru.sberbankmobile`;
- adapter `android-notification`;
- schemaVersion `1`;
- exact proven incoming-transfer title forms only;
- first integer-ruble transaction amount token;
- a separate balance monetary field is ignored;
- event time from Android notification `postTime`.

Read-only in-memory validation against exact controlled production observations
completed successfully without exposing payload text or changing the database.
Observations `72`, `75`, and `79` each returned `INCOMING_TRANSFER`, `CREDIT`,
RUB, amount present, `READY`, and `sber-bank-normalizer-v1`. The event time was
derived from the stored Android notification event time. Related summary
observations `74`, `76`, and `80` remained `PARTIAL`/`UNKNOWN` and were not
promoted to `READY`.

This closes the Sber parser research gate for the proven v1 format. No
historical observation was updated, re-ingested, or backfilled.

Yandex normalizer v1 remains deployed and its regression suite remains passing.
T-Bank and Ozon parser coverage remain future incremental work; Alfa and VTB
remain deferred. The next phase is `USABLE_MVP`, focused on a daily-use view
of receipts, bank transactions, and explicit READY/PARTIAL/UNKNOWN evidence
states rather than another provider parser.

## Yandex normalization v1 production deployment

The merged Yandex normalization release was promoted from master commit
`bdf924f1d8a47ea9e5d204a3f1c25b7873e93801` using an immutable LF-normalized
artifact. The deployed artifact SHA-256 was
`03b1b5dd8578543a646c82c1b82dba97afc39ae72dffeab33911e1e5b8cb8469`.

Production validation completed successfully:

- runtime manifest hashes matched the staged artifact after promotion;
- migration `012_bank_transaction_event_type.sql` was applied through the
  existing migration implementation;
- `bank_transactions.event_type` is present and existing transaction 16 is
  `UNKNOWN`; no historical normalization backfill was performed;
- observation 18 metadata and payload fingerprint remained unchanged;
- observation and transaction counts remained 16 and 16;
- an in-memory dry-run of observation 18 returned
  `INCOMING_TRANSFER`, `CREDIT`, `RUB`, `READY`, using
  `yandex-bank-normalizer-v1`;
- `/healthz` returned HTTP 200;
- runtime privileges remained least-privilege, including table-wide
  `SELECT` denied on `bank_transactions` and column-level `SELECT(id)`
  retained for `RETURNING`;
- the FNS timer was restored as `enabled/active` after validation. No manual
  sync or new bank operation was performed during this deployment.

The deployment did not change phone state, Android configuration, device
credentials, Datadog configuration, or database grants. Observation 18 was
not backfilled; the dry-run only validated parser behavior in memory.

PR #24 is merged. T-Bank remains policy-blocked by its notification permission
state; this deployment did not change that device policy. The next functional
stage is bank coverage and provider parsers for Alfa, Sber, VTB, Ozon, and
T-Bank, with each parser kept fail-closed and evidence-preserving.

## Bank account resolution foundation production deployment

PR #32 is merged in master commit `e8940ff67ceefa1127729e0325abe5df65e68fb8`.
The immutable production artifact was built from that exact commit with
archive SHA-256
`0c68e31430a8b488e98d8cd7d663498225c09f2e912b745294b05dbd00d24e4d`.

Production validation confirmed:

- migration `013_bank_account_resolution_foundation.sql` is applied;
- `/healthz` returned HTTP 200 and `finance-bank-ingestion.service` is active;
- `bank_transactions` remained 79 before and after deployment;
- `bank_event_observations` remained 79 before and after deployment;
- no historical source evidence or resolution rows were changed and no
  backfill was performed;
- the 79 unresolved transactions remain explicit `UNKNOWN`, with coverage
  invariant PASS;
- the runtime role has only `INSERT` on
  `bank_transaction_account_resolution`; `SELECT`, `UPDATE`, and `DELETE`
  remain denied;
- no phone use, new bank operation, ledger posting, internal-transfer
  matching, or UI work was performed.

The semantic boundary is unchanged: source/device `OWNER` context never
establishes financial-account ownership. `EXACT` requires proven
provider/reference evidence and fails closed for zero or multiple candidates.
New bank transactions default atomically to `UNKNOWN`.

The intended next chain is:

```text
bank transaction
-> financial account resolution
-> internal-transfer reconciliation
-> business event
-> ledger Dr/Cr
-> ChatGPT semantic access
```

Operational note: `scripts/migrate-prod-only.mjs` had a path defect discovered
during migration 013 deployment. PR #34 corrected the wrapper to resolve the
repository migrations directory independently of caller cwd; migration 014
was subsequently applied through that corrected wrapper using administrative
PostgreSQL peer access.

## Bank account resolution operationalization

PR #34 is merged in master commit
`d4b6f1337fcd450569868127d7b144eb7d14e7c3`. Its immutable LF-normalized
production artifact has archive SHA-256
`0b8a103d9ad988be4ce4abd1f10b49ee1edf28934afb89d3a5a15e640d0dd7e6` and is
deployed at `/opt/accountant/releases/d4b6f1337fcd450569868127d7b144eb7d14e7c3`.

Production validation completed successfully:

- migration `014_bank_transaction_account_reference_kind.sql` was applied
  through the corrected `scripts/migrate-prod-only.mjs` wrapper using the
  administrative peer path;
- the wrapper was validated from a non-repository caller context and the
  staged/installed manifest hashes matched the exact master artifact;
- `finance-bank-ingestion.service` is active and `/healthz` returns HTTP 200;
- the FNS timer was restored to `enabled/active`, with no manual sync run;
- `bank_transactions` and `bank_event_observations` remained at 81/81;
- all 81 historical `account_reference_kind` values remain NULL; no historical
  reference projection or backfill was performed;
- runtime grants were not broadened and remain limited to `INSERT` on
  `bank_transaction_account_resolution` for unresolved ingestion rows.

Migration 014 adds nullable `bank_transactions.account_reference_kind` with
controlled values `MASKED_ACCOUNT`, `MASKED_CARD`, and `OTHER`; historical rows
remain valid and no backfill is permitted. Sber's proven `Плат. счёт ••dddd`
structure is canonicalized as four digits plus `MASKED_ACCOUNT`; Yandex remains
without account-reference evidence.

The operator CLI must use an administrative/peer-access identity, never the
`receipt_collector` runtime role. `EXACT` remains restricted to provider,
reference kind, reference value, and unique accounting-scope evidence;
missing, zero, or multiple candidates fail closed. Manual resolution requires
an explicit reason and cannot assert `EXACT`.

Read-only deployed CLI smoke passed for `bank-account list` and
`bank-account coverage` before provisioning. The account inventory was empty
at precheck and coverage reported 81 unresolved `UNKNOWN` transactions.

In-memory validation of the stored controlled Sber observations 72/75/79
returned `INCOMING_TRANSFER`, `CREDIT`, RUB, `READY`,
`sber-bank-normalizer-v1`, and `MASKED_ACCOUNT` with the same safe masked
reference. Summary observations 74/76/80 remained fail-closed `PARTIAL`/
`UNKNOWN` without an invented reference. Yandex behavior remains unchanged.

The ownership barrier remains active for all unconfirmed accounts: source/device
`OWNER` context is capture and accounting context only, not financial-account
ownership proof. No payment instrument or manual resolution was created.

## Sber account provisioning

On 2026-09-29 the user explicitly confirmed that `person_id=1`,
`legacy-current-user`, is Adam in this accounting context and that Sber masked
account `••0271` belongs to Adam. This is manual user evidence, not an
inference from device or bank-source ownership.

One atomic administrative transaction provisioned:

- financial account `1`: Sber, provider `ru.sberbankmobile`, currency `RUB`,
  display `Sber ••0271`;
- one `OWNER` relation to person `1` with provenance `USER_CONFIRMED`;
- one account reference `ru.sberbankmobile / MASKED_ACCOUNT / 0271`.

No payment instrument was created because the evidence proves an account
reference, not a specific card. Historical bank transactions and immutable
observations were not updated, re-ingested, or backfilled. Coverage remains
81 total and 81 `UNKNOWN`; historical resolution rows remain unchanged.

The next step is reviewed historical resolution for controlled Sber
observations 72/75/79 using immutable observation evidence and explicit
provenance. `INTERNAL_TRANSFER` reconciliation remains out of scope until
both sides of an own-account transfer have proven account identity.

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


### Yandex Pro metadata-discriminator follow-up

Privacy-safe metadata analysis of the six known financial active records found the following common positive-set features:

- package/opPkg: `ru.yandex.taximeter`
- channel: `notification_channel_1`
- importance: 4
- flags: auto-cancel
- visibility: private
- small icon: resource `0x7f110000`
- common group pattern: `0|ru.yandex.taximeter|g:Aggregate_NormalNotificationSection`
- active records had no retained tag value, although the earlier REAL2 callback reported `hasTag=true`

No negative set of known non-financial Yandex Pro notifications was available. Static correlation inside Flutter/AOT code did not prove that channel/icon/group metadata belongs only to financial notifications.

Result:

- `METADATA_DISCRIMINATOR_DECISION=CANDIDATE_ONLY`
- metadata-only filtering is not sufficiently proven for production
- further generic reverse engineering is not justified by the available evidence
- the next design should use a narrow Yandex Pro transport match plus a provider-specific local financial classifier before persistence/backend delivery
- `FINANCIAL` may proceed to mapping/outbox
- `NON_FINANCIAL` and `UNKNOWN` must be dropped locally with safe diagnostics and no raw-content logging
- classifier behavior must be defined from sanitized regression fixtures before implementation


## Samsung Freecess / MARs

Historical diagnostics showed Samsung Freecess/MARs freezing and unfreezing the collector and some Yandex-related background freeze messages.

However, Freecess is **not** a proven root cause.

Do not state that Samsung Freecess caused the missed bank callback unless new evidence directly supports that conclusion.

## Immediate next action

The September 2026 multi-bank evidence campaign is complete for the currently
reviewed providers:

- T-Bank transport E2E is **PROVEN** after notification policy was enabled;
- Sber transport E2E is **PROVEN**;
- Ozon Finance transport E2E is **PROVEN**;
- Alfa transport is historically **PROVEN**, but current parser evidence is insufficient and is **DEFERRED**;
- VTB transport remains **NOT_PROVEN** because no current notification/callback was observed and is **DEFERRED**;
- Yandex normalizer v1 remains **DEPLOYED**.

The sanitized fixture research branch records structural clusters for T-Bank,
Sber, and Ozon. It deliberately does not register runtime parsers because no
cluster proves both event type and direction together with amount, currency, and
event time. Raw notification text, real amounts, names, recipients, account/card
identifiers, and source-event identifiers must remain out of Git.

PR #26 was closed without merge with reason
`ALFA_DETERMINISTIC_FORMAT_NOT_PROVEN`. Its runtime Alfa dispatch must not enter
master until a deterministic format is proven and generic structured normalization
regression coverage is preserved.

The active next step is provider-specific parser implementation only for a future
provider with deterministic sanitized fixtures. Do not start reconciliation,
accounting, or new phone operations in that parser step.

The Yandex real-device transport milestone is closed with an observability gap:

- `ru.yandex.taximeter` -> `notification_channel_1` -> provider-specific financial classifier -> authenticated backend is proven by exact source-event correlation;
- backend observation 18 and transaction 16 were created without manual backend mutation;
- Tinkoff remains separately policy-blocked by notification permission/AppOps;
- persistent `lastCapture` and `lastSuccessfulDelivery` did not reflect the Yandex event and should be investigated separately without another financial operation.

The next roadmap stage is bank-specific parsing and normalization. Keep raw evidence immutable, preserve `UNKNOWN`/`PARTIAL` when notification facts are insufficient, and do not start reconciliation or ledger integration in the same change.

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

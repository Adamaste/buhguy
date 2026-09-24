# Operations

## Production FNS sync

The production application is installed under `/opt/accountant/receipt-collector`.
The FNS sync is managed by:

- `receipt-collector-sync.service`
- `receipt-collector-sync.timer`

The validated timer uses monotonic, non-overlapping scheduling:

```ini
OnActiveSec=2min
OnUnitInactiveSec=15min
```

The first run is scheduled about two minutes after timer activation. Each later
run is scheduled after the previous oneshot service becomes inactive. There is
no `OnBootSec`, `OnUnitActiveSec`, or persistent catch-up behavior in this
configuration.

### Safe timer operations

Inspect state before changing it:

```text
systemctl is-enabled receipt-collector-sync.timer
systemctl is-active receipt-collector-sync.timer
systemctl is-active receipt-collector-sync.service
systemctl list-timers receipt-collector-sync.timer
```

Stop the timer before a controlled maintenance window:

```text
systemctl disable --now receipt-collector-sync.timer
```

Start it again only after validating the release and a controlled run:

```text
systemctl enable --now receipt-collector-sync.timer
```

Do not start a second sync while one is active. If a run fails, preserve its
journal and resource evidence first; do not immediately replay it blindly.
Use one explicitly controlled retry only after the failure cause and data state
are understood.

## Logging and monitoring

Application logs are JSON lines with `level`, `event`, and structured fields.
The Datadog Logs Agent collects the FNS unit from journald. The validated
monitors are:

- Node OOM: `124474452`
- Sync failure: `124474467`
- Stale successful catch-up: `124474505`

Do not put credentials, tokens, cookies, session data, passwords, or raw secret
configuration values in logs or operational documentation.

## Deployment safety

Production releases are immutable artifacts built from an exact Git commit.
Before promotion, verify the Git object identity, dependency closure, manifest,
archive checksum, syntax, module imports, CLI smoke checks, and archive
re-extraction. Promote the complete release atomically and verify installed
hashes afterward.

Runtime backups must be created before changing production files. Rollback is a
deliberate operation based on the backup and verified artifact, not an automatic
destructive cleanup. Do not run migrations, change database grants, or alter
secrets/session stores as part of an ordinary runtime release unless that is a
separately reviewed operation.

Runtime text artifacts use deterministic LF line endings. The release manifest
records the repository path, Git blob identity, installed-file SHA256, and line
ending policy.

## Bank ingestion status

The bank ingestion backend is a separate systemd service and is exposed through
the reviewed HTTPS reverse-proxy route. Bank sources and device credentials are
provisioned through the supported CLI/API flow; credentials must never be
printed to logs, committed, or included in reports.

The Android collector uses a Room outbox and WorkManager. Delivery is retried
for network/server failures, while authentication or source-binding problems
remain pending for operator action. Duplicate source events are acknowledged
without creating a second bank transaction; payload conflicts are rejected.

Bank-specific parser work is separate from the current raw-only collector
milestone. A bank notification with partial or unknown normalization is retained
as evidence and must not be silently promoted to a fully classified accounting
event.

## Android bank collector

The Android project is in `android/buhguy-bank-collector`. Use the committed
Gradle Wrapper so local and CI builds use the same Gradle version:

```text
cd android/buhguy-bank-collector
gradlew.bat test
gradlew.bat assembleDebug
```

The current AGP/Kotlin configuration requires Java 17 and an Android SDK with
the configured compile SDK. A wrapper version check can run without the SDK,
but project tests and APK assembly require both Java 17 and the SDK.

On Linux/macOS use `./gradlew test` and `./gradlew assembleDebug`. The debug APK
is produced at:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Before device testing, verify that a device is visible and authorized:

```text
adb devices
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Enable notification access for the collector in Android Settings under
`Special app access` -> `Notification access`. The exact menu label can vary by
Android version. Do not store device credentials, tokens, or source credentials
in the repository, APK sources, shell history, or logs.

The operational path is:

```text
bank notification
-> NotificationListenerService
-> Room outbox
-> WorkManager delivery
-> HTTPS /api/v1/bank/events
-> authenticated bank observation
-> bank transaction
```

The first E2E test should use a provisioned source and device credential from
the supported provisioning flow. It must not create a financial operation just
for testing.

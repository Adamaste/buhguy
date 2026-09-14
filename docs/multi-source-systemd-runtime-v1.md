# Multi-Source Systemd Runtime V1

## Control flow

Before this change, the production oneshot invoked `receipt-collector.js sync`,
which built one client/session and one `legacy-default` source directly in the
CLI. `bin/scheduler.js` had a separate source loop, so `FNS_SOURCES_CONFIG`
was not honored by the systemd path.

The new flow is:

1. `receipt-collector.js sync` or `bin/scheduler.js` calls
   `runSourceSyncCycle`.
2. `resolveSyncSources` uses the single `loadFnsSourceConfig` parser.
3. Without configuration, it resolves exactly `legacy-default` and the
   existing session directory.
4. With configuration, it processes enabled entries sequentially, creating one
   `SessionStore` per `sessionDir` and one database source row per source key.
5. Each source calls the existing bounded `syncReceipts` path and updates its
   own `fns_source_sync_state`.
6. All enabled sources are attempted even after one fails.
7. The cycle returns exit code `0` only when every enabled source succeeds;
   any failed enabled source returns exit code `2`. Disabled sources are not
   attempted and do not fail the cycle.

The systemd unit remains `Type=oneshot` and still exits after one complete
cycle. The timer remains responsible for cadence. `bin/scheduler.js` retains
its long-running interval purpose but consumes the same source-cycle module.

## Security and compatibility

`FNS_SOURCES_CONFIG` contains only source/session references and display
metadata. Tokens and device state remain in each `SessionStore` directory.
Legacy mode uses the existing `legacy-default` key, so an existing source row
is reused rather than recreated. Source failures are logged with source id,
source key, counters and duration only.

No migration, grant, systemd unit, timer, accounting semantic, or production
configuration change is part of this implementation.

## Verification

The local suite covers legacy resolution, explicit one- and two-source
resolution, isolated session paths, disabled sources, failure isolation,
aggregate exit codes and source-state failure recording. PostgreSQL clone
verification remains a separate disposable-only operation; no production data
or credentials are used by the tests.

#!/usr/bin/env bash
set -euo pipefail
latest="$(ls -1t /var/backups/receipt-collector/postgres/*.dump.gz | sed -n '1p')"
stat -c 'FILE=%n MODE=%a OWNER=%U:%G SIZE=%s' "$latest"
mode="$(stat -c '%a' "$latest")"
owner="$(stat -c '%U:%G' "$latest")"
[[ "$mode" == "600" ]]
[[ "$owner" == "postgres:postgres" ]]
gzip -t "$latest"
gzip -cd "$latest" | pg_restore --list > /tmp/techdebt-predeploy-pg-restore-list
sha256sum "$latest"
echo "BACKUP=$latest"
echo "RESTORE_LIST_LINES=$(wc -l < /tmp/techdebt-predeploy-pg-restore-list)"

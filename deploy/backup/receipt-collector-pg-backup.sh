#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=/var/backups/receipt-collector/postgres
DATABASE_NAME=finance_receipt_collector
RETENTION_DAYS=7
install -d -m 0700 -o postgres -g postgres "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/finance_receipt_collector-$STAMP.dump.gz"
umask 077
pg_dump --format=custom --no-owner --no-privileges --host=/var/run/postgresql --username=postgres --dbname="$DATABASE_NAME" | gzip -9 > "$FILE"
find "$BACKUP_DIR" -type f -name '*.dump.gz' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -type f -name '*.dump.gz' -printf '%s %p\n' | sort -nr | tail -n +8 | cut -d' ' -f2- | xargs -r rm -f
echo "PostgreSQL backup completed: $(basename "$FILE")"

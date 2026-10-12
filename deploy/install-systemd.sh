#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/accountant/receipt-collector
CONF_DIR=/etc/finance-receipt-collector
RELEASE_ENTRYPOINT=/opt/accountant/releases/current/bin/receipt-collector.js
if [ ! -f "$RELEASE_ENTRYPOINT" ]; then
  echo 'A verified current runtime release must be selected before installing/enabling the sync unit.' >&2
  exit 2
fi
install -d -m 0750 -o root -g root "$CONF_DIR"
id receiptcollector >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin receiptcollector
install -d -m 0700 -o receiptcollector -g receiptcollector "$APP_DIR/.receipt-collector"
install -m 0644 deploy/systemd/receipt-collector-sync.service /etc/systemd/system/receipt-collector-sync.service
install -m 0644 deploy/systemd/receipt-collector-sync.timer /etc/systemd/system/receipt-collector-sync.timer
chmod 0750 deploy/backup/receipt-collector-pg-backup.sh
install -m 0644 deploy/systemd/receipt-collector-pg-backup.service /etc/systemd/system/receipt-collector-pg-backup.service
install -m 0644 deploy/systemd/receipt-collector-pg-backup.timer /etc/systemd/system/receipt-collector-pg-backup.timer
if [ ! -f "$CONF_DIR/receipt-collector.env" ]; then
  install -m 0600 -o root -g root .env.example "$CONF_DIR/receipt-collector.env"
  echo "Fill $CONF_DIR/receipt-collector.env with the real PostgreSQL DATABASE_URL before enabling the timer; place the FNS session in $APP_DIR/.receipt-collector/session.json" >&2
  exit 2
fi
systemctl daemon-reload
if [ "${ENABLE_TIMERS:-false}" = true ]; then
  systemctl enable --now receipt-collector-sync.timer
  systemctl enable --now receipt-collector-pg-backup.timer
fi

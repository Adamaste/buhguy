#!/usr/bin/env bash
set -euo pipefail

# Legacy Compose bootstrap. The supported production installation is the
# systemd unit set under deploy/systemd. This script must be reviewed before
# use and never points at a production database automatically.

APP_DIR="${1:?usage: bootstrap.sh /opt/finance-receipt-collector}"
REPO_URL="${2:?usage: bootstrap.sh /opt/finance-receipt-collector git@github.com:org/repo.git}"

command -v docker >/dev/null 2>&1 || { echo 'Docker is required for this legacy bootstrap; install it separately.' >&2; exit 2; }
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then git clone "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR"
test -f .env || { echo "Create $APP_DIR/.env before starting services" >&2; exit 1; }
docker compose up -d --build
docker compose ps

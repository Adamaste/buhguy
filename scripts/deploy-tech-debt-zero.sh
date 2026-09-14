#!/usr/bin/env bash
set -euo pipefail
expected='e3c271e3710e527fab84fd9292bb44851d93fb67cafdf865430795c7ab6a5d53'
staged='/tmp/ledger.js.techdebt-zero'
target='/opt/accountant/receipt-collector/src/ledger.js'
if systemctl is-active --quiet receipt-collector-sync.service; then
  echo 'sync service is active; refusing cutover' >&2
  exit 2
fi
actual="$(sha256sum "$staged" | awk '{print $1}')"
test "$actual" = "$expected"
cp -a "$target" /tmp/ledger.js.pre-techdebt-zero
cp "$staged" "$target.new"
chown root:root "$target.new"
chmod 0644 "$target.new"
mv -f "$target.new" "$target"
deployed="$(sha256sum "$target" | awk '{print $1}')"
test "$deployed" = "$expected"
echo "DEPLOYED_SHA=$deployed"

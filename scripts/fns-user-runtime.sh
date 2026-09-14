#!/bin/sh
set -eu

project=/opt/accountant/receipt-collector
env_file=/etc/finance-receipt-collector/receipt-collector.env

command=${1:-}
case "$command" in
  add|import-profile|status|retry|disable|enable) ;;
  *) echo 'FNS_USER_COMMAND_DENIED' >&2; exit 126 ;;
esac

case "$command" in
  add|import-profile|retry|disable|enable)
    [ "$#" -eq 2 ] || { echo 'FNS_USER_ARGUMENTS_INVALID' >&2; exit 2; } ;;
  status)
    [ "$#" -eq 1 ] || { echo 'FNS_USER_ARGUMENTS_INVALID' >&2; exit 2; } ;;
esac

[ -r "$env_file" ] || { echo 'FNS_USER_ENV_UNAVAILABLE' >&2; exit 1; }
set -a
. "$env_file"
set +a

display=${DISPLAY:-:10}
runuser -u fnslogin -- env DISPLAY="$display" XAUTHORITY=/home/fnslogin/.Xauthority \
  /usr/bin/xhost +SI:localuser:receiptcollector >/dev/null 2>&1 || true

cd "$project"
exec runuser -u receiptcollector -- env DISPLAY="$display" \
  XAUTHORITY=/home/fnslogin/.Xauthority \
  FNS_CONFIG_UPDATE_HELPER=1 \
  FNS_CONFIG_UPDATE_HELPER_PATH=/usr/local/sbin/receipt-config-update \
  /usr/bin/node "$project/bin/receipt-collector.js" fns-user "$@"

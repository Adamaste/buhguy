#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:99
export HOME=/var/lib/fnsbrowser
export XDG_RUNTIME_DIR=/run/user/995
mkdir -p "$HOME/profile"
LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"
CHROMIUM_BIN=/usr/bin/google-chrome

cleanup() {
  kill "${NOVNC_PID:-}" "${VNC_PID:-}" "${CHROME_PID:-}" "${OPENBOX_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp -ac & XVFB_PID=$!
openbox >/dev/null 2>&1 & OPENBOX_PID=$!
"$CHROMIUM_BIN" \
  --user-data-dir="$HOME/profile" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  https://lkdr.nalog.ru/login >"$LOG_DIR/chromium.log" 2>&1 & CHROME_PID=$!
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -forever -shared -nopw -input KM -noxdamage >"$LOG_DIR/vnc.log" 2>&1 & VNC_PID=$!
websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >"$LOG_DIR/novnc.log" 2>&1 & NOVNC_PID=$!

wait "$CHROME_PID"

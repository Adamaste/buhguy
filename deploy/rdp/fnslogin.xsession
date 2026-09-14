#!/bin/sh
export XDG_CONFIG_DIRS=/etc/xdg
export XDG_DATA_DIRS=/usr/local/share:/usr/share
export XDG_CONFIG_HOME=/home/fnslogin/.config
exec dbus-run-session -- sh -c "openbox-session >/tmp/openbox.log 2>&1 & sleep 2; exec /usr/bin/google-chrome --lang=en-US --disable-gpu --disable-dev-shm-usage --disable-background-networking --disable-sync --disable-extensions --disable-default-apps --disable-features=OptimizationGuideOnDeviceModel,Translate,MediaRouter --renderer-process-limit=3 --user-data-dir=/home/fnslogin/chrome-profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check https://lkdr.nalog.ru/login"

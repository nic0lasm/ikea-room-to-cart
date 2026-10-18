#!/bin/sh
# Chrome headless en arrière-plan pour maquette-vers-ikea.js (port CDP 9240 par défaut)
PORT=${PORT:-9240}
D=$(dirname "$0")
exec "${CHROME_PATH:-$(node "$(dirname "$0")/playwright.js")}" --headless=new --no-sandbox --remote-debugging-port=$PORT --user-data-dir=$D/profiles/$PORT ${HTTPS_PROXY:+--proxy-server=$HTTPS_PROXY} --window-size=1440,900 --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --lang=fr-FR --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --max-active-webgl-contexts=64 --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" about:blank

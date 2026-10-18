#!/bin/sh
# Chromium headless pour un usage manuel : ikea.js et maquette-vers-ikea.js lancent et arrêtent le leur (lib/chrome.js).
# Port CDP 9240 par défaut, profil dans le dossier temporaire. Arrêt : kill <pid>.
PORT=${PORT:-9240}
PROFILE=${IKEA_TMP:-${TMPDIR:-/tmp}/ikea-planner}/chrome-$PORT
mkdir -p "$PROFILE"
CHROME=${CHROME_PATH:-$(node "$(dirname "$0")/playwright.js")}
exec "$CHROME" --headless=new --no-sandbox --remote-debugging-port=$PORT --remote-debugging-address=127.0.0.1 --user-data-dir="$PROFILE" ${HTTPS_PROXY:+--proxy-server=$HTTPS_PROXY} --window-size=1440,900 --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --lang=fr-FR --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --max-active-webgl-contexts=64 --no-first-run --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" about:blank

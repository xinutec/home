#!/usr/bin/env bash
# Build the home web-viewer APK and install it to the Pixel 9 over Wi-Fi. Run from
# android/ inside the borrowed Android dev shell:
#
#   nix develop ~/Code/recall#android --command ./deploy.sh [<ip[:port]>]
#
# Installs only onto a device reporting model "Pixel 9", by serial: other phones
# are often adb-connected too, and a bare `adb install` could pick one of them.
set -euo pipefail
cd "$(dirname "$0")"

ADB="$ANDROID_HOME/platform-tools/adb"

echo "building APK…"
./gradlew :app:assembleDebug -q
APK="$PWD/app/build/outputs/apk/debug/app-debug.apk"

# :5555 (`adb tcpip`) survives sleep. VPN address first, then the LAN one. Pass
# an ip:port if wireless debugging picked a random port.
CANDIDATES=("${1:-}" "10.100.0.12:5555" "192.168.1.133:5555")

for EP in "${CANDIDATES[@]}"; do
  [ -z "$EP" ] && continue
  [[ "$EP" == *:* ]] || EP="$EP:5555"
  "$ADB" connect "$EP" 2>&1 | grep -qiE "connected|already" || continue
  MODEL="$("$ADB" -s "$EP" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
  if [ "$MODEL" != "Pixel 9" ]; then
    echo "  skip $EP — reports model '$MODEL', not 'Pixel 9'." >&2
    continue
  fi
  echo "=== installing to Pixel 9 ($EP) ==="
  "$ADB" -s "$EP" install -r "$APK"
  "$ADB" -s "$EP" shell am start -S -n org.xinutec.home/.MainActivity >/dev/null
  echo "  installed + launched on Pixel 9 ($EP)."
  exit 0
done

echo "Pixel 9 not reachable on :5555 (VPN or LAN). Re-enable wireless debugging or" >&2
echo "re-run 'adb tcpip 5555', then pass the ip:port as an argument." >&2
exit 1

#!/usr/bin/env bash
# wait-online.sh <device-id> [budget-seconds] — poll device view until
# containerState=running + adbState=online (refresh throttled). Prints final
# view JSON. Uses scratch admin login.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
DEV_ID="$1"; BUDGET="${2:-1800}"
. "$RD_SECRETS"
CK="$RD_STATE/cookie-wait.txt"
rm -f "$CK"
resp=$(curl -s -c "$CK" -X POST "$RD_API/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$RD_ADMIN_USER\",\"password\":\"$RD_ADMIN_PASS\"}")
echo "$resp" | grep -q '"role"' || { echo "login failed" >&2; exit 1; }
t0=$(date +%s)
while :; do
  now=$(date +%s)
  [ $((now - t0)) -gt "$BUDGET" ] && { echo "TIMEOUT after ${BUDGET}s" >&2; exit 2; }
  view=$(curl -s -b "$CK" "$RD_API/api/devices/redroid/$DEV_ID")
  state=$(echo "$view" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).device;console.log(j.containerState+'/'+j.adbState)})")
  case "$state" in
    running/online) echo "$view"; exit 0;;
    running/*)
      # throttle refresh to 1/min
      [ -f "$RD_STATE/refresh-throttle" ] && [ $((now - $(cat "$RD_STATE/refresh-throttle"))) -gt 60 ] && {
        curl -s -b "$CK" -X POST "$RD_API/api/devices/redroid/$DEV_ID/refresh" >/dev/null
        echo $now > "$RD_STATE/refresh-throttle"
      };;
  esac
  sleep 15
done

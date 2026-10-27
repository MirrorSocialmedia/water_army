#!/usr/bin/env bash
# J4 — Chrome + FB/IG/Threads manual login — VERIFY side (runbook J4).
# Boss口径 (2026-10-27 14:23): social platforms = Chrome BROWSER operation
# (FB/IG/Threads). Web session data = dataDir asset (J7 retention object).
# Humans perform logins via Console controller; this script verifies
# adb-layer facts + human sign-off matrix. WhatsApp is OUT (boss 14:36).
#
# Usage:
#   scripts/acceptance/j4-chrome-login.sh                              # verify all
#   scripts/acceptance/j4-chrome-login.sh --signoff <identity> --platform fb|ig|threads
#
# Env: ADB (default adb), WA_CHROME_PKG (default com.android.chrome),
#      WA_COOKIE_PATHS (default "app_chrome/Default/Cookies") — calibrate to
#      image on real-device stage; calibration result goes back into runbook J4.
# Idempotent: sign-off is append-dedup (same identity+platform = overwrite).
source "$(dirname "$0")/common.sh"
j_init j4
ADB="${ADB:-adb}"
CHROME_PKG="${WA_CHROME_PKG:-com.android.chrome}"
COOKIE_PATHS="${WA_COOKIE_PATHS:-app_chrome/Default/Cookies}"
SIGNOFF="$(ev_path signoff-matrix.tsv)"
touch "$SIGNOFF"

login_admin
api admin GET "/identities?pageSize=100" > "$(ev_path identities.json)"
api admin GET "/devices/redroid" > "$(ev_path devices.json)"
lookup_dev() { # name -> "deviceId adbPort" (device.name == identity pool name)
  jq -r --arg n "$1" '.devices[] | select(.name==$n) | "\(.id) \(.adbPort)"' "$(ev_path devices.json)" | head -1
}

# ---- sign-off mode: record a human confirmation -------------------------------
if [ "${1:-}" = "--signoff" ]; then
  ident="$2"; shift 2
  [ "${1:-}" = "--platform" ] && platform="$2" || platform="${1:?--platform fb|ig|threads required}"
  case "$platform" in fb|ig|threads) ;; *) echo "FATAL: platform must be fb|ig|threads (WhatsApp out — boss 14:36)" >&2; exit 2;; esac
  acc_scope "$ident"
  grep -v "^$ident	$platform	" "$SIGNOFF" > "$SIGNOFF.tmp" 2>/dev/null || true
  echo -e "$ident\t$platform\t$(date -Is)\t${WA_ACCEPT_OP_USER:-human}" >> "$SIGNOFF.tmp"
  mv "$SIGNOFF.tmp" "$SIGNOFF"
  echo "signed off: $ident / $platform"; exit 0
fi

# ---- verify mode ----------------------------------------------------------------
missing_signoff=0
for name in $(acc_names); do
  [ -n "$name" ] || continue
  read -r did port <<<"$(lookup_dev "$name")" || true
  [ -n "${did:-}" ] || { verdict FAIL "no device for $name"; continue; }
  api admin GET "/devices/redroid/$did" > "$(ev_path "device-$name.json")"
  assert_eq "device online ($name)" "online" "$(jq -r .adbState "$(ev_path "device-$name.json")")"
  target="127.0.0.1:$port"; "$ADB" connect "$target" >/dev/null 2>&1 || true
  # adb-layer facts: Chrome package present + cookie DB non-zero (login-state asset in dataDir)
  if "$ADB" -s "$target" shell pm list packages 2>/dev/null | grep -q "package:$CHROME_PKG\$"; then
    echo "PASS  chrome package ($name)"
  else verdict FAIL "chrome package missing ($name) — install/sideload per runbook J4, record version in evidence"; fi
  for p in $COOKIE_PATHS; do
    size="$("$ADB" -s "$target" shell "wc -c < /data/data/$CHROME_PKG/$p 2>/dev/null || echo 0" 2>/dev/null | tr -dc '0-9' || echo 0)"
    if [ "${size:-0}" -gt 0 ] 2>/dev/null; then echo "PASS  cookies non-zero ($name, $p, ${size}B)"
    else verdict FAIL "cookies empty/missing ($name, $p) — human logins incomplete or path needs calibration"; fi
  done
  # sign-off matrix: every platform recorded per identity
  for platform in fb ig threads; do
    if grep -q "^$name	$platform	" "$SIGNOFF"; then echo "PASS  sign-off $name/$platform"
    else echo "TODO  sign-off $name/$platform — after human login run: $0 --signoff $name --platform $platform"; missing_signoff=1; fi
  done
done
[ "$missing_signoff" = 1 ] && verdict FAIL "human sign-offs incomplete (see TODO lines + signoff-matrix.tsv)"

verdict passed "J4 Chrome/web login verification green (package + cookie asset + 10×3 sign-off matrix complete)"

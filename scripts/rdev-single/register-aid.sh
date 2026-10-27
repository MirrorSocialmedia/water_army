#!/usr/bin/env bash
# register-aid.sh — AID self-registration automation (GAcct 段4, ADR-034 fleet
# discipline: checkin → REGISTER → pool).
#
# Registers the device's Android ID at https://www.google.com/android/uncertified/
# with ZERO Google login (CEO 2026-10-28 real-device runbook): the form
# auto-prefills the Android ID from the device's checkin credential, then
# tick "I understand" → SUBMIT → "Your device has been registered".
#
# usage:
#   scripts/rdev-single/register-aid.sh <adb-serial>
#   scripts/rdev-single/register-aid.sh --dry-run <adb-serial>
# env:
#   AID_REG_DIR   evidence output dir            (default: logs/aid-reg)
#   AID_URL       registration URL               (default: official uncertified URL)
#   AID_WAIT_SECS form-load poll ceiling         (default: 60)
#   AID_TAP_METHOD tap | micro-swipe             (default: tap)
#
# Coordinates are calibrated on 720x1280 (CEO attendance checklist: tick
# "I understand" (50,1165), SUBMIT (630,1206)) and SCALED at runtime to the
# device resolution reported by `wm size`.
#
# WebView gotchas honoured (logs/waterarmy-whitelist-gmail-progress.md +
# GAcct 段4 real-device record):
#   ① keyboard eats taps — Skip-type links need a micro swipe
#      (`input swipe X Y X Y-1 120`); switchable here via AID_TAP_METHOD.
#   ② uiautomator dump NEVER reads MinuteMaid/uncertified WebViews
#      (0 bounds / stale) — navigation here is screencap-based: form-loaded
#      is detected by rendered-frame size/stability, success by the
#      operator-retained success-page capture (loud failure otherwise).
#   ③ KEYCODE_BACK walks back MULTIPLE steps at once — never used here.
#
# Exit codes: 0=registered (success page captured) 1=usage/adb error
#             2=form load timeout (evidence saved, operator decides)
#             3=post-submit success page not detected (evidence saved)
#
# Secrets: AID is device-identifying, NOT credential-grade; evidence dir is
# gitignored. URL carries no query string (plain uncertified URL).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADB="${ADB_BIN:-$HOME/.local/share/platform-tools/adb}"
EVID="${AID_REG_DIR:-$ROOT/logs/aid-reg}"
URL="${AID_URL:-https://www.google.com/android/uncertified/}"
WAIT_SECS="${AID_WAIT_SECS:-60}"
TAP_METHOD="${AID_TAP_METHOD:-tap}"   # tap | micro-swipe (WebView gotcha ①)
DRY=0
SERIAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "[aid-reg] unknown flag: $1" >&2; exit 1 ;;
    *) SERIAL="$1"; shift ;;
  esac
done
[ -n "$SERIAL" ] || { echo "[aid-reg] usage: register-aid.sh [--dry-run] <adb-serial>" >&2; exit 1; }
case "$TAP_METHOD" in tap|micro-swipe) ;; *) echo "[aid-reg] AID_TAP_METHOD must be tap|micro-swipe" >&2; exit 1 ;; esac

RUN_EVID="$EVID/$(date -u +%Y%m%dT%H%M%SZ)-$(echo "$SERIAL" | tr -c 'A-Za-z0-9._-' '_')"
S() { echo "[aid-reg] $(date -u +%FT%TZ) $*"; }
SH() { $ADB -s "$SERIAL" shell "$@"; }
CAP() { # CAP <tag> -> local png (screencap; ONLY reliable UI read per gotcha ②)
  local f="$RUN_EVID/$1.png"
  $ADB -s "$SERIAL" exec-out screencap -p > "$f" 2>/dev/null
  echo "$f"
}
cap_kb() { local f; f=$(CAP "probe-$$"); local k=$(( $(stat -c%s "$f") / 1024 )); rm -f "$f"; echo "$k"; }
act_tap() { # act_tap <x> <y> — abstracted click (gotcha ① escape hatch)
  if [ "$TAP_METHOD" = "micro-swipe" ]; then SH "input swipe $1 $2 $1 $(( $2 - 1 )) 120"
  else SH "input tap $1 $2"; fi
}

if [ "$DRY" = 1 ]; then
  S "DRY-RUN serial=$SERIAL url=$URL evidence=$RUN_EVID tap=$TAP_METHOD"
  S "DRY plan: WAKEUP+dismiss-keyguard -> VIEW intent -> poll screencap (ceil ${WAIT_SECS}s, rendered-frame >=30KB + stable) -> tick (50,1165@720x1280 scaled) -> SUBMIT (630,1206@720x1280 scaled) -> poll success page (>=20KB) -> 019/099 evidence"
  exit 0
fi

mkdir -p "$RUN_EVID"
S "serial=$SERIAL evidence=$RUN_EVID url=$URL wait=${WAIT_SECS}s tap=$TAP_METHOD"
$ADB start-server >/dev/null 2>&1
$ADB connect "$SERIAL" >/dev/null 2>&1 || true
$ADB -s "$SERIAL" wait-for-device
$ADB -s "$SERIAL" shell getprop sys.boot_completed | tr -d '\r' | grep -qx 1 || S "WARN boot_completed!=1 (continuing — UI may still settle)"

# Resolution-proportional coordinates (baseline 720x1280).
SZ="$($ADB -s "$SERIAL" shell wm size 2>/dev/null | tr -d '\r' | grep -oE '[0-9]+x[0-9]+' | tail -1)"
W=720; H=1280
if [ -n "$SZ" ]; then W="${SZ%x*}"; H="${SZ#*x}"; fi
X_TICK=$(( 50 * W / 720 )); Y_TICK=$(( 1165 * H / 1280 ))
X_SUB=$(( 630 * W / 720 )); Y_SUB=$(( 1206 * H / 1280 ))
S "screen=${W}x${H} tick=($X_TICK,$Y_TICK) submit=($X_SUB,$Y_SUB)"

# 1. Wake (headless redroid sleeps by default — known trap).
SH "input keyevent WAKEUP"; sleep 1
SH "wm dismiss-keyguard"; sleep 1
CAP 001-wake >/dev/null

# 2. Open the form (webview_shell handles VIEW; zero-login).
SH "am start -a android.intent.action.VIEW -d '$URL'" > "$RUN_EVID/intent.txt" 2>&1 || { S "FAIL: VIEW intent failed"; cat "$RUN_EVID/intent.txt"; exit 1; }

# 3. Poll until the form renders. uiautomator is blind here (gotcha ②), so we
#    detect a RENDERED frame: PNG >= 30KB (blank/white page compresses small;
#    the form page is content-rich) AND byte-stable across two probes.
FORM=0
PREV=""
for i in $(seq 1 "$WAIT_SECS"); do
  sleep 1
  KB=$(cap_kb)
  if [ "$i" = 1 ] || [ $(( i % 10 )) = 0 ]; then S "form poll t=${i}s rendered_kb=$KB"; fi
  if [ "$KB" -ge 30 ] && [ "$KB" = "$PREV" ]; then FORM=1; break; fi
  PREV="$KB"
done
CAP 002-form >/dev/null
if [ "$FORM" != 1 ]; then
  S "FAIL: form not detected after ${WAIT_SECS}s (evidence: $RUN_EVID/002-form.png) — check egress (EGRESS_PROXY/gost) and connectivity; operator review"
  exit 2
fi
S "form frame rendered (rendered_kb=$KB) — NOTE: heuristics cannot OCR; operator eyeballs 002-form.png if in doubt"

# 4. Tick "I understand" + SUBMIT (baseline coords scaled).
act_tap "$X_TICK" "$Y_TICK"; sleep 1
CAP 003-ticked >/dev/null
act_tap "$X_SUB" "$Y_SUB"; sleep 2

# 5. Success detection (heuristic): stable rendered frame >= 20KB within 30s.
OK=0; PREV=""
for i in $(seq 1 30); do
  sleep 1
  KB=$(cap_kb)
  if [ "$KB" -ge 20 ] && [ "$KB" = "$PREV" ]; then OK=1; break; fi
  PREV="$KB"
done
if [ "$OK" = 1 ]; then
  CAP 099-success >/dev/null
  S "DONE: registration flow completed; success page retained at $RUN_EVID/099-success.png — fleet discipline: this datadir's AID is now registered; NEVER reflash without re-registration"
  exit 0
fi
CAP 098-no-success >/dev/null
S "FAIL: post-submit success page NOT detected (evidence: $RUN_EVID/098-no-success.png) — operator review (risk-control wall? coordinate drift? set AID_TAP_METHOD=micro-swipe and retry)"
exit 3

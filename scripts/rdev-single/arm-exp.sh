#!/usr/bin/env bash
# L3-C' EXP-6 — ARM translator real-device leg (gms-mtg-arm + boss's ARM Chrome).
# Four-layer verdict protocol (each layer's death is a valid conclusion):
#   L-i  install  : adb install-multiple of the 4 split APKs exits 0 + pm path
#   L-ii process  : am start + pgrep of com.android.chrome
#   L-iii UI      : screencap non-uniform (UI rendered)
#   L-iv browse   : VIEW intent to host-served marker page on the scratch
#                   bridge gateway + screencap shows marker text (uiautomator
#                   dump preferred, screencap as visual evidence)
# Evidence: logs/l3c-arm/p6/*.
#
# Usage:
#   arm-exp.sh boot            # RAM-gated boot (reuses rdev-single/boot.sh)
#   arm-exp.sh collect         # boot-completed wait + prop/native evidence
#   arm-exp.sh install         # L-i
#   arm-exp.sh launch          # L-ii + L-iii
#   arm-exp.sh browse          # L-iv (starts host marker server itself)
#   arm-exp.sh teardown        # rm container + datadir, zero-residue check
set -eu
ROOT=/home/kenneth/.openclaw/workspace/water_army
EVID="$ROOT/logs/l3c-arm"; P6="$EVID/p6"; mkdir -p "$P6"
ADB="$HOME/.local/share/platform-tools/adb"
NAME=rdev-a1; IMAGE=water-army/redroid:14.0.0-240527-gms-mtg-arm
PORT=16511; DATADIR=/tmp/rdev-single-state/a1-data
GW=172.38.223.1; MARKER_PORT=8099
MARKER="WA-ARM-EXP6-$$"
APKS="/home/kenneth/Downloads/Google+Chrome_156.0.8078.47_APKPure"
log() { echo "[arm-exp] $*" | tee -a "$EVID/harness.log"; }
# uiautomator XML dump with 2-mode fallback: exec-out /dev/tty can yield 0
# bytes on some adb builds (known trap) -> file dump + cat (L-iv marker fix).
ui_dump() { # $1 = dest file on host
  local raw
  raw=$($ADB -s 127.0.0.1:$PORT exec-out uiautomator dump /dev/tty 2>/dev/null | tr -d '\r\n')
  if [ "${#raw}" -gt 200 ] && echo "$raw" | grep -q "<hierarchy"; then
    printf '%s\n' "$raw" > "$1"; return 0
  fi
  $ADB -s 127.0.0.1:$PORT shell uiautomator dump /sdcard/wa-ui.xml >/dev/null 2>&1 \
    && $ADB -s 127.0.0.1:$PORT shell cat /sdcard/wa-ui.xml 2>/dev/null | tr -d '\r' > "$1"
  [ -s "$1" ] && grep -q "<hierarchy" "$1"
}
# dismiss-dialogs: tap-away loop for warning dialogs blocking the intent chain
# (A14 DeprecatedAbiDialog on 32-bit ARM builds — CEO 2026-10-27 evidence:
# OK button bounds [462,715][702,779], resource-id android:id/button1).
# Max ROUNDS taps to guarantee loop-exit. Returns 0 always (best-effort).
dismiss_dialogs() { # $1 = max rounds (default 5)
  local rounds="${1:-5}" i n=0 xml=/tmp/wa-ui-dump.xml
  for i in $(seq 1 "$rounds"); do
    ui_dump "$xml" || { log "dismiss-dialogs: dump failed round $i"; break; }
    # positive button of AlertDialog (locale-independent) — bounds [l,t][r,b]
    local bounds
    bounds=$(python3 - "$xml" <<'PY'
import re,sys
xml=open(sys.argv[1],encoding="utf-8",errors="replace").read()
nodes=re.findall(r'<node\b[^>]*?/>',xml)
for n in nodes:
    rid=re.search(r'resource-id="([^"]*)"',n)
    txt=re.search(r'text="([^"]*)"',n)
    clk=re.search(r'clickable="([^"]*)"',n)
    if (rid and rid.group(1) in ("android:id/button1","com.android.systemui:id/button1")) or \
       (txt and txt.group(1).strip().lower() in ("ok","知道了","確定","确认") and (not clk or clk.group(1)=="true")):
        b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',n)
        if b: print(" ".join(b.groups())); break
PY
)
    [ -z "$bounds" ] && { log "dismiss-dialogs: no dismissable dialog (round $i) — chain clear"; break; }
    set -- $bounds; local x=$(( ($1 + $3) / 2 )) y=$(( ($2 + $4) / 2 ))
    log "dismiss-dialogs: tapping dialog positive button at $x,$y (round $i)"
    $ADB -s 127.0.0.1:$PORT shell input tap "$x" "$y"
    n=$((n+1)); sleep 2
  done
  log "dismiss-dialogs: done, $n tap(s) used"
  return 0
}
wait_adb() {
  for i in $(seq 1 60); do $ADB connect "127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 2; done
  for i in $(seq 1 60); do
    [ "$($ADB -s 127.0.0.1:$PORT shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && return 0
    sleep 2
  done; return 1
}
case "${1:-}" in
boot)
  bash "$ROOT/scripts/rdev-single/boot.sh" "$NAME" "$IMAGE" "$PORT" "$DATADIR" "$ROOT/scripts/rdev-single/cmd-mtg-arm.txt"
  wait_adb || log "WARN boot_completed timeout (still collecting)"
  log "$NAME booted, adb=127.0.0.1:$PORT"
  ;;
collect)
  S="$ADB -s 127.0.0.1:$PORT shell"
  $S getprop | grep -E "abilist|native.bridge|isa\.arm|zygote" > "$P6/props.txt" 2>&1
  $S 'ls -l /system/bin/houdini /system/bin/houdini64 /system/lib/libhoudini.so /system/lib64/libhoudini.so /system/etc/init/houdini.rc 2>&1; ls /system/lib/arm | wc -l; ls /system/lib64/arm64 | wc -l' > "$P6/files.txt" 2>&1
  $S 'cat /proc/sys/fs/binfmt_misc/status 2>&1; ls /proc/sys/fs/binfmt_misc/ 2>&1' > "$P6/binfmt.txt" 2>&1
  $S 'logcat -d | grep -iE "houdini|native.?bridge|berberis|libnb|patch.*ld.config|insecure" | head -80' > "$P6/logcat-bridge.txt" 2>&1
  log "evidence: props files binfmt logcat -> p6/"
  ;;
install)
  $ADB -s 127.0.0.1:$PORT install-multiple -r \
    "$APKS/chrome.apk" "$APKS/com.android.chrome.apk" "$APKS/config.en.apk" "$APKS/on_demand.apk" \
    2>&1 | tee "$P6/install.txt"
  $ADB -s 127.0.0.1:$PORT shell pm path com.android.chrome > "$P6/pm-path.txt" 2>&1
  ;;
launch)
  $ADB -s 127.0.0.1:$PORT shell am start -W -n com.android.chrome/com.google.android.apps.chrome.Main 2>&1 | tee "$P6/am-start.txt"
  sleep 8
  $ADB -s 127.0.0.1:$PORT shell 'ps -A | grep -i chrome' > "$P6/ps.txt" 2>&1 || true
  $ADB -s 127.0.0.1:$PORT exec-out screencap -p > "$P6/screen-launch.png" 2>&1
  $ADB -s 127.0.0.1:$PORT shell 'logcat -d -t 400 | grep -iE "chromium|houdini|DEBUG|SIGILL|SIGSEGV|tombstone|nativebridge" | tail -60' > "$P6/logcat-launch.txt" 2>&1 || true
  log "launch evidence -> p6/ (check ps.txt = L-ii, screen-launch.png = L-iii)"
  ;;
browse)
  dismiss_dialogs 5   # A14 DeprecatedAbiDialog (32-bit ARM) otherwise swallows the VIEW intent
  printf '<html><body style="font-size:40px">MARKER %s</body></html>' "$MARKER" > /tmp/wa-arm-marker.html
  nohup python3 -m http.server $MARKER_PORT --bind "$GW" --directory /tmp >/tmp/wa-arm-http.log 2>&1 &
  HTTPID=$!; echo $HTTPID > "$P6/http.pid"
  sleep 1
  $ADB -s 127.0.0.1:$PORT shell am start -a android.intent.action.VIEW -d "http://$GW:$MARKER_PORT/wa-arm-marker.html" com.android.chrome 2>&1 | tee "$P6/am-view.txt"
  sleep 12
  $ADB -s 127.0.0.1:$PORT exec-out screencap -p > "$P6/screen-browse.png" 2>&1
  # L-iv marker via uiautomator (2-mode ui_dump; old single-mode exec-out could yield 0 bytes)
  if ui_dump "$P6/ui-browse.xml"; then
    grep -o "MARKER [A-Za-z0-9-]*" "$P6/ui-browse.xml" | sort -u > "$P6/marker-uia.txt" || true
    log "L-iv marker: $(cat "$P6/marker-uia.txt" 2>/dev/null | tr '\n' ' ') (expected=$MARKER)"
  else
    : > "$P6/marker-uia.txt"
    log "WARN ui_dump failed both modes — rely on screen-browse.png visual evidence"
  fi
  kill "$HTTPID" 2>/dev/null || true
  log "browse evidence -> p6/ (marker=$MARKER; check screen-browse.png / marker-uia.txt = L-iv)"
  ;;
teardown)
  docker rm -f "$NAME" >/dev/null 2>&1 && log "container removed"
  [ -d "$DATADIR" ] && docker run --rm -v /tmp/rdev-single-state:/x alpine:3.20 rm -rf /x/a1-data && log "datadir removed (root-shim)"
  rm -f "/tmp/rdev-single-state/$NAME.cid"
  n=$(docker ps -aq -f name="^${NAME}$" | wc -l)
  log "teardown check: container residue=$n"; [ "$n" = 0 ]
  ;;
dismiss-dialogs)
  dismiss_dialogs "${2:-5}"
  ;;
*) echo "usage: $0 boot|collect|install|launch|browse|dismiss-dialogs [N]|teardown"; exit 2;;
esac

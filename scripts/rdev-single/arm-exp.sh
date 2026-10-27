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
  printf '<html><body style="font-size:40px">MARKER %s</body></html>' "$MARKER" > /tmp/wa-arm-marker.html
  nohup python3 -m http.server $MARKER_PORT --bind "$GW" --directory /tmp >/tmp/wa-arm-http.log 2>&1 &
  HTTPID=$!; echo $HTTPID > "$P6/http.pid"
  sleep 1
  $ADB -s 127.0.0.1:$PORT shell am start -a android.intent.action.VIEW -d "http://$GW:$MARKER_PORT/wa-arm-marker.html" com.android.chrome 2>&1 | tee "$P6/am-view.txt"
  sleep 12
  $ADB -s 127.0.0.1:$PORT exec-out screencap -p > "$P6/screen-browse.png" 2>&1
  $ADB -s 127.0.0.1:$PORT exec-out uiautomator dump /dev/tty 2>/dev/null | grep -o "MARKER [A-Za-z0-9-]*" > "$P6/marker-uia.txt" || true
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
*) echo "usage: $0 boot|collect|install|launch|browse|teardown"; exit 2;;
esac

#!/usr/bin/env bash
# rdev-single R1-3 negative-case runner: boot s1 slot with given cmdfile, wait
# boot_completed (fail if not in 90 s), snapshot key props, teardown.
# Usage: neg-case.sh <label> <cmdfile-or-"-"> <datadir>
set -u
LABEL="$1"; CMDFILE="$2"; DATADIR="$3"
RD=/home/kenneth/.openclaw/workspace/water_army
ADB=$HOME/.local/share/platform-tools/adb
EVID=$RD/logs/rdev-single/p2; PORT=16496
IMG=water-army/redroid:14.0.0-240527-w1b-f1
docker rm -f rdev-s1 >/dev/null 2>&1
docker run -d --name rdev-s1 --network br-rdev-single --privileged -v "$DATADIR:/data" \
  --label app.managed=true --label app.created-by=rdev-single --memory 4g \
  -p "127.0.0.1:${PORT}:5555" "$IMG" $( [ "$CMDFILE" != "-" ] && cat "$CMDFILE" ) >/dev/null
T0=$(date +%s)
OK=0
for i in $(seq 1 36); do
  V=$($ADB connect 127.0.0.1:$PORT >/dev/null 2>&1; $ADB -s 127.0.0.1:$PORT shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$V" = "1" ] && { OK=1; break; }
  sleep 2.5
done
T1=$(date +%s)
{
  echo "case=$LABEL ts=$(date -u +%FT%TZ) boot_completed=$([ $OK = 1 ] && echo 1 || echo TIMEOUT) boot_secs=$((T1-T0))"
  $ADB -s 127.0.0.1:$PORT shell getprop ro.product.model 2>/dev/null | tr -d '\r' | sed 's/^/ro.product.model=/'
  $ADB -s 127.0.0.1:$PORT shell getprop ro.build.fingerprint 2>/dev/null | tr -d '\r' | sed 's/^/ro.build.fingerprint=/'
  echo "oem_carrier_count=$($ADB -s 127.0.0.1:$PORT shell getprop 2>/dev/null | grep -c ro.boot.oem)"
  $ADB -s 127.0.0.1:$PORT shell "logcat -d -b all 2>/dev/null | grep -iE 'oem.propctl|oem-ro-map' | head -8"
} > "$EVID/r1-3-${LABEL}.txt" 2>&1
cat "$EVID/r1-3-${LABEL}.txt"
docker rm -f rdev-s1 >/dev/null 2>&1

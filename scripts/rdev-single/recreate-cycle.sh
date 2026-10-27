#!/usr/bin/env bash
# R3-R1: same identity, 3x recreate (docker rm + boot, SAME dataDir + Cmd),
# probe dump each cycle for byte-identical field comparison.
set -u
RD=/home/kenneth/.openclaw/workspace/water_army
ADB=$HOME/.local/share/platform-tools/adb
S=127.0.0.1:16496
E=$RD/logs/rdev-single/p2
IMG=water-army/redroid:14.0.0-240527-w1b-f1
DATA=/var/lib/water-army/redroid-rdev-s1
for N in 1 2 3; do
  docker rm -f rdev-s1 >/dev/null 2>&1
  docker run -d --name rdev-s1 --network br-rdev-single --privileged -v "$DATA:/data" \
    --label app.created-by=rdev-single --memory 4g -p 127.0.0.1:16496:5555 \
    "$IMG" $(cat $RD/logs/rdev-single/p2/cmd-s1.txt) >/dev/null
  for i in $(seq 1 40); do
    $ADB connect $S >/dev/null 2>&1
    V=$($ADB -s $S shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
    [ "$V" = "1" ] && break; sleep 3
  done
  $ADB -s $S root >/dev/null 2>&1; sleep 2; $ADB connect $S >/dev/null 2>&1
  $ADB -s $S shell am start-activity -n com.waterarmy.probe/.ProbeActivity >/dev/null 2>&1
  sleep 2
  $ADB -s $S shell cat /data/local/tmp/wa-probe-dump.json > "$E/probe-dump-recreate-$N.json" 2>/dev/null
  echo "cycle $N: boot_completed=$V bytes=$(stat -c%s "$E/probe-dump-recreate-$N.json")"
done

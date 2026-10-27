#!/usr/bin/env bash
# L3-C' EXP-6 RAM-window watcher: poll MemAvailable until the rdev-single
# boot gate (>=6144 MiB AND projected M-2560>=6144, boss 17:31 scratch口径)
# opens, or deadline. Evidence line per sample into harness.log.
set -eu
EVID=/home/kenneth/.openclaw/workspace/water_army/logs/l3c-arm
mkdir -p "$EVID"
DEADLINE=$(( $(date +%s) + ${1:-900} ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  M=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  P=$((M - 2560))
  echo "[ram-watch] $(date -u +%FT%TZ) MemAvailable=${M}MiB projected=${P}MiB $( [ "$M" -ge 6144 ] && [ "$P" -ge 6144 ] && echo WINDOW-OPEN || echo deny )" >> "$EVID/ram-watch.log"
  if [ "$M" -ge 6144 ] && [ "$P" -ge 6144 ]; then echo "WINDOW OPEN (M=${M})"; exit 0; fi
  sleep 30
done
echo "WINDOW NOT OPEN before deadline"; exit 1

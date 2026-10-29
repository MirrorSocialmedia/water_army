#!/bin/bash
# WA-RESCAN: extract fx-3 battery watchdog log lines (prod evidence for S1).
set -u
EV=/home/kenneth/.openclaw/workspace/water_army/docs/audits/rescan/evidence
{ echo "# production API log (watchdog readback/replay) — fx-3, UTC epoch ms in time field"
  echo "## boot-window replays + live wipe race replay (manual dumpsys battery reset @ 00:28:38 HKT)"
  docker logs water-army-api-1 2>&1 | grep "fx-3" | grep -iE "REPLAYED|readback"
  echo "## mc-dogfood-2 degraded readback path (stopped container, non-fatal fallback proof)"
  docker logs water-army-api-1 2>&1 | grep "readback failed" | tail -2
} | tee "$EV/s1-fx3-watchdog-logs.txt" | tail -8

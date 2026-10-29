#!/bin/bash
cd "/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1"
PIDS=$(pgrep -f cdp-probe.mjs)
[ -n "$PIDS" ] && kill $PIDS 2>/dev/null
ADB=/home/kenneth/.local/share/platform-tools/adb
for p in 15000 15001 15002 15003; do $ADB -s 127.0.0.1:$p forward --remove-all 2>/dev/null; done
node --check cdp-probe.mjs && ./run-browser.sh

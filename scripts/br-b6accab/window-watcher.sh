#!/usr/bin/env bash
# BR-B6-Acceptance A+B — window watcher: re-runs window-check every N seconds;
# appends one line per evaluation to the watch log; writes a marker file when
# the window OPENS (the boot harness re-gates independently — the marker is a
# signal only, never an authorization to skip the gate).
#
# Usage: setsid nohup bash scripts/br-b6accab/window-watcher.sh \
#          <samples.csv> <watch-log> <open-marker> [interval_s=60] &
set -uo pipefail

CSV="${1:?samples.csv}"
WATCH_LOG="${2:?watch-log}"
MARKER="${3:?open-marker}"
INTERVAL="${4:-60}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$(dirname "$WATCH_LOG")"

while :; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if bash "$SCRIPT_DIR/window-check.sh" "$CSV" > /tmp/brb6accab-watch-out.$$ 2>&1; then
    echo "$ts OPEN" >> "$WATCH_LOG"
    rm -f "$MARKER"
    echo "$ts" > "$MARKER"
  else
    # keep the last violation reason (first line after status) for the log
    reason=$(sed -n '3p' /tmp/brb6accab-watch-out.$$ | head -c 120)
    echo "$ts CLOSED ${reason:-}" >> "$WATCH_LOG"
    rm -f "$MARKER"
  fi
  rm -f /tmp/brb6accab-watch-out.$$
  sleep "$INTERVAL"
done

#!/usr/bin/env bash
# BR-B6-Acceptance A+B — one polling wait cycle for the CTO session (NOT a
# long-running daemon; the sampler/watcher units are the long-runners).
#
# Polls up to ~$1 seconds (default 660):
#   - exits early if the WINDOW-OPEN marker appears
#   - warns if the sampler CSV goes stale (>120s)
# Then prints a status summary: unit liveness, CSV age + tail, marker state,
# and a fresh window-check (gate) evaluation.
#
# Usage: bash scripts/br-b6accab/wait-cycle.sh [duration_s=660]
set -uo pipefail
EVID="${BRB6ACCAB_EVID:-/home/kenneth/.openclaw/workspace/logs/br-b6-accAB}"
CSV="$EVID/samples-30s.csv"
MARKER="$EVID/WINDOW-OPEN"
DURATION="${1:-660}"
t0=$(date +%s)
deadline=$(( t0 + DURATION ))
early=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -f "$MARKER" ]; then early=1; break; fi
  age=$(( $(date +%s) - $(stat -c %Y "$CSV" 2>/dev/null || echo 0) ))
  [ "$age" -gt 120 ] && echo "WARN: sampler CSV age ${age}s >120s — check br-b6accab-sampler unit"
  sleep 30
done
echo "=== wait-cycle summary $(date -u +%Y-%m-%dT%H:%M:%SZ) (ran $(( $(date +%s) - t0 ))s, early=$early) ==="
echo "units: sampler=$(systemctl --user is-active br-b6accab-sampler 2>/dev/null) watcher=$(systemctl --user is-active br-b6accab-watcher 2>/dev/null)"
age=$(( $(date +%s) - $(stat -c %Y "$CSV" 2>/dev/null || echo 0) ))
echo "csv_age_s=$age"
tail -3 "$CSV"
if [ -f "$MARKER" ]; then echo "MARKER PRESENT: $(cat "$MARKER")"; else echo "marker: absent"; fi
echo "=== window-check ==="
bash "$(cd "$(dirname "$0")" && pwd)/window-check.sh" "$CSV"
rc=$?
[ "$rc" -eq 0 ] && echo "GATE=OPEN" || echo "GATE=closed rc=$rc"

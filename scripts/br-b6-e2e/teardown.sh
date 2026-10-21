#!/usr/bin/env bash
# BR-B6 E2E teardown — removes 100% of the scratch footprint:
# pids (worker procs the driver spawned) → br-b6-pg / br-b6-redis containers
# (ours only, by exact name) → the .dev/br-b6-e2e data root. The test IMAGES
# stay (reusable, pinned dated tags; document in report). NOTHING shared is
# touched (user compose, other containers, volumes, ports).
set -uo pipefail
cd "$(dirname "$0")/../.."
RUN=.dev/br-b6-e2e
log() { echo "[br-b6-e2e-teardown] $*"; }
dc() { sg docker -c "docker $*"; }

# 1) workers (the driver's children; guard against double-kill)
for f in "$RUN"/pids/w*; do
  [ -f "$f" ] || continue
  pid=$(cat "$f" 2>/dev/null)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    log "stopping worker pid $pid ($(basename "$f"))"
    kill "$pid" 2>/dev/null || true
  fi
done
# 2) scratch containers (ours only — exact names)
for c in br-b6-pg br-b6-redis; do
  if dc ps -a --format '{{.Names}}' | grep -qx "$c"; then
    log "removing container $c"
    dc rm -f "$c" >/dev/null 2>&1 || log "WARN: could not remove $c"
  fi
done
# 3) residual batch containers (should be zero after the driver's final
#    reconcile sweep — belt and braces). Filter on the BATCH label, never on
#    app.managed=true (the user's compose containers share that label).
residual=$(dc ps -a --filter "label=com.mirrorsocialmedia.water-army.task-run-id" --format '{{.ID}}' 2>/dev/null || true)
if [ -n "$residual" ]; then
  log "removing residual managed containers:"
  echo "$residual" | while read -r id; do
    [ -n "$id" ] && dc rm -f "$id" >/dev/null 2>&1 && log "  removed $id"
  done
fi
# 4) data root (scratch identity volumes — ours only)
if [ -d "$RUN" ]; then
  log "removing $RUN (scratch data root + logs + evidence copies)"
  rm -rf "$RUN"
fi
# 5) report + port check
log "final port check (163xx must be clear)"
sg docker -c "docker ps --format '{{.Names}} {{.Ports}}'" | awk '/163[0-9][0-9]/ {print "  STILL BOUND: "$0; found=1} END {if (!found) print "  163xx clear"}'
log "teardown complete"

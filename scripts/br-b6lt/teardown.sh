#!/usr/bin/env bash
# BR-B6 ladder load-test teardown — removes 100% of what setup.sh created:
# worker + API (verified-identity kill), br-b6lt-pg/redis containers, the
# br-b6lt-* data root + run dir. NEVER touches shared infra, user compose,
# existing DB/Redis/identity volumes, or the redroid image.
set -uo pipefail
cd "$(dirname "$0")/../.."

RUN=.dev/br-b6lt
log() { echo "[br-b6lt-teardown] $*"; }

# 1) workers
for f in "$RUN"/pids/w*; do
  [ -f "$f" ] || continue
  pid=$(cat "$f" 2>/dev/null)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    log "stopping worker pid $pid ($(basename "$f"))"
    kill "$pid" 2>/dev/null || true
  fi
done

# 1b) the run.sh-owned API (orphan-collision guard — verified identity only)
if [ -f "$RUN/pids/api" ]; then
  apid=$(cat "$RUN/pids/api" 2>/dev/null)
  if [ -n "${apid:-}" ] && kill -0 "$apid" 2>/dev/null \
     && tr '\0' '\n' < "/proc/$apid/environ" 2>/dev/null | grep -q '^APP_PORT=16543$'; then
    log "stopping API pid $apid (APP_PORT=16543 verified)"
    kill "$apid" 2>/dev/null || true
  fi
fi

# 2) managed containers left by the ladder. Product-named containers carry
#    the batch-only label com.mirrorsocialmedia.water-army.task-run-id (the
#    user's compose never has it) — filter on that, name-gated to wa-batch-*/
#    br-b6lt-*.
#    BUGFIX (2026-10-22, ladder attempts 4-5): the old logic matched the
#    name-embedded UUID against `SELECT id FROM batches` — broken twice over:
#    the tables are `batch`/`task_run` (query failed silently → empty list)
#    AND the name embeds the RUN uuid, not the batch uuid. Every live
#    container was classified "foreign" and left running: 36 orphans / ~16GB
#    RAM after two HALT runs, which then tripped the host-ram guard on the
#    next launch (MemAvailable 7.0G/5.5G). Label filter + rm -f is the
#    same contract the (correct) E2E teardown uses; data roots survive rm -f
#    (bind mounts are removed, not the source dir).
residual=$(sg docker -c "docker ps -a --filter label=com.mirrorsocialmedia.water-army.task-run-id --format '{{.ID}} {{.Names}}'" 2>/dev/null || true)
while read -r cid cname; do
  [ -z "${cid:-}" ] && continue
  case "$cname" in
    wa-batch-*|br-b6lt-*)
      log "removing ladder-managed container $cid ($cname)"; sg docker -c "docker rm -f $cid" >/dev/null 2>&1 || true ;;
    *) log "LEAVING foreign labeled container $cid ($cname) alone" ;;
  esac
done <<< "$residual"

# 3) scratch containers by name (ours only)
sg docker -c "docker rm -f br-b6lt-pg br-b6lt-redis" >/dev/null 2>&1 || true

# 4) scratch data root + run dir (NEVER the user's /var/lib/water-army)
if [ -d "$RUN" ]; then
  log "removing $RUN (data root + run artifacts)"
  rm -rf "$RUN"
fi

log "teardown complete"

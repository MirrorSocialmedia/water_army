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

# 2) managed containers left by the ladder. Live containers are product-named
#    wa-batch-<batchId>-a<n> — ownership is proven by batchId being in OUR
#    scratch DB (UUIDs are globally unique; a concurrent fault/E2E run on
#    163xx has disjoint batch ids and is never touched). Fallback when pg is
#    already gone: only name-prefixed br-b6lt-* containers.
DB_NAME=cw_b6lt
DB_USER=cw_b6lt
if command -v sg >/dev/null 2>&1; then
  OUR_BATCHES=$(sg docker -c "docker exec br-b6lt-pg psql -U $DB_USER -d $DB_NAME -tAc 'SELECT id FROM batches'" 2>/dev/null || true)
  for cid in $(sg docker -c "docker ps -aq --filter label=com.mirrorsocialmedia.water-army.managed=true" 2>/dev/null); do
    name=$(sg docker -c "docker inspect --format '{{.Name}}' $cid" 2>/dev/null | tr -d '/')
    case "$name" in
      br-b6lt-*)
        log "removing residual managed container $cid ($name)"; sg docker -c "docker rm -f $cid" >/dev/null 2>&1 || true ;;
      wa-batch-*)
        ours=0
        for b in $OUR_BATCHES; do
          case "$name" in *"$b"*) ours=1; break ;; esac
        done
        if [ "$ours" = "1" ]; then
          log "removing ladder-owned live container $cid ($name)"; sg docker -c "docker rm -f $cid" >/dev/null 2>&1 || true
        else
          log "LEAVING foreign managed container $cid ($name) alone (batch id not in our DB)"
        fi ;;
      *) log "LEAVING foreign managed container $cid ($name) alone" ;;
    esac
  done
fi

# 3) scratch containers by name (ours only)
sg docker -c "docker rm -f br-b6lt-pg br-b6lt-redis" >/dev/null 2>&1 || true

# 4) scratch data root + run dir (NEVER the user's /var/lib/water-army)
if [ -d "$RUN" ]; then
  log "removing $RUN (data root + run artifacts)"
  rm -rf "$RUN"
fi

log "teardown complete"

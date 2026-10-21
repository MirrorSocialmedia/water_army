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

# 2) any managed containers left by the ladder (by label, never by name glob)
if command -v sg >/dev/null 2>&1; then
  for cid in $(sg docker -c "docker ps -aq --filter label=com.mirrorsocialmedia.water-army.managed=true" 2>/dev/null); do
    name=$(sg docker -c "docker inspect --format '{{.Name}}' $cid" 2>/dev/null | tr -d '/')
    case "$name" in
      br-b6lt-*) log "removing residual managed container $cid ($name)"; sg docker -c "docker rm -f $cid" >/dev/null 2>&1 || true ;;
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

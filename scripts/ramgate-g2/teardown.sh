#!/usr/bin/env bash
# RAM-G2 teardown — remove ALL G2 artifacts + verify zero residue.
#
#   scratch api + worker  — PIDFILE kill only (G1 incident lesson: never
#                           pattern-kill; pgrep -f matches container host pids)
#   device containers     — redroid-brb6g-l* (exact prefix filter)
#   network               — br-b6g-ladder
#   scratch pg/redis      — g2-scratch-pg / g2-scratch-redis
#   dataDir root          — alpine:3.20 root shim (privileged redroid writes
#                           as root → host rm EACCES; R5 known behaviour)
#   verification          — containers / network / ports 16400-16499 /
#                           dataDir / host scratch processes: all ZERO
#
# NEVER touches: user compose water-army-*, /var/lib/water-army/redroid
# (product Identity data), SGLang.
set -uo pipefail
SUBCMD="${1:-teardown}"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mkdir -p "$R2_EVID"

kill_by_pidfile() { # $1=label $2=pidfile
  local label="$1" pf="$2" pid
  if [ ! -f "$pf" ]; then log "$label: no pidfile ($pf) — skip"; return 0; fi
  pid=$(cat "$pf" 2>/dev/null || echo "")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # G1 lesson: verify the target is NOT a docker container process before
    # anything (we only ever kill OUR pidfile pids, but the check is cheap).
    local cg
    cg=$(cat "/proc/$pid/cgroup" 2>/dev/null | grep -c 'docker-' || true)
    if [ "${cg:-0}" != "0" ]; then
      log "ABORT killing $label: pid $pid has a docker- cgroup scope — NOT ours"; return 1
    fi
    log "$label: SIGTERM pid $pid"
    kill -TERM "$pid" 2>/dev/null || true
    local w
    for w in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      log "$label: still alive after 15s — SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
      sleep 1
    fi
    log "$label: stopped"
  else
    log "$label: pidfile stale (pid ${pid:-?} not running) — skip"
  fi
  rm -f "$pf"
  return 0
}

cmd_teardown() {
  local left=0

  log "== 1. scratch processes (pidfile) =="
  kill_by_pidfile "scratch-api" "$R2_SCRATCH_STATE/api.pid" || left=$((left+1))
  kill_by_pidfile "scratch-worker" "$R2_SCRATCH_STATE/worker.pid" || left=$((left+1))

  log "== 2. device containers (redroid-brb6g-l*) =="
  local c
  for c in $(DC ps -aq --filter 'name=redroid-brb6g-l'); do
    log "rm container $c"; DC rm -f "$c" >/dev/null 2>&1 || true
  done
  # network-membership sweep (catch misnamed members on our bridge)
  for c in $(DC ps -aq --filter "network=$R2_NET"); do
    log "rm network-attached container $c"; DC rm -f "$c" >/dev/null 2>&1 || true
  done

  log "== 3. network =="
  DC network rm "$R2_NET" >/dev/null 2>&1 && log "rm network $R2_NET" || log "network $R2_NET absent (ok)"

  log "== 4. scratch pg/redis =="
  for c in g2-scratch-pg g2-scratch-redis; do
    DC rm -f "$c" >/dev/null 2>&1 && log "rm $c" || log "$c absent (ok)"
  done

  log "== 5. dataDir root (alpine root shim) =="
  if [ -d "$R2_DATA_ROOT" ]; then
    local i
    for i in 1 2; do
      if [ -n "$(DC images -q alpine:3.20 2>/dev/null)" ]; then
        sg docker -c "docker run --rm -v $R2_DATA_ROOT:/wipe alpine:3.20 sh -c 'rm -rf /wipe/* /wipe/.[!.]* 2>/dev/null'" >/dev/null 2>&1 || true
      fi
      rm -rf "$R2_DATA_ROOT" 2>/dev/null || true
      [ ! -d "$R2_DATA_ROOT" ] && break
      [ "$i" = "1" ] && log "data root not empty after wipe pass 1 — retrying"
      sleep 2
    done
    rmdir "$R2_DATA_ROOT" 2>/dev/null || true
  fi

  log "== 6. verify zero residue =="
  local residue=0
  local n_cont
  n_cont=$(DC ps -aq --filter 'name=redroid-brb6g-' | wc -l | tr -d ' ')
  [ "$n_cont" != "0" ] && { log "RESIDUE: $n_cont redroid-brb6g-* containers"; residue=$((residue+n_cont)); }
  DC network inspect "$R2_NET" >/dev/null 2>&1 && { log "RESIDUE: network $R2_NET"; residue=$((residue+1)); }
  for c in g2-scratch-pg g2-scratch-redis; do
    DC inspect "$c" >/dev/null 2>&1 && { log "RESIDUE: $c"; residue=$((residue+1)); }
  done
  [ -d "$R2_DATA_ROOT" ] && { log "RESIDUE: $R2_DATA_ROOT still exists"; residue=$((residue+1)); }
  # ports: everything 16400-16499 must be free
  local ports
  ports=$(ss -tln 2>/dev/null | awk '{print $4}' | grep -oP '164[0-9]{2}\s*$' | sed 's/ //g' | sort -u)
  if [ -n "$ports" ]; then
    log "RESIDUE: 164xx still bound: $(echo $ports | tr '\n' ' ')"
    residue=$((residue+1))
  fi
  # scratch processes
  if [ -f "$R2_SCRATCH_STATE/api.pid" ] && kill -0 "$(cat "$R2_SCRATCH_STATE/api.pid")" 2>/dev/null; then
    log "RESIDUE: scratch api process alive"; residue=$((residue+1))
  fi
  if [ -f "$R2_SCRATCH_STATE/worker.pid" ] && kill -0 "$(cat "$R2_SCRATCH_STATE/worker.pid")" 2>/dev/null; then
    log "RESIDUE: scratch worker process alive"; residue=$((residue+1))
  fi

  if [ "$residue" = "0" ]; then
    log "TEARDOWN CLEAN: zero G2 residue (containers/network/ports/dataDir/processes)"
    return 0
  fi
  log "FATAL: residue remains: $residue"
  return 1
}

case "$SUBCMD" in
  teardown) cmd_teardown ;;
  *) echo "usage: $0 teardown" >&2; exit 2 ;;
esac

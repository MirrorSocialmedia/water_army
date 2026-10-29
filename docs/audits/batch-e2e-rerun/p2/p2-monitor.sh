#!/bin/bash
# WA-BATCH-E2E-RERUN P2 monitor: track the 3 batch runs, capture real ADB getprop
# during each run's live window, run 12/12 comparison. No intervention logic here.
# Env: RERUN_BID (batch id), RERUN_MON (monitor log file), RERUN_NAMES "r7 r8 r9"
# NOTE: no `set -u` (it has bitten twice — unbound-var crash kills capture windows).
set -o pipefail
cd /home/kenneth/.openclaw/workspace/water_army
P2=docs/audits/batch-e2e-rerun/p2
ADB=/home/kenneth/.openclaw/workspace/tools/platform-tools/adb
BID=${RERUN_BID:-}
[ -z "$BID" ] && { echo "FATAL: RERUN_BID unset"; exit 1; }
PSQL="docker exec water-army-postgres-1 psql -U app -d water_army -t -A"
MON=${RERUN_MON:-$P2/p2-03-monitor-all.txt}
NAMES=${RERUN_NAMES:-"r7 r8 r9"}
: > "$MON"
trap 'echo "$(date -u +%FT%TZ) MONITOR-ERR: $BASH_COMMAND (line $LINENO)" >> "$MON" 2>&1' ERR

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$MON"; }

declare -A TAG RUN CAP LASTLOG  # TAG[identity]=tag ; RUN[identity]=runId ; CAP[tag-attempt]=1
IDS=""
for TAG_ in $NAMES; do
  ID=$($PSQL -c "SELECT id FROM identities WHERE display_name='redroid-rdfa-$TAG_' LIMIT 1")
  if [ -z "$ID" ]; then log "FATAL: identity redroid-rdfa-$TAG_ not found"; exit 1; fi
  IDS="$IDS $ID"
  TAG[$ID]=$TAG_
done

for ID in $IDS; do
  RUN[$ID]=""
  for i in $(seq 1 60); do
    RUN[$ID]=$($PSQL -c "SELECT id FROM task_runs WHERE batch_id='$BID' AND identity_id='$ID' ORDER BY created_at LIMIT 1" 2>/dev/null)
    [ -n "$RUN[$ID]" ] && break
    sleep 0.5
  done
  [ -z "$RUN[$ID]" ] && log "WARN: no run row yet for ${TAG[$ID]} — will not track"
  log "run[${TAG[$ID]}] = $RUN[$ID]"
done

W0=$(date -u +%s)
log "monitor start t0=$W0 batch=$BID names=$NAMES"

capture() { # $1=identity $2=tag $3=attempt
  local ID=$1 TAG_=$2 ATT=$3
  local RID=${RUN[$ID]}
  local CTN PORT
  CTN=$($PSQL -c "SELECT container_id FROM task_runs WHERE id='$RID'")
  [ -z "$CTN" ] && { log "[$TAG_ a$ATT] no container_id yet — skip"; return 1; }
  PORT=$(docker inspect "$CTN" --format '{{(index .NetworkSettings.Ports "5555/tcp")}}' 2>/dev/null | head -1 | sed -E 's/.*:([0-9]+)\].*/\1/')
  if [ -z "$PORT" ]; then log "[$TAG_ a$ATT] no host port yet (ctn=$CTN)"; return 1; fi
  local F=$P2/p2-12-gt-$TAG_-a$ATT.txt
  local DUMP_ADB=$P2/p2-12-gt-$TAG_-a$ATT-props-adb.txt
  local DUMP_EXEC=$P2/p2-12-gt-$TAG_-a$ATT-props-exec.txt
  {
    echo "=== P2.3 ground-truth $TAG_ attempt $ATT @ $(date -u +%FT%TZ) (t+$(( $(date -u +%s) - W0 ))s) ==="
    echo "RUN=$RID  CTN=$CTN  PORT=$PORT"
    echo "--- run window (DB, at capture time) ---"
    $PSQL -c "SELECT started_at, finished_at, status, attempt FROM task_runs WHERE id='$RID'"
    echo "--- host ADB connect (product probe channel, 127.0.0.1:$PORT) ---"
    $ADB connect 127.0.0.1:$PORT
    sleep 2
    echo "--- boot_completed poll (host ADB) ---"
    local i bc
    for i in $(seq 1 60); do
      bc=$($ADB -s 127.0.0.1:$PORT shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | tr -d ' ')
      [ "$bc" = "1" ] && break
      sleep 2
    done
    echo "boot_completed=$bc after ~$((i*2))s"
    echo "--- getprop dump (host ADB) @ $(date -u +%FT%TZ) ---"
    $ADB -s 127.0.0.1:$PORT shell getprop > "$DUMP_ADB" 2>&1
    echo "adb props lines: $(wc -l < "$DUMP_ADB")"
    echo "--- getprop dump (docker exec, secondary channel) ---"
    docker exec "$CTN" getprop > "$DUMP_EXEC" 2>&1 || echo "exec dump failed"
    echo "exec props lines: $(wc -l < "$DUMP_EXEC")"
    echo "--- 12/12 + baseline (host ADB dump) ---"
    node $P2/p2-compare12.mjs "$DUMP_ADB" "$TAG_-a$ATT (host ADB)"
    local rc=$?
    echo "compare12 exit=$rc"
    echo "--- display (docker exec wm) ---"
    echo "size: $(docker exec "$CTN" wm size 2>/dev/null | tr -d '\r')  density: $(docker exec "$CTN" wm density 2>/dev/null | tr -d '\r')"
    echo "--- disconnect ---"
    $ADB disconnect 127.0.0.1:$PORT >/dev/null 2>&1
    echo "=== capture done $TAG_ a$ATT exit=$rc $(date -u +%FT%TZ) ==="
  } > "$F" 2>&1
  local rc=$?
  log "[$TAG_ a$ATT] capture done rc=$rc (file: $F)"
  grep -E "^=> " "$F" | tee -a "$MON"
}

END=$(( $(date -u +%s) + 2400 ))
while [ "$(date -u +%s)" -lt "$END" ]; do
  ALLTERM=1
  for ID in $IDS; do
    TAG_=${TAG[$ID]}
    RID=${RUN[$ID]:-}
    [ -z "$RID" ] && continue
    ROW=$($PSQL -c "SELECT status || '|' || attempt || '|' || COALESCE(container_id,'') FROM task_runs WHERE id='$RID'" 2>/dev/null)
    [ -z "$ROW" ] && continue
    ST=${ROW%%|*}; REST=${ROW#*|}
    ATT=$(echo "$REST" | cut -d'|' -f1)
    CTN=$(echo "$REST" | cut -d'|' -f2)
    line="$TAG_:$ST:a$ATT"
    if [ "${LASTLOG[$ID]:-}" != "$line" ]; then
      LASTLOG[$ID]=$line
      log "[$TAG_] $ST attempt=$ATT"
    fi
    case "$ST" in
      succeeded|failed_final|failed|cancelled|timed_out) ;;
      *) ALLTERM=0 ;;
    esac
    # capture when container is running and this attempt not yet captured
    if [ -z "${CAP[$TAG_-$ATT]:-}" ] && [ -n "$CTN" ] && [ "$(docker inspect "$CTN" --format '{{.State.Status}}' 2>/dev/null)" = "running" ]; then
      CAP[$TAG_-$ATT]=1  # mark immediately: one capture per attempt
      ( capture "$ID" "$TAG_" "$ATT" ) &
    fi
  done
  [ "$ALLTERM" = "1" ] && { log "ALL TERMINAL"; break; }
  sleep 3
done

log "monitor end $(date -u +%FT%TZ) (t+$(( $(date -u +%s) - W0 ))s)"
$PSQL -c "SELECT t2.display_name, r.status, r.attempt, r.error_code, r.started_at, r.finished_at, r.duration_ms, COALESCE(r.result_text,'') FROM task_runs r JOIN identities t2 ON t2.id=r.identity_id WHERE r.batch_id='$BID' ORDER BY t2.display_name" >> "$MON" 2>&1
log "final rows appended to $MON"
wait
log "captures drained"

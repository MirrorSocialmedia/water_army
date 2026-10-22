#!/usr/bin/env bash
# G2 Phase E.5 — REAL batch path: gate 503 (MAX_PARALLEL) -> worker RETRY_WAIT (pending kept)
# -> stop l1 -> delayed re-admit -> alpine container (identity volume /data) -> hold 60s -> in-container
# marker read -> success -> stop (lease released, volume kept).
set -uo pipefail
export SUBCMD="e5-batch"
. /home/kenneth/.openclaw/workspace/water_army/scripts/ramgate-g2/common.sh
E=/home/kenneth/.openclaw/workspace/logs/ramgate-g2/e2e
mkdir -p "$E"
IID=$(awk -F= '/^identity_id=/{print $2}' "$E/e2-identity-ids.txt" | tr -d '[:space:]')
IDR=/home/kenneth/.openclaw/workspace/.g2-scratch-identity-data
DATAPATH="$IDR/$IID/data"
say() { log "E5 $*"; }
db() { docker exec -i g2-scratch-pg psql -U postgres -d water_army_g2 -tAc "$1" 2>&1; }
TS=$(date -u +%FT%TZ)
FAIL=0

# ---- 0: pre-state ----
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e5-gate-pre.json"
say "pre: $(jq -c '{liveLeases:.counts.liveLeases, wouldAdmitNext:{a:.wouldAdmitNext.admitted, r:.wouldAdmitNext.reason}}' "$E/e5-gate-pre.json")"

# ---- 1: identity volume marker (host side) ----
mkdir -p "$DATAPATH" && chmod 700 "$DATAPATH"
MARKER=".g2-e2e-identity-marker"
MARKER_CONTENT="$IID identity-volume-marker $TS"
printf '%s\n' "$MARKER_CONTENT" > "$DATAPATH/$MARKER"
{ echo "marker_content=$MARKER_CONTENT"; ls -la "$DATAPATH"; } > "$E/e5-marker-write.txt"
say "identity marker written (kenneth-owned)"

# ---- 2: preview (dry run) ----
say "preview"
api POST '/api/batches/preview' "{\"identities\":[\"$IID\"],\"batchSize\":1,\"maxActiveContainers\":1,\"failurePolicy\":\"continue_and_report\",\"config\":{\"adapter\":{\"type\":\"container\",\"image\":\"alpine:3.20\",\"health\":{\"kind\":\"none\"},\"work\":{\"kind\":\"hold\",\"durationMs\":60000}}}}" >/dev/null 2>&1
{ echo "$API_BODY"; echo "http=$API_CODE"; } > "$E/e5-preview.json"
[ "$API_CODE" = "200" ] || { say "FATAL preview http=$API_CODE"; cat "$E/e5-preview.json"; exit 1; }

# ---- 3: create batch ----
say "create batch"
api POST '/api/batches' "{\"name\":\"g2e2e-batch-1\",\"idempotencyKey\":\"g2e2e-batch-0001\",\"identities\":[\"$IID\"],\"batchSize\":1,\"maxActiveContainers\":1,\"failurePolicy\":\"continue_and_report\",\"config\":{\"adapter\":{\"type\":\"container\",\"image\":\"alpine:3.20\",\"health\":{\"kind\":\"none\"},\"work\":{\"kind\":\"hold\",\"durationMs\":60000}}}}" >/dev/null 2>&1
{ echo "$API_BODY"; echo "http=$API_CODE"; } > "$E/e5-create.json"
[ "$API_CODE" = "201" ] || { say "FATAL create http=$API_CODE"; cat "$E/e5-create.json"; exit 1; }
BID=$(jq -r '.batch.id // empty' "$E/e5-create.json")
[ -n "$BID" ] || { say "FATAL no batch id"; exit 1; }
say "batch created id=$BID"

# ---- 4: start batch ----
say "start batch"
api POST "/api/batches/$BID/start" '{}' >/dev/null 2>&1
{ echo "$API_BODY"; echo "http=$API_CODE"; } > "$E/e5-start.json"
[ "$API_CODE" = "202" ] || [ "$API_CODE" = "200" ] || { say "FATAL start http=$API_CODE"; cat "$E/e5-start.json"; exit 1; }

# ---- 5: wait for attempt-1 gate 503 (RETRY_WAIT) ----
say "wait attempt-1 RAM gate 503 (poll 30s)"
for i in $(seq 1 30); do
  ROW=$(db "SELECT status, attempt, error_code FROM task_runs WHERE batch_id='$BID' ORDER BY attempt DESC LIMIT 1")
  echo "$ROW" | grep -q 'RAM_GATE_DENIED' && break
  sleep 1
done
{
  echo "== task_runs after attempt-1 (expect failed / RAM_GATE_DENIED)"
  db "SELECT id, status, attempt, error_code, error_message, started_at, finished_at FROM task_runs WHERE batch_id='$BID' ORDER BY attempt"
  echo "== batch row"
  db "SELECT id, status, cycle_id FROM batches WHERE id='$BID'"
  echo "== identity status"
  db "SELECT id, status FROM identities WHERE id='$IID'"
  echo "== audit start_denied_ram"
  db "SELECT created_at, action, status, details_json::text FROM audit_events WHERE action='batch_container.start_denied_ram' ORDER BY created_at DESC LIMIT 3"
} > "$E/e5-attempt1-evidence.txt" 2>&1
grep -q 'RAM_GATE_DENIED' "$E/e5-attempt1-evidence.txt" && say "attempt-1 RAM_GATE_DENIED captured" || { say "FATAL no RAM_GATE_DENIED in attempt-1"; FAIL=1; }
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e5-gate-attempt1.json"
{ echo "== worker log (503/RETRY lines)"; grep -E 'RAM_GATE|RETRY|503|retry' "$E/e5-worker2.log" | tail -12; } > "$E/e5-attempt1-worker-log.txt"
api GET "/api/identities/$IID" >/dev/null 2>&1 && echo "$API_BODY" > "$E/e5-identity-attempt1.json"

# ---- 6: stop l1 to free one slot ----
say "stop l1 (free a slot)"
api POST '/api/devices/redroid/redroid-brb6g-l1/stop' '{}' >/dev/null 2>&1
{ echo "$API_BODY"; echo "http=$API_CODE"; } > "$E/e5-l1-stop.json"
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e5-gate-after-l1stop.json"
say "l1 stopped: $(jq -c '{liveLeases:.counts.liveLeases}' "$E/e5-gate-after-l1stop.json" 2>/dev/null)"

# ---- 7: wait for attempt-2 container RUNNING (delayed 10s + create + start) ----
say "wait attempt-2 container running (poll 120s)"
CNAME=""
for i in $(seq 1 120); do
  CNAME=$(docker ps --filter 'name=wa-batch-' --format '{{.Names}}' | head -1)
  [ -n "$CNAME" ] && break
  sleep 1
done
[ -n "$CNAME" ] || { say "FATAL no wa-batch container after 120s"; FAIL=1; }
say "container running: $CNAME"
CID=$(docker inspect -f '{{.Id}}' "$CNAME")
P=$(docker inspect -f '{{(index .Config.ExposedPorts | split " " | first).HostPort}}' "$CNAME" 2>/dev/null || true)
[ -z "$P" ] && P=$(docker inspect -f '{{range $p, $cfg := .NetworkSettings.Ports}}{{$cfg}} {{end}}' "$CNAME")
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e5-gate-attempt2.json"
say "attempt-2 gate: $(jq -c '{liveLeases:.counts.liveLeases, reservedMiB:.counts.reservedMiB}' "$E/e5-gate-attempt2.json" 2>/dev/null)"

# ---- 8: in-container evidence (identity volume mounted at /data) ----
{
  echo "== docker inspect Mounts"
  docker inspect -f '{{json .HostConfig.Mounts}}' "$CNAME"
  echo "== docker exec cat /data/$MARKER"
  docker exec "$CNAME" sh -c "cat /data/$MARKER" 2>&1
  echo "expected=$MARKER_CONTENT"
  echo "== container name/port"
  echo "name=$CNAME port=$P id=$CID"
} > "$E/e5-incontainer-evidence.txt" 2>&1
docker exec "$CNAME" sh -c "cat /data/$MARKER" 2>/dev/null | tr -d '\r' | grep -q "^$IID " && say "in-container marker MATCH (identity volume live-mounted)" || say "WARN in-container marker mismatch"

# ---- 9: wait hold end (60s) -> stop -> run terminal ----
say "wait hold end + run terminal (poll 120s)"
for i in $(seq 1 120); do
  ROW=$(db "SELECT status FROM task_runs WHERE batch_id='$BID' ORDER BY attempt DESC LIMIT 1")
  case "$ROW" in succeeded|failed|cancelled|timed_out|skipped) break;; esac
  sleep 1
done
{
  echo "== task_runs final"
  db "SELECT id, status, attempt, started_at, finished_at, error_code, error_message FROM task_runs WHERE batch_id='$BID' ORDER BY attempt"
  echo "== batch final"
  db "SELECT id, status, cycle_id FROM batches WHERE id='$BID'"
  echo "== identity final"
  db "SELECT id, status FROM identities WHERE id='$IID'"
  echo "== audit started/stopped"
  db "SELECT created_at, action, status, details_json::text FROM audit_events WHERE action IN ('batch_container.started','batch_container.stopped') ORDER BY created_at DESC LIMIT 6"
  echo "== container state after run"
  docker inspect -f '{{.State.Status}}' "$CNAME" 2>&1
} > "$E/e5-final-state.txt" 2>&1
cat "$E/e5-final-state.txt"

# ---- 10: restart l1 (restore fleet) + gate final ----
say "restart l1"
api POST '/api/devices/redroid/redroid-brb6g-l1/start' '{}' >/dev/null 2>&1
{ echo "$API_BODY"; echo "http=$API_CODE"; } > "$E/e5-l1-start.json"
sleep 5
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e5-gate-final.json"
say "final gate: $(jq -c '{liveLeases:.counts.liveLeases, wouldAdmitNext:{a:.wouldAdmitNext.admitted, r:.wouldAdmitNext.reason}}' "$E/e5-gate-final.json" 2>/dev/null)"
say "E5 DONE fail=$FAIL"
exit "$FAIL"

#!/usr/bin/env bash
# WA-REALDEVICE-FINAL P2 v8 orchestrator — gen2. Single shot, no re-entry.
#
# Design (from code reading, not guesswork):
#  - container adapter: start(=create/adopt + engine start + ADB health wait,
#    API-side window now 300s via BATCH_CONTAINER_HEALTH_TIMEOUT_MS) ->
#    hold 1500ms (CONTAINER_ADAPTER_HOLD_MS default) -> stop -> success.
#  - waitHealthy FAILS FAST if the container exits mid-boot (state poll 1s).
#  - attempt-2 sweep ADOPTS the prior container (same name wa-batch-<run>-a1)
#    and re-starts it — detection = state exited -> running (NOT a new name).
#  - engine auto-retry delay = batchRetryDelayMs (default 0) -> next tick.
#  - GT: egress is container-level (netns up at container start, before
#    Android boot) so it runs FIRST; props need boot_completed.
#  - host adb burst = best-effort (product stop follows health by 1.5s).
set -u
cd /home/kenneth/.openclaw/workspace/water_army
A=/home/kenneth/.openclaw/workspace/tools/platform-tools/adb
C=/tmp/rdfa-cookies.txt
GT=logs/realdevice-final/p2
PSQL="docker exec water-army-postgres-1 psql -U app -d water_army -t -A -F \$'\t'"
BID="$1"
I02=8cc54fa8-27ec-406e-b7f7-3133c15b18be
I03=f16ef586-f38f-4d20-a464-7187876e4205
I04=9823ddf2-0e3e-4375-96cc-400f9d3b3dbd
W=$(date -u +%s)

echo "=== v8 window open $(date -u +%FT%TZ) (t0=$W, BID=$BID) ===" | tee $GT/p2-43-v8-window.txt

# ---------------------------------------------------------------- 1) 3 containers
N=0
for i in $(seq 1 96); do
  N=$(docker ps --filter name=wa-batch- --format '{{.Names}}' | grep -c . || true)
  [ "$N" -ge 3 ] && break
  sleep 5
done
t1=$(( $(date -u +%s) - W ))
{
echo "--- 3-container check @ t+${t1}s (running=$N) ---"
docker ps --filter name=wa-batch- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "--- RAM gate @ t+${t1}s (baseline liveCount=2, expect +3 => 5) ---"
curl -s -b $C http://127.0.0.1:3012/api/system/ram-gate | python3 -c "import json,sys; d=json.load(sys.stdin); w=d.get('wouldAdmitNext') or {}; m=d.get('metrics') or {}; print(json.dumps({'liveCount':w.get('liveCount'),'admitted':w.get('admitted'),'memAvailableMiB':m.get('memAvailableMiB')}, indent=1))" 2>/dev/null
echo "--- run<->container map (after DB bind) ---"
$PSQL -c "SELECT left(r.id::text,8), left(r.identity_id::text,8), r.container_id, r.status, r.attempt, r.queued_at, r.started_at FROM task_runs r WHERE r.batch_id='$BID' ORDER BY r.identity_id;" 2>&1
} >> $GT/p2-43-v8-window.txt 2>&1

declare -A CTR PORT
mapfile -t ROWS < <($PSQL -c "SELECT r.container_id, left(r.identity_id::text,8) FROM task_runs r WHERE r.batch_id='$BID' AND r.container_id IS NOT NULL ORDER BY r.identity_id;" 2>/dev/null)
for row in "${ROWS[@]}"; do
  CID=${row%%$'\t'*}; tag=${row#*$'\t'}
  NM=$(docker inspect "$CID" --format '{{.Name}}' 2>/dev/null | sed 's|/||')
  PT=$(docker inspect "$CID" --format '{{(index .HostConfig.PortBindings "5555/tcp")}}' 2>/dev/null | tr -dc '0-9')
  case $tag in
    8cc54fa8) CTR[02]=$NM; PORT[02]=$PT;;
    f16ef586) CTR[03]=$NM; PORT[03]=$PT;;
    9823ddf2) CTR[04]=$NM; PORT[04]=$PT;;
  esac
  echo "map: $tag -> $NM port $PT" >> $GT/p2-43-v8-window.txt
done
echo "CTR02=${CTR[02]:-?} CTR03=${CTR[03]:-?} CTR04=${CTR[04]:-?} (ports ${PORT[02]:-?}/${PORT[03]:-?}/${PORT[04]:-?})" | tee -a $GT/p2-43-v8-window.txt

# ---------------------------------------------------------------- 2) ground truth fn
gt_machine() { # $1=container  $2=host-port  $3=tag
  local NM=$1 PT=$2 TAG=$3 F=$GT/p2-45-groundtruth-$TAG.txt
  {
    echo "=== ground truth $TAG ($NM @ $PT) === $(date -u +%FT%TZ) (window t0=$W)"
    echo "--- [1] egress e2e via gost:18443 (container-level; netns live from container start, P1-verified method p1-16) ---"
    docker exec "$NM" sh -c "ip route add 172.38.223.1/32 via 172.38.200.1 2>&1 || echo route-exists"
    docker exec "$NM" sh -c "echo -e 'GET http://api.ipify.org HTTP/1.0\r\nHost: api.ipify.org\r\nProxy-Connection: close\r\n\r\n' | nc -w 8 172.38.223.1 18443" 2>&1 | tail -4
    docker exec "$NM" sh -c "ip route del 172.38.223.1/32 2>&1 || echo route-already-gone" 2>/dev/null
    echo "--- [2] wait for Android boot (docker exec getprop, 2s poll, up to 6min) ---"
    local BC="" i ST
    for i in $(seq 1 180); do
      ST=$(docker inspect "$NM" --format '{{.State.Status}}' 2>/dev/null)
      [ "$ST" != "running" ] && { echo "container no longer running (state=$ST) at ~t+$((i*2))s — window closed before boot"; break; }
      BC=$(docker exec "$NM" getprop sys.boot_completed 2>/dev/null | tr -d '\r')
      [ "$BC" = "1" ] && { echo "boot_completed=1 at ~t+$((i*2))s"; break; }
      sleep 2
    done
    if [ "$BC" = "1" ]; then
      echo "--- [3] getprop full dump (docker exec) -> p2-45-groundtruth-$TAG-props.txt ---"
      docker exec "$NM" getprop > $GT/p2-45-groundtruth-$TAG-props.txt 2>&1 || echo "getprop dump failed (window closed)"
      echo "props lines: $(wc -l < $GT/p2-45-groundtruth-$TAG-props.txt 2>/dev/null || echo 0)"
      echo "--- [4] key props ---"
      docker exec "$NM" getprop 2>/dev/null | grep -E "sys.boot_completed|ro.product.(brand|model|device)|ro.build.(id|fingerprint)|ro.hardware" | head -10
      echo "--- [5] display ---"
      echo "size: $(docker exec "$NM" wm size 2>/dev/null | tr -d '\r')  density: $(docker exec "$NM" wm density 2>/dev/null | tr -d '\r')"
    else
      echo "boot_completed never observed before window closed — props NOT captured (honest)"
    fi
    echo "--- [6] best-effort host adb burst (127.0.0.1:$PT; product stops ~1.5s after ADB health) ---"
    if [ -n "$PT" ]; then
      if $A connect 127.0.0.1:$PT >/dev/null 2>&1; then
        sleep 1
        if $A -s 127.0.0.1:$PT shell getprop sys.boot_completed >/dev/null 2>&1; then
          echo "adb CONNECTED (host channel live)"
          $A -s 127.0.0.1:$PT shell getprop > $GT/p2-45-groundtruth-$TAG-props-adb.txt 2>&1
          echo "adb props lines: $(wc -l < $GT/p2-45-groundtruth-$TAG-props-adb.txt)"
          $A -s 127.0.0.1:$PT disconnect >/dev/null 2>&1
        else
          echo "adb: port answered but shell not ready (window too narrow)"
        fi
      else
        echo "adb connect refused (host-channel window missed — docker-exec channel is primary)"
      fi
    fi
    echo "=== done $TAG $(date -u +%FT%TZ) ==="
  } > $F 2>&1
}

# ---------------------------------------------------------------- 3) GT 03/04 FIRST (tightest window)
gt_machine "${CTR[03]:-}" "${PORT[03]:-}" 03 &
G3=$!
gt_machine "${CTR[04]:-}" "${PORT[04]:-}" 04 &
G4=$!

# ---------------------------------------------------------------- 4) intervention 02 (open -> badge+1 -> ack -> stop -> retry resume)
RUN02=$($PSQL -c "SELECT id FROM task_runs WHERE batch_id='$BID' AND identity_id='$I02' ORDER BY created_at LIMIT 1;" 2>/dev/null)
{
echo "=== P2.5 intervention 02 (v8) @ $(date -u +%FT%TZ) (t+$(( $(date -u +%s) - W ))s) ==="
echo "RUN02=$RUN02"
echo "CTR02=${CTR[02]:-?} state=$(docker inspect "${CTR[02]:-none}" --format '{{.State.Status}}' 2>/dev/null)"
echo "--- badge BEFORE ---"; curl -s -b $C http://127.0.0.1:3012/api/manual-interventions/needs-attention-count; echo
curl -s -o /tmp/iv8.json -w "create HTTP_STATUS=%{http_code}\n" -b $C -X POST http://127.0.0.1:3012/api/manual-interventions -H 'Content-Type: application/json' -d "{
  \"source\": \"operator_report\",
  \"category\": \"DEVICE_OFFLINE\",
  \"severity\": \"high\",
  \"deviceNameSnapshot\": \"redroid-rdfa-02\",
  \"title\": \"batch WA-RDFA-P2-final-v8: identity 02 container stopped mid-boot (operator intervention — real stuck event)\",
  \"summary\": \"Operator stopped 02's attempt-1 container during boot (docker stop -t 2, real event) to exercise the full loop: open -> badge+1 -> ack -> engine auto-retry (attempt 2 adopts + re-starts) -> run completes -> resolve.\",
  \"evidence\": {\"batchId\": \"$BID\", \"taskRunId\": \"$RUN02\", \"container\": \"${CTR[02]:-unknown}\"},
  \"automationDisposition\": \"blocked_pending_review\"
}"
IV8=$(python3 -c "import json;print(json.load(open('/tmp/iv8.json'))['intervention']['id'])" 2>/dev/null)
echo "IV8=$IV8"
echo "--- badge AFTER create (expect +1) ---"; curl -s -b $C http://127.0.0.1:3012/api/manual-interventions/needs-attention-count; echo
echo "--- console ack (UI flow parity) ---"
curl -s -o /tmp/iv8ack.json -w "ack HTTP_STATUS=%{http_code}\n" -b $C -X POST http://127.0.0.1:3012/api/manual-interventions/$IV8/acknowledge
echo "--- REAL STUCK EVENT: docker stop -t 2 ${CTR[02]:-none} @ $(date -u +%FT%TZ) (t+$(( $(date -u +%s) - W ))s) ---"
docker stop -t 2 "${CTR[02]:-none}" 2>&1
echo "stop_exit=$?"
echo "container state after stop: $(docker inspect "${CTR[02]:-none}" --format '{{.State.Status}} (exit={{.State.ExitCode}})' 2>/dev/null)"
} > $GT/p2-44-intervention-02-v8.txt 2>&1
echo "IV8=$IV8" > /tmp/v8-iv8-state

# ---------------------------------------------------------------- 5) 02 attempt-2 (adopt re-start of the SAME container name)
C2="${CTR[02]:-}"
G2=""
if [ -n "$C2" ]; then
  for i in $(seq 1 240); do
    ST2=$(docker inspect "$C2" --format '{{.State.Status}}' 2>/dev/null)
    RST=$($PSQL -c "SELECT status FROM task_runs WHERE id='$RUN02';" 2>/dev/null)
    if [ "$ST2" = "running" ]; then break; fi
    case "$RST" in
      succeeded|failed|cancelled) echo "02 run terminal BEFORE attempt-2 window (status=$RST) — intervention raced a fast boot; recorded honestly" >> $GT/p2-44-intervention-02-v8.txt; ST2="terminal:$RST"; break;;
    esac
    sleep 2
  done
  {
  echo "--- 02 attempt-2 state @ $(date -u +%FT%TZ) ---"
  echo "container $C2 state=$ST2"
  docker ps --filter name=wa-batch- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  $PSQL -c "SELECT left(id::text,8), status, attempt, started_at, finished_at FROM task_runs WHERE batch_id='$BID' ORDER BY left(identity_id::text,8);" 2>&1
  } >> $GT/p2-44-intervention-02-v8.txt 2>&1
  if [ "$ST2" = "running" ]; then
    P2PT=$(docker inspect "$C2" --format '{{(index .HostConfig.PortBindings "5555/tcp")}}' 2>/dev/null | tr -dc '0-9')
    gt_machine "$C2" "$P2PT" 02-retry &
    G2=$!
  fi
fi

wait $G3 $G4 ${G2:-} 2>/dev/null

# ---------------------------------------------------------------- 6) all runs terminal (up to 8 min)
for i in $(seq 1 96); do
  ACTIVE=$($PSQL -c "SELECT count(*) FROM task_runs WHERE batch_id='$BID' AND status IN ('queued','running','retry_wait');" 2>/dev/null)
  [ "${ACTIVE:-0}" = "0" ] && break
  sleep 5
done
{
echo "=== P2.6 final state @ $(date -u +%FT%TZ) (t+$(( $(date -u +%s) - W ))s) ==="
echo "--- runs ---"
docker exec water-army-postgres-1 psql -U app -d water_army -c "SELECT left(identity_id::text,8) iid, status, attempt, error_code, left(result_text,80) AS result, started_at, finished_at FROM task_runs WHERE batch_id='$BID' ORDER BY left(identity_id::text,8);" 2>&1
echo "--- batch ---"
docker exec water-army-postgres-1 psql -U app -d water_army -c "SELECT id, status, started_at, finished_at FROM batches WHERE id='$BID';" 2>&1
echo "--- identities ---"
docker exec water-army-postgres-1 psql -U app -d water_army -c "SELECT display_name, status FROM identities WHERE id IN ('$I02','$I03','$I04') ORDER BY display_name;" 2>&1
echo "--- docker ps (residual wa-batch running) ---"
docker ps --filter name=wa-batch- --format 'table {{.Names}}\t{{.Status}}'
echo "--- docker ps -a (wa-batch all) ---"
docker ps -a --filter name=wa-batch- --format 'table {{.Names}}\t{{.Status}}'
echo "--- RAM gate after (expect liveCount back to 2) ---"
curl -s -b $C http://127.0.0.1:3012/api/system/ram-gate | python3 -c "import json,sys; d=json.load(sys.stdin); w=d.get('wouldAdmitNext') or {}; m=d.get('metrics') or {}; print(json.dumps({'liveCount':w.get('liveCount'),'memAvailableMiB':m.get('memAvailableMiB')}, indent=1))" 2>/dev/null
echo "--- needs-attention badge (expect still 1: IV8 open, resolved in step 7) ---"
curl -s -b $C http://127.0.0.1:3012/api/manual-interventions/needs-attention-count; echo
echo "=== orchestrator done $(date -u +%FT%TZ) ==="
} >> $GT/p2-43-v8-window.txt 2>&1
exit 0

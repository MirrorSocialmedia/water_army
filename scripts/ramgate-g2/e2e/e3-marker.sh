#!/usr/bin/env bash
# G2 Phase E.3 — marker file E2E on l10 (device dataDir persistence across stop/delete/recreate)
#   stop l10 -> dataDir kept -> alpine writes marker (root-owned) -> delete (no removeData) ->
#   dataDir kept -> recreate same name (same dataDir) -> boot -> adb cat marker -> cross-isolation vs l9
set -uo pipefail
export SUBCMD="e3-marker"
. /home/kenneth/.openclaw/workspace/water_army/scripts/ramgate-g2/common.sh
E=/home/kenneth/.openclaw/workspace/logs/ramgate-g2/e2e
mkdir -p "$E"
IID=$(awk '/^identity_id=/{print $2}' "$E/e2-identity-ids.txt")
D10=/var/lib/water-army/redroid-ramgate-g2/redroid-brb6g-l10
D9=/var/lib/water-army/redroid-ramgate-g2/redroid-brb6g-l9
MARKER10=/data/.g2-e2e-marker-l10
MARKER9=/data/.g2-e2e-marker-l9
ADB="$R2_ADB"
TS=$(date -u +%FT%TZ)
FAIL=0
say() { log "E3 $*"; }
snap_datadir() { # $1=label $2=dir
  { echo "== $1 $(date -u +%FT%TZ)"; ls -la "$2" 2>&1 | head -40
    echo "file_count=$(find "$2" -type f 2>/dev/null | wc -l)"
    echo "total_bytes=$(du -sb "$2" 2>/dev/null | cut -f1)"; } > "$E/e3-$1.txt" 2>&1
}
api_get() { api GET "$1" >/dev/null && printf '%s' "$API_BODY"; }

# ---- step 1: baseline snapshot (l10 running) ----
say "step1 baseline dataDir l10"
snap_datadir "l10-before" "$D10"

# ---- step 2: stop l10 via product API ----
say "step2 stop l10"
api POST "/api/devices/redroid/redroid-brb6g-l10/stop" '{}' >/dev/null 2>&1
code=$API_CODE
{ echo "$API_BODY"; echo "http=$code"; } > "$E/e3-l10-stop-http.txt"
[ "$code" = "200" ] || [ "$code" = "202" ] || { say "FATAL stop rc=$code"; exit 1; }
# wait container exited
for i in $(seq 1 60); do
  st=$(docker inspect -f '{{.State.Status}}' redroid-brb6g-l10 2>/dev/null || echo gone)
  [ "$st" = "exited" ] && break; sleep 2
done
echo "container_state=$st" | tee -a "$E/e3-l10-stop-http.txt"
say "step2 gate status after stop (expect 9 live leases)"
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e3-gate-after-stop-l10.json"
snap_datadir "l10-after-stop" "$D10"

# ---- step 3: write marker into l10 dataDir (alpine, root-owned file) ----
say "step3 alpine write marker l10"
MARKER_CONTENT="$IID $TS"
docker run --rm -v "$D10:/s" alpine:3.20 sh -c "printf '%s\n' '$MARKER_CONTENT' > /s/.g2-e2e-marker-l10 && ls -la /s/.g2-e2e-marker-l10" | tee "$E/e3-l10-marker-write.txt"
echo "expected_marker_content=$MARKER_CONTENT" > "$E/e3-l10-marker-expected.txt"
cat "$D10/.g2-e2e-marker-l10" >> "$E/e3-l10-marker-write.txt"
stat -c 'owner=%U:%G mode=%a' "$D10/.g2-e2e-marker-l10" >> "$E/e3-l10-marker-write.txt"

# ---- step 4: DELETE l10 (no removeData) ----
say "step4 delete l10 (removeData=false)"
api DELETE "/api/devices/redroid/redroid-brb6g-l10" '{"confirm":"redroid-brb6g-l10"}' >/dev/null 2>&1
code=$API_CODE
{ echo "$API_BODY"; echo "http=$code"; } > "$E/e3-l10-delete-http.txt"
[ "$code" = "200" ] || { say "FATAL delete rc=$code"; exit 1; }
snap_datadir "l10-after-delete" "$D10"
[ -f "$D10/.g2-e2e-marker-l10" ] && say "step4 marker still present after delete (product design)" || { say "FATAL marker lost after delete"; FAIL=1; }

# ---- step 5: recreate l10 (same name -> same dataDir; gate must ADMIT 9->10) ----
say "step5 recreate l10"
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e3-gate-pre-recreate.json"
KEY="g2e2e-l10-$(date -u +%s)"
api POST "/api/devices/redroid" "{\"name\":\"redroid-brb6g-l10\",\"templateName\":\"$R2_TEMPLATE_NAME\",\"idempotencyKey\":\"$KEY\"}" >/dev/null 2>&1
code=$API_CODE
[ "$code" = "201" ] || { say "FATAL recreate rc=$code"; echo "$API_BODY" | head -c 400 > "$E/e3-l10-recreate-http$code.json"; exit 1; }
echo "$API_BODY" > "$E/e3-l10-recreate-http201.json"
PORT=$(jq -r '.device.adbPort // empty' "$E/e3-l10-recreate-http201.json")
[ -n "$PORT" ] || { say "FATAL no adbPort in response"; exit 1; }
say "step5 recreate OK adbPort=$PORT (expect 16409; task said 16410 — actual recorded)"
echo "recreate_adb_port=$PORT" > "$E/e3-l10-recreate-port.txt"
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e3-gate-after-recreate.json"

# ---- step 6: boot wait (adb device + boot_completed; max 25 min) ----
say "step6 boot wait (max 25min)"
: > "$E/e3-l10-boot.log"
"$ADB" connect "127.0.0.1:$PORT" >> "$E/e3-l10-boot.log" 2>&1
"$ADB" -s "127.0.0.1:$PORT" wait-for-device >> "$E/e3-l10-boot.log" 2>&1
for i in $(seq 1 150); do
  bc=$("$ADB" -s "127.0.0.1:$PORT" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$bc" = "1" ] && break
  sleep 10
done
{ echo "boot_completed=$bc after ~$((i*10))s"; date -u +%FT%TZ; } | tee -a "$E/e3-l10-boot.log"
[ "$bc" = "1" ] || say "WARN boot_completed not 1 after 25min (continuing; data partition may still be readable)"
api POST "/api/devices/redroid/redroid-brb6g-l10/refresh" '{}' >/dev/null 2>&1 || true

# ---- step 7: read marker via adb (real Android-side filesystem evidence) ----
say "step7 adb cat marker l10"
{ echo "== adb shell ls /data (head)"; "$ADB" -s "127.0.0.1:$PORT" shell ls -la /data 2>&1 | head -15
  echo "== adb shell cat $MARKER10"; "$ADB" -s "127.0.0.1:$PORT" shell cat "$MARKER10" 2>&1; } > "$E/e3-l10-marker-read.txt" 2>&1
GOT=$("$ADB" -s "127.0.0.1:$PORT" shell cat "$MARKER10" 2>/dev/null | tr -d '\r')
echo "got=$GOT" >> "$E/e3-l10-marker-read.txt"
[ "$GOT" = "$MARKER_CONTENT" ] && say "step7 MARKER MATCH (identity id present, exact content)" || say "step7 MARKER MISMATCH"

# ---- step 8: cross-isolation with l9 ----
say "step8 cross-isolation l9 (adb 16408)"
MARKER9_CONTENT="l9-isolation-marker $IID-iso $TS"
docker run --rm -v "$D9:/s" alpine:3.20 sh -c "printf '%s\n' '$MARKER9_CONTENT' > /s/.g2-e2e-marker-l9 && ls -la /s/.g2-e2e-marker-l9" | tee "$E/e3-l9-marker-write.txt"
{ echo "== l9 reads own marker"; "$ADB" -s 127.0.0.1:16408 shell cat "$MARKER9" 2>&1
  echo "== l10 tries l9 marker (expect no such file)"; "$ADB" -s "127.0.0.1:$PORT" shell cat "$MARKER9" 2>&1
  echo "== l9 tries l10 marker (expect no such file)"; "$ADB" -s 127.0.0.1:16408 shell cat "$MARKER10" 2>&1; } > "$E/e3-cross-isolation.txt" 2>&1

# ---- step 9: removeData EACCES repro on l9 (E.4) ----
say "step9 removeData=true on l9 (expect perm-denied class, data kept)"
api DELETE "/api/devices/redroid/redroid-brb6g-l9" '{"confirm":"redroid-brb6g-l9","removeData":true}' >/dev/null 2>&1
code=$API_CODE
{ echo "$API_BODY"; echo "http=$code"; } > "$E/e3-l9-delete-removedata-http.txt"
{ echo "== l9 dataDir after removeData=true delete"; ls -la "$D9" 2>&1 | head -10; echo "marker9_present=$([ -f "$D9/.g2-e2e-marker-l9" ] && echo yes || echo no)"; } > "$E/e3-l9-after-removedata.txt" 2>&1
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e3-gate-after-l9-delete.json"

# ---- step 10: recreate l9 (restore 10-device fleet for teardown; no boot wait) ----
say "step10 recreate l9 (fleet restore)"
KEY9="g2e2e-l9-$(date -u +%s)"
api POST "/api/devices/redroid" "{\"name\":\"redroid-brb6g-l9\",\"templateName\":\"$R2_TEMPLATE_NAME\",\"idempotencyKey\":\"$KEY9\"}" >/dev/null 2>&1
code=$API_CODE
[ "$code" = "201" ] || say "WARN l9 recreate rc=$code"
{ echo "$API_BODY"; echo "http=$code"; } > "$E/e3-l9-recreate-http.json"
echo "l9_recreate_http=$code" > "$E/e3-l9-recreate-port.txt"
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e3-gate-final.json"

say "E3 DONE fail=$FAIL"
exit "$FAIL"

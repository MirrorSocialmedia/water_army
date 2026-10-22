#!/usr/bin/env bash
# G2 Phase E.3b — redo markers WITH identity id (pass-1 awk bug: $2 on 'k=v' line) + full cross-isolation
set -uo pipefail
export SUBCMD="e3b-marker"
. /home/kenneth/.openclaw/workspace/water_army/scripts/ramgate-g2/common.sh
E=/home/kenneth/.openclaw/workspace/logs/ramgate-g2/e2e
mkdir -p "$E"
IID=$(awk -F= '/^identity_id=/{print $2}' "$E/e2-identity-ids.txt" | tr -d '[:space:]')
[ -n "$IID" ] || { log "FATAL: no IID"; exit 1; }
D10=/var/lib/water-army/redroid-ramgate-g2/redroid-brb6g-l10
D9=/var/lib/water-army/redroid-ramgate-g2/redroid-brb6g-l9
ADB="$R2_ADB"
say() { log "E3b $*"; }

# ---- stop l10 (running, port 16409) ----
say "stop l10"
api POST "/api/devices/redroid/redroid-brb6g-l10/stop" '{}' >/dev/null 2>&1
{ echo "$API_BODY"; echo "http=$API_CODE"; } > "$E/e3b-l10-stop-http.txt"
for i in $(seq 1 60); do st=$(docker inspect -f '{{.State.Status}}' redroid-brb6g-l10 2>/dev/null || echo gone); [ "$st" = "exited" ] && break; sleep 2; done
echo "container_state=$st" | tee -a "$E/e3b-l10-stop-http.txt"

# ---- rewrite l10 marker WITH identity id ----
TS=$(date -u +%FT%TZ)
M10="$IID $TS"
say "write l10 marker v2 (with identity id)"
docker run --rm -v "$D10:/s" alpine:3.20 sh -c "printf '%s\n' '$M10' > /s/.g2-e2e-marker-l10 && ls -la /s/.g2-e2e-marker-l10" | tee "$E/e3b-l10-marker-write.txt"
{ echo "expected=$M10"; cat "$D10/.g2-e2e-marker-l10"; } >> "$E/e3b-l10-marker-write.txt"

# ---- start l10 + boot wait ----
say "start l10"
api POST "/api/devices/redroid/redroid-brb6g-l10/start" '{}' >/dev/null 2>&1
{ echo "$API_BODY"; echo "http=$API_CODE"; } > "$E/e3b-l10-start-http.txt"
"$ADB" connect 127.0.0.1:16409 >> "$E/e3b-l10-boot.log" 2>&1
"$ADB" -s 127.0.0.1:16409 wait-for-device >> "$E/e3b-l10-boot.log" 2>&1
for i in $(seq 1 150); do
  bc=$("$ADB" -s 127.0.0.1:16409 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$bc" = "1" ] && break; sleep 10
done
{ echo "boot_completed=$bc after ~$((i*10))s"; date -u +%FT%TZ; } | tee -a "$E/e3b-l10-boot.log"

# ---- read marker via adb ----
GOT=$("$ADB" -s 127.0.0.1:16409 shell cat /data/.g2-e2e-marker-l10 2>/dev/null | tr -d '\r')
{ echo "== adb cat /data/.g2-e2e-marker-l10"; echo "got=$GOT"; echo "expected=$M10"; [ "$GOT" = "$M10" ] && echo "RESULT=MARKER_MATCH" || echo "RESULT=MARKER_MISMATCH"; } > "$E/e3b-l10-marker-read.txt"
say "l10 marker: $(grep RESULT "$E/e3b-l10-marker-read.txt")"

# ---- wait l9 boot (recreated in pass-1 step10; warm boot ~30-60s) ----
say "wait l9 boot (16408)"
"$ADB" connect 127.0.0.1:16408 >> "$E/e3b-l9-boot.log" 2>&1
for i in $(seq 1 150); do
  bc=$("$ADB" -s 127.0.0.1:16408 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$bc" = "1" ] && break; sleep 10
done
{ echo "l9 boot_completed=$bc after ~$((i*10))s"; date -u +%FT%TZ; } | tee -a "$E/e3b-l9-boot.log"

# ---- rewrite l9 marker WITH identity id ----
M9="l9-isolation-marker $IID $TS"
say "write l9 marker (with identity id)"
docker run --rm -v "$D9:/s" alpine:3.20 sh -c "printf '%s\n' '$M9' > /s/.g2-e2e-marker-l9 && ls -la /s/.g2-e2e-marker-l9" | tee "$E/e3b-l9-marker-write.txt"

# ---- full cross-isolation ----
say "cross-isolation"
{
  echo "== l9 reads own marker (expect match)"
  "$ADB" -s 127.0.0.1:16408 shell cat /data/.g2-e2e-marker-l9 2>&1
  echo "== l10 reads l10 own marker (expect match)"
  "$ADB" -s 127.0.0.1:16409 shell cat /data/.g2-e2e-marker-l10 2>&1
  echo "== l10 tries l9 marker (expect No such file)"
  "$ADB" -s 127.0.0.1:16409 shell cat /data/.g2-e2e-marker-l9 2>&1
  echo "== l9 tries l10 marker (expect No such file)"
  "$ADB" -s 127.0.0.1:16408 shell cat /data/.g2-e2e-marker-l10 2>&1
} > "$E/e3b-cross-isolation.txt" 2>&1
cat "$E/e3b-cross-isolation.txt"

api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e3b-gate-final.json"
say "E3b DONE"

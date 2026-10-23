#!/usr/bin/env bash
# =============================================================================
# Mobile Console PoC orchestrator — ONE long command (CTO-idle-during-boot)
#
#   redlines → ensure device → boot wait → network probes → sidecar →
#   browser (WebCodecs + touch) → cleanup → summary
#
# Usage: run-poc.sh            (full; idempotent device create)
#        run-poc.sh summary    (just (re)write the summary)
# =============================================================================
set -uo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
SUB="${1:-all}"
mkdir -p "$MC_EVID"

cmd_summary() {
  cat > "$MC_EVID/poc-summary.md" <<EOF
# MC PoC Summary (auto)
- generated: $(ts)
- boot: $(cat "$MC_EVID/boot-time.txt" 2>/dev/null | tr '\n' ' ' || echo n/a)
- probe: $(cat "$MC_EVID/probe.txt" 2>/dev/null | tr '\n' ' ')
- video source: $(grep -o '"videoSource":"[a-z]*"' "$MC_EVID/sidecar-events.jsonl" 2>/dev/null | head -1 | cut -d'"' -f4 || echo n/a)
- sidecar stats: $(tail -1 "$MC_EVID/sidecar-final-stats.json" 2>/dev/null || echo n/a)
- browser: $(cat "$MC_EVID/browser-evidence.json" 2>/dev/null | tr -d '\n ' | head -c 400)
- screenshots: $(ls "$MC_EVID"/*.png 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')
EOF
  log summary "written to $MC_EVID/poc-summary.md"
}

[ "$SUB" = "summary" ] && { cmd_summary; exit 0; }

# ---- 0) pre-load redlines (G2 discipline) ----
mem_redline || exit 1
vram_redline || exit 1
sglang_redline || exit 1
foreign_port_redline || exit 1
log redline "all pre-checks pass (mem=$(mem_avail_mb)MB load=$(load1) sglang=$(sglang_code) vram=$(gpu_free_mib))"

# ---- 1) infra must be up ----
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$MC_API/api/health/live")" = "200" ] \
  || { log FATAL "scratch api not healthy — run setup-infra.sh first"; exit 2; }
api_login || exit 2

# ---- 2) ensure PoC device (idempotent) ----
api GET '/api/devices/redroid'
if echo "$API_OUT" | grep -q "\"name\":\"$MC_DEVICE_NAME\""; then
  log device "$MC_DEVICE_NAME already exists"
else
  log device "creating $MC_DEVICE_NAME from template $MC_TEMPLATE_NAME"
  api POST '/api/devices/redroid' "{\"name\":\"$MC_DEVICE_NAME\",\"templateName\":\"$MC_TEMPLATE_NAME\",\"idempotencyKey\":\"brmc-poc-create-01\"}" > "$MC_EVID/device-create.json"
  [ "$API_CODE" = "201" ] || [ "$API_CODE" = "200" ] || { log FATAL "device create failed ($API_CODE): $API_OUT"; exit 3; }
fi
api GET '/api/devices/redroid'
ADB_PORT=$(echo "$API_OUT" | sed '$d' | node -e '
  let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
    const j=JSON.parse(s); const d=(j.devices??[]).find(x=>x.name===process.argv[1]);
    if(!d){console.error("device not in list");process.exit(1);}
    console.log(d.adbPort);
  });' "$MC_DEVICE_NAME")
[ -n "$ADB_PORT" ] || { log FATAL "no adbPort for $MC_DEVICE_NAME"; exit 4; }
SERIAL="127.0.0.1:$ADB_PORT"
log device "$MC_DEVICE_NAME adbPort=$ADB_PORT serial=$SERIAL"

DEVICE_IP=$(DC "inspect $MC_DEVICE_NAME --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'" 2>/dev/null | tr -s ' ' | cut -d' ' -f1)
log device "container IP on $MC_NET: ${DEVICE_IP:-unknown}"

# ---- 3) boot wait (single loop; ADB online + sys.boot_completed=1) ----
t0=$(date +%s)
BOOT_OK=0
for i in $(seq 1 $((MC_BOOT_TIMEOUT_S / 15))); do
  st=$("$MC_ADB" -s "$SERIAL" get-state 2>/dev/null | tr -d '\r' || echo offline)
  if [ "$st" = "device" ]; then
    bc=$("$MC_ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
    if [ "$bc" = "1" ]; then BOOT_OK=1; break; fi
  fi
  [ $(( (i % 4) )) -eq 0 ] && log boot "wait… ($i) state=${st:-?}"
  sleep 15
done
t1=$(date +%s)
BOOT_S=$((t1 - t0))
if [ "$BOOT_OK" != "1" ]; then
  log FATAL "boot TIMEOUT after ${BOOT_S}s (state loop exhausted)"
  {
    echo "boot: TIMEOUT after ${BOOT_S}s"
    echo "adb final state: $("$MC_ADB" -s "$SERIAL" get-state 2>/dev/null || echo n/a)"
  } > "$MC_EVID/boot-time.txt"
  cmd_summary; exit 10
fi
echo "boot: ${BOOT_S}s (t0=$(ts) t1=$(ts), adb online + sys.boot_completed=1)" > "$MC_EVID/boot-time.txt"
log boot "BOOT OK in ${BOOT_S}s"
{
  echo "android_release=$("$MC_ADB" -s "$SERIAL" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
  echo "model=$("$MC_ADB" -s "$SERIAL" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
  echo "device_ip_on_${MC_NET}=${DEVICE_IP:-unknown}"
  echo "adb_version=$("$MC_ADB" version 2>/dev/null | head -2 | tail -1)"
  echo "sglang_health_during=$(sglang_code)"
} > "$MC_EVID/device-props.txt"
cat "$MC_EVID/device-props.txt"

# ---- 4) network reachability probes (production topology assumptions) ----
{
  echo "probe @ $(ts)"
  if [ -n "${DEVICE_IP:-}" ]; then
    same=$(DC "run --rm --network $MC_NET alpine:3.20 sh -c 'nc -z -w 3 $DEVICE_IP 5555 && echo SAME_L2_OK'" 2>&1 | tr '\n' ' ')
    cross=$(DC "run --rm --network $MC_PROBE_NET alpine:3.20 sh -c 'nc -z -w 3 $DEVICE_IP 5555 && echo CROSS_BRIDGE_OK'" 2>&1 | tr '\n' ' ')
    echo "same-L2 (devices net, = production sidecar path): ${same:-FAIL}"
    echo "cross-bridge (probe net -> device IP, = api->sidecar path): ${cross:-FAIL}"
  else
    echo "device IP unknown — probes skipped"
  fi
} > "$MC_EVID/probe.txt"
cat "$MC_EVID/probe.txt"

# ---- 5) sidecar (host process; pinned adb + jar) ----
SC_PIDFILE="$MC_STATE/sidecar.pid"
if [ -f "$SC_PIDFILE" ] && kill -0 "$(cat "$SC_PIDFILE")" 2>/dev/null; then
  kill "$(cat "$SC_PIDFILE")" 2>/dev/null || true; sleep 2
fi
rm -f "$MC_EVID/sidecar.log" "$MC_EVID/sidecar-events.jsonl" "$MC_EVID/scrcpy-server.log"
(
  export ADB="$MC_ADB" SERIAL="$SERIAL" JAR="$MC_JAR_PATH" JAR_SHA256="$MC_JAR_SHA256"
  export FWD_VIDEO="$MC_FWD_VIDEO" FWD_CONTROL="$MC_FWD_CONTROL" PORT="$MC_SIDECAR_PORT" EVID="$MC_EVID"
  export VIDEO_SOURCE="${MC_VIDEO_SOURCE:-screencap}"
  exec node "$MC_DIR/poc-sidecar.mjs"
) > "$MC_EVID/sidecar.log" 2>&1 &
echo $! > "$SC_PIDFILE"
log sidecar "started (pid $(cat "$SC_PIDFILE"), port $MC_SIDECAR_PORT, fwd $MC_FWD_VIDEO/$MC_FWD_CONTROL, video_source=${MC_VIDEO_SOURCE:-screencap})"

LIVE_OK=0
for i in $(seq 1 60); do
  STATS=$(curl -s --max-time 3 "http://127.0.0.1:$MC_SIDECAR_PORT/stats" 2>/dev/null || echo "")
  if echo "$STATS" | grep -q '"phase":"LIVE"' && echo "$STATS" | grep -qE '"frames":[2-9][0-9]|"frames":[1-9][0-9]{2,}'; then
    LIVE_OK=1; break
  fi
  kill -0 "$(cat "$SC_PIDFILE")" 2>/dev/null || break
  sleep 2
done
if [ "$LIVE_OK" != "1" ]; then
  log FATAL "sidecar did not reach LIVE+frames within 120s"
  tail -20 "$MC_EVID/sidecar.log" | tee -a "$MC_EVID/poc-summary.md"
  kill "$(cat "$SC_PIDFILE")" 2>/dev/null || true
  cmd_summary; exit 5
fi
curl -s "http://127.0.0.1:$MC_SIDECAR_PORT/stats" > "$MC_EVID/sidecar-final-stats.json"
log sidecar "LIVE: $(cat "$MC_EVID/sidecar-final-stats.json" | head -c 300)"

# ---- 6) browser (WebCodecs + touch) ----
EVID="$MC_EVID" node "$MC_DIR/poc-browser.mjs" > "$MC_EVID/browser-run.log" 2>&1
BRC=$?
log browser "exit=$BRC ($(tail -1 "$MC_EVID/browser-run.log"))"

# ---- 7) cleanup sidecar (pidfile; forwards removed by its SIGTERM handler) ----
kill "$(cat "$SC_PIDFILE")" 2>/dev/null || true
sleep 3
kill -0 "$(cat "$SC_PIDFILE")" 2>/dev/null && kill -9 "$(cat "$SC_PIDFILE")" 2>/dev/null
rm -f "$SC_PIDFILE"
"$MC_ADB" -s "$SERIAL" forward --list 2>/dev/null | grep -E "$MC_FWD_VIDEO|$MC_FWD_CONTROL" > "$MC_EVID/forward-residual.txt" || true
log sidecar "stopped; residual forwards: $(cat "$MC_EVID/forward-residual.txt" 2>/dev/null | wc -l)"

# ---- 8) post-load redline (informational: nothing new after this) ----
log redline "post: mem=$(mem_avail_mb)MB load=$(load1) sglang=$(sglang_code) vram=$(gpu_free_mib)"
cmd_summary
log poc "DONE (browser rc=$BRC)"
exit "$BRC"

#!/usr/bin/env bash
# RAM-G2 Phase D — the real-device ladder 1→5→10 with the PRODUCT GATE LIVE.
#
# ONE long command (CTO-idle-during-boot discipline): gate -> resume scan ->
# staggered API-create + boot wait (one device at a time) -> 300s stage
# soaks at 1/5/10 (30s sampling + redlines) -> per-device evidence -> summary.
#
# The gate decides every boot: POST /api/devices/redroid hits ADMIT_LUA
# BEFORE any side effect. A 409 RAM_GATE_DENIED is EXPECTED gate behaviour
# (conservative target) — the ladder HALTS (exit 3) with full decision
# evidence so the operator can record + adjust postBootTargetMiB via
# PUT /api/system/ram-gate/config and re-run (this script is resumable).
#
# Subcommands:
#   gate     — redlines + gate status snapshot; 0=GO 1=NO-GO
#   ladder   — the whole run (resumable)
#   evidence — re-collect per-device evidence for currently-up devices
#
# Exit codes: 0 done  1 gate NO-GO  2 redline/boot-failure (diagnostics kept)
#             3 gate DENY (halt for config decision)  4 api error
set -uo pipefail
SUBCMD="${1:-ladder}"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mkdir -p "$R2_EVID"

gate_snapshot() { # tag -> save status + decisions + config trail
  local tag="$1"
  api GET '/api/system/ram-gate' && {
    echo "$API_BODY" > "$R2_EVID/gate-status-$tag.json"
    jq -c '{enabled, config, counts, wouldAdmitNext, metrics: {ageMs: .metrics.ageMs, stale: .metrics.stale, memAvailableMiB: .metrics.memAvailableMiB}}' \
      "$R2_EVID/gate-status-$tag.json" > "$R2_EVID/gate-status-$tag.summary.json" 2>/dev/null || cp "$R2_EVID/gate-status-$tag.json" "$R2_EVID/gate-status-$tag.summary.json"
  } || log "WARN: gate status fetch failed for tag=$tag (code $API_CODE)"
  api GET '/api/system/ram-gate/decisions?limit=30' && echo "$API_BODY" > "$R2_EVID/gate-decisions-$tag.json" \
    || log "WARN: gate decisions fetch failed for tag=$tag (code $API_CODE)"
}

boot_dev() { # $1=index i ; uses $2=port ; sets BC[i]/BT[i]; 0 ok / 1 timeout / 2 redline
  local i="$1" port="$2" name
  name="$(dev_name "$i")"
  local t0 now elapsed bc st
  "$R2_ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
  t0=$(date +%s)
  while :; do
    now=$(date +%s)
    elapsed=$(( now - t0 ))
    [ "$elapsed" -gt "$R2_BOOT_TIMEOUT_S" ] && { log "TIMEOUT: $name after ${elapsed}s"; return 1; }
    vram_redline || { row; return 2; }
    sglang_redline || { row; return 2; }
    mem_redline || { row; return 2; }
    foreign_port_redline || { row; return 2; }
    "$R2_ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
    bc=$("$R2_ADB" -s "127.0.0.1:$port" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || echo "")
    st=$("$R2_ADB" -s "127.0.0.1:$port" get-state 2>/dev/null | tr -d '\r\n' || echo "")
    [ "$st" = "offline" ] && bc=""
    if [ -n "$bc" ] && [ "$bc" != "0" ]; then
      BC[$i]=1; BT[$i]=$elapsed
      log "BOOT OK $name in ${elapsed}s (adb=$st)"
      row
      return 0
    fi
    row
    sleep "$R2_BOOT_POLL_S"
  done
}

soak_stage() { # $1=stage label (1|5|10)
  local stage="$1" flag="$R2_EVID/soak-$stage.done"
  [ -f "$flag" ] && { log "soak stage $stage already done (resumed)"; return 0; }
  local K end
  K=$(up_count)
  log "SOAK ${R2_SOAK_S}s @ stage=$stage up=$K (sampling ${R2_SOAK_POLL_S}s, redlines)"
  end=$(( $(date +%s) + R2_SOAK_S ))
  local redline_hit=""
  while [ "$(date +%s)" -lt "$end" ]; do
    vram_redline || redline_hit="${redline_hit} vram@$(ts)"
    sglang_redline || redline_hit="${redline_hit} sglang@$(ts)"
    mem_redline || redline_hit="${redline_hit} MEM@$(ts)=$(mem_avail_mb)MB"
    row
    sleep "$R2_SOAK_POLL_S"
  done
  if [ -n "$redline_hit" ]; then
    log "SOAK-REDLINE stage=$stage:$redline_hit (recorded; task stop condition if MEM)"
    echo "$redline_hit" > "$R2_EVID/soak-$stage.redline"
  fi
  touch "$flag"
  log "soak stage $stage done (MemAvail now $(mem_avail_mb)MB)"
}

cmd_gate() {
  log "gate (hard redlines; W1 GPU-util observe-only)"
  log "W1-OBSERVE gpu: $(gpu_row)"
  vram_redline || return 1
  sglang_redline || return 1
  mem_redline || return 1
  foreign_port_redline || return 1
  local p
  for p in 16400 16401 16402 16403 16404 16405 16406 16407 16408 16409 16490 16494 16495 16496; do
    ss -ltn 2>/dev/null | grep -q ":$p " && [ "$p" != "16490" ] && [ "$p" != "16494" ] && [ "$p" != "16495" ] && \
      { log "NO-GO: port $p bound (infra 16490/16494/16495 allowlisted only)"; return 1; }
  done
  api_login || { log "NO-GO: api login failed"; return 1; }
  gate_snapshot "pregate"
  log "GO: VRAM ok / 30000=200 / MemAvail $(mem_avail_mb)MB / 164xx clean / gate status captured"
  return 0
}

cmd_ladder() {
  cmd_gate || { log "ABORT: gate NO-GO"; return 1; }
  init_csv
  log "PRE-SNAPSHOT gpu: $(gpu_row) | MemAvail $(mem_avail_mb)MB load1 $(load1) | 30000: $(sglang_code)"

  local STOPPED=0 STOP_REASON="" STOP_MEMAVAIL=""
  local i name port idem key code

  # ---- resume scan: which devices already exist? ----
  api GET '/api/devices/redroid' || { log "FATAL: cannot list devices"; return 4; }
  echo "$API_BODY" > "$R2_EVID/devices-prescan.json"
  log "prescan: $(echo "$API_BODY" | jq -r '[.devices[] | "\(.name)=\(.containerState)/\(.adbState)@\(.adbPort)"] | join(" ")' 2>/dev/null || echo '?')"

  for i in $(seq 1 "$R2_N"); do
    name="$(dev_name "$i")"; port=$(dev_port "$i")
    # already booted? (resume path)
    if [ "${BC[$i]:-0}" = "1" ]; then continue; fi
    if [ -n "$(echo "$API_BODY" | jq -r --arg n "$name" '.devices[]? | select(.name==$n) | .name' 2>/dev/null)" ]; then
      log "$name already in DB — checking boot state (resume)"
      "$R2_ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
      local bcx
      bcx=$("$R2_ADB" -s "127.0.0.1:$port" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || echo "")
      if [ -n "$bcx" ] && [ "$bcx" != "0" ]; then
        BC[$i]=1; BT[$i]=0
        log "RESUMED $name (already boot_completed; boot time unmeasured this run)"
        row
        continue
      fi
      log "$name in DB but not boot_completed — waiting for it to finish"
      boot_dev "$i" "$port" || { rc=$?; STOPPED=1; STOP_REASON="redline-or-timeout-waiting-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
      api GET "/api/devices/redroid/$name" >/dev/null 2>&1 || true
      continue
    fi
    # pre-boot hard gates
    vram_redline || { STOPPED=1; STOP_REASON="vram-pre-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
    sglang_redline || { STOPPED=1; STOP_REASON="sglang-pre-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
    mem_redline || { STOPPED=1; STOP_REASON="mem-pre-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
    foreign_port_redline || { STOPPED=1; STOP_REASON="port-pre-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
    if [ -n "$(sg docker -c "docker inspect -f '{{.Name}}' $name" 2>/dev/null)" ]; then
      log "FATAL: container $name exists but no DB row — stop and investigate"; return 2
    fi
    if [ -d "$R2_DATA_ROOT/$name" ]; then
      log "FATAL: dataDir $R2_DATA_ROOT/$name exists but no DB row — stop and investigate"; return 2
    fi

    log "CREATING $name (ADB 127.0.0.1:$port) — gate decides (device #$i)"
    key="g2-l${i}-$(date +%s)-$RANDOM"
    R2_API_TIMEOUT=60 api POST '/api/devices/redroid' "{
      \"name\": \"$name\",
      \"templateName\": \"$R2_TEMPLATE_NAME\",
      \"idempotencyKey\": \"$key\"
    }"
    code=$API_CODE
    echo "$API_BODY" > "$R2_EVID/create-s$i-http$code.json"
    gate_snapshot "s$i"
    if [ "$code" = "201" ]; then
      log "CREATE OK $name (gate ADMITTED — see gate-status-s$i.summary.json)"
      port=$(echo "$API_BODY" | jq -r '.device.adbPort // empty' 2>/dev/null)
      [ -z "$port" ] && port=$(dev_port "$i")
      boot_dev "$i" "$port" || { STOPPED=1; STOP_REASON="bootfail-or-redline-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
      # let the API learn adbState=online (watchdog also does this)
      api POST "/api/devices/redroid/$name/refresh" "{}" >/dev/null 2>&1 || true
    elif [ "$code" = "409" ] && echo "$API_BODY" | grep -q 'RAM_GATE_DENIED'; then
      log "GATE DENY at s$i (HTTP 409): $(echo "$API_BODY" | head -c 300)"
      jq -c '{device: "\($name)", stage: $i, http: 409, body: ., decision: .details // .message, at: "\(.at // "")"}' \
        --arg name "$name" "$R2_EVID/create-s$i-http409.json" > "$R2_EVID/DENY-s$i.json" 2>/dev/null \
        || cp "$R2_EVID/create-s$i-http409.json" "$R2_EVID/DENY-s$i.json"
      gate_snapshot "deny-s$i"
      # state file for the operator (config decision)
      jq -c '{halted_at_device: "'$name'", http: 409, at: "'"$(ts)"'", up: '"$(up_count)"', memavail_mb: '"$(mem_avail_mb)"', decision_file: "DENY-s'$i'.json"}' \
        > "$R2_EVID/LADDER_HALTED.json" 2>/dev/null || true
      log "LADDER HALTED (gate deny) — operator: record + PUT /api/system/ram-gate/config {postBootTargetMiB} + re-run (resumable)"
      write_summary "gate-deny"
      return 3
    else
      log "FATAL: unexpected create response for $name: HTTP $code"; echo "$API_BODY" | head -c 500; return 4
    fi

    # stage soaks
    case "$i" in
      1|5|10) soak_stage "$i" ;;
    esac
  done

  local K; K=$(up_count)
  log "STAGGER DONE: up=$K/$R2_N stopped=$STOPPED reason=${STOP_REASON:-none} stopMemAvail=${STOP_MEMAVAIL:-n/a} per_dev: $(for i in $(seq 1 "$R2_N"); do [ "${BC[$i]:-0}" = "1" ] && printf 'l%s=%ss ' "$i" "${BT[$i]}"; done)"

  if [ "$K" -gt 0 ]; then
    log "POST-BOOT GATE CHECK (redlines) [up=$K]"
    vram_redline || log "note: vram redline post-boot (recorded)"
    sglang_redline || log "note: 30000 redline post-boot (recorded)"
    mem_redline || log "note: MEM redline post-boot (recorded)"
    foreign_port_redline || log "note: foreign port post-boot (recorded)"
    # if stagger ended short but we are at a stage boundary, make sure the soak ran
    case "$K" in 1|5|10) soak_stage "$K" ;; esac
  fi

  collect_evidence
  dmesg 2>/dev/null | tail -50 > "$R2_EVID/ladder-dmesg-post.txt" || echo "dmesg unavailable (non-root)" > "$R2_EVID/ladder-dmesg-post.txt"
  log "POST-SNAPSHOT gpu: $(gpu_row) | MemAvail $(mem_avail_mb)MB load1 $(load1) | 30000: $(sglang_code)"
  write_summary "${STOP_REASON:-complete}"
  if [ "$STOPPED" = "1" ]; then return 2; fi
  [ "$K" = "$R2_N" ] || { log "NOTE: finished with $K/$R2_N up"; return 2; }
  log "LADDER COMPLETE: $K/$R2_N"
  return 0
}

collect_evidence() {
  local i name port
  for i in $(seq 1 "$R2_N"); do
    [ "${BC[$i]:-0}" = "1" ] || continue
    name="$(dev_name "$i")"; port=$(dev_port "$i")
    "$R2_ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
    "$R2_ADB" -s "127.0.0.1:$port" shell getprop ro.build.display.id > "$R2_EVID/${name}-getprop.txt" 2>&1 || true
    local sfpid
    sfpid=$("$R2_ADB" -s "127.0.0.1:$port" shell pidof surfaceflinger 2>/dev/null | tr -d '\r' | head -1)
    if [ -n "$sfpid" ]; then
      "$R2_ADB" -s "127.0.0.1:$port" shell "ls -l /proc/$sfpid/fd 2>/dev/null | grep -c renderD" > "$R2_EVID/${name}-render-fd.txt" 2>&1 || echo "?" > "$R2_EVID/${name}-render-fd.txt"
    else
      echo "surfaceflinger pid not found" > "$R2_EVID/${name}-render-fd.txt"
    fi
    "$R2_ADB" -s "127.0.0.1:$port" shell logcat -d -t 40 2>/dev/null > "$R2_EVID/${name}-logcat.txt" || true
    "$R2_ADB" disconnect "127.0.0.1:$port" >/dev/null 2>&1 || true
  done
}

write_summary() { # $1=stop_reason or 'complete'
  local reason="${1:-complete}"
  cat > "$R2_EVID/ladder-summary.json" <<EOF
{
  "captured_at": "$(ts)",
  "task": "water_army RAM-G2 Phase D — 10-device ladder with product gate live",
  "devices_up": $(up_count),
  "devices_target": $R2_N,
  "stopped": $([ "$STOPPED" = "1" ] 2>/dev/null && echo true || echo false),
  "stop_reason": "$reason",
  "stop_memavailable_mb": ${STOP_MEMAVAIL:-null},
  "per_device_boot_s": {$(for i in $(seq 1 "$R2_N"); do [ "${BC[$i]:-0}" = "1" ] && printf '"l%s":%s,' "$i" "${BT[$i]}"; done | sed 's/,$//')},
  "note": "stage-min MemAvailable/VRAM/load1/30000 + per-stage gate decisions derived from ladder-samples.csv + gate-status-s*.summary.json"
}
EOF
  log "SUMMARY -> $R2_EVID/ladder-summary.json"
}

case "$SUBCMD" in
  gate) cmd_gate ;;
  ladder) cmd_ladder ;;
  evidence) mkdir -p "$R2_EVID"; api_login; collect_evidence; log "evidence collected" ;;
  *) echo "usage: $0 gate|ladder|evidence" >&2; exit 2 ;;
esac

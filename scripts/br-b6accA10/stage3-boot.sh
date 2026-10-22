#!/usr/bin/env bash
# BR-B6-Acceptance A10 — Stage 3 (A10-4): 10 synthetic identities, controlled
# staggered boot (one device mid-boot at a time). Boss decision 2026-10-22 18:21
# (HKT) APPROVED the 10-device short test with the 16G host-MemAvailable hard
# redline. 25/50 NOT approved.
#
# Isolation contract (identical to A+B stage2, prefix/port/net changed):
#   - prefix br-b6c-* ONLY; port band 16400-16409 (subset of 16400-16499);
#     own bridge br-b6c-ladder 172.38.220.0/24 (user net 172.38.200.0/24, A+B
#     172.38.210.0/24 — no overlap)
#   - synthetic identities only, isolated bridge, NO real accounts, NO public
#     interaction (device-only boot + getprop + logcat)
#   - product container spec replicated from redroid-service.js R5 (digest-pinned
#     image, privileged, 4G RAM ceiling, 2 vCPU, nvidia all-GPU, /data bind,
#     127.0.0.1 ADB)
#   - NEVER touches: SGLang 30000 (read-only health), user compose water-army-*,
#     C-item br-b6e-*, redroid-health/T102 files
#
# HARNESS-LEVEL RAM GUARD (A10-3: no product host-RAM guard exists — product
# gap). Semantics per task: any redline fire = STOP NEW LOADS ONLY, NEVER kill
# running devices, record the EXACT MemAvailable (and VRAM/30000) at the stop
# point. Redlines:
#   R-MEM  host MemAvailable < 16384 MB (W4: a FLOOR, not a device budget)
#   R-VRAM any GPU free < 1500 MiB
#   R-SGL  30000 /health != 200 (5xx/timeout)
#   R-PORT a 164xx port bound by something other than our 16400-16409
# W1 (GPU util window) = OBSERVE-ONLY (boss strategy 2026-10-22 15:59: SGLang
# load = agents' own inference; the operator agent being idle during boot IS the
# window). CTO-idle-during-boot discipline: this whole boot phase runs as ONE
# command; the operator generates no LLM output between kickoff and return.
#
# Subcommands:
#   gate      — W2-W5 hard + W1 observe + 16400-16409 free + host preflight.
#               Exit 0 = GO, 1 = NO-GO.
#   boot      — ONE long command: gate -> network -> staggered create+boot 1->10
#               (redlines stop new loads) -> post-boot gate -> 300s soak (30s
#               sample, redlines) -> per-device evidence -> stop_all -> summary.
#   teardown  — remove ALL br-b6c-* artifacts (containers, network, data root via
#               alpine root shim) + verify zero residue.
#
# Evidence dir: BRB6C_EVID (default /home/kenneth/.openclaw/workspace/logs/br-b6-accA10)
set -uo pipefail
cd "$(dirname "$0")/../.."

SUB="${1:?usage: stage3-boot.sh gate|boot|teardown}"
EVID="${BRB6C_EVID:-/home/kenneth/.openclaw/workspace/logs/br-b6-accA10}"
BOOT_CSV="$EVID/boot10-samples.csv"
IMAGE='water-army/redroid@sha256:591296d5656571f346994dc81608ca33744af4d0e9c9876241a8595e70143b55'
NET='br-b6c-ladder'
NET_SUBNET='172.38.220.0/24'
DATA_ROOT='/var/lib/water-army/redroid-accA10'
ADB="$HOME/.local/share/platform-tools/adb"
N=10
PER_DEV_TIMEOUT_S=600        # A+B measured ~22-24s cold boot; 600s very generous
SOAK_S=300                   # 5min soak at full (or stopped) count
SOAK_SLEEP=30                # 30s sampling during soak (per task)
BOOT_SLEEP=10                # 10s sampling during staggered boot (A+B cadence, boot detection)
REDLINE_MEM_MB=16384         # W4 host-MemAvailable floor
REDLINE_VRAM_MIB=1500        # W2 per-card free floor
SUMMARY_JSON="$EVID/boot10-summary.json"

DC() { sg docker -c "docker $*" 2>&1; }

log() { echo "[br-b6c s3 $SUB] $(date -u +%H:%M:%S) $*"; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mem_avail_mb() { awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo; }
load1() { awk '{print $1}' /proc/loadavg; }
sglang_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000; }
gpu_row() { # -> "g0u,g0f,g1u,g1f"
  nvidia-smi --query-gpu=utilization.gpu,memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d ' ' | tr '\n' ' ' | tr ',' ' ' | awk '{print $1","$2","$3","$4}'
}
# ours: is port in 16400..16409?
ours_port() { local p; p=${1#127.0.0.1:}; p=${p%:*}; [ -n "$p" ] && [ "$p" -ge 16400 ] 2>/dev/null && [ "$p" -le 16409 ] 2>/dev/null; }

# ---- redlines (hard) ----
mem_redline() { local ma; ma=$(mem_avail_mb); [ "$ma" -ge "$REDLINE_MEM_MB" ] || { log "REDLINE R-MEM: MemAvailable ${ma}MB < ${REDLINE_MEM_MB} — STOP NEW LOADS"; return 1; }; return 0; }
vram_redline() {
  local g0f g1f
  read -r g0f g1f <<<"$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d ' ')"
  [ -n "${g0f:-}" ] && [ "$g0f" -lt "$REDLINE_VRAM_MIB" ] && { log "REDLINE R-VRAM: GPU0 free ${g0f}MiB < $REDLINE_VRAM_MIB — STOP NEW LOADS"; return 1; }
  [ -n "${g1f:-}" ] && [ "$g1f" -lt "$REDLINE_VRAM_MIB" ] && { log "REDLINE R-VRAM: GPU1 free ${g1f}MiB < $REDLINE_VRAM_MIB — STOP NEW LOADS"; return 1; }
  return 0
}
sglang_redline() { local code; code=$(sglang_code); [ "$code" = "200" ] || { log "REDLINE R-SGL: 30000 health=$code (want 200) — STOP NEW LOADS"; return 1; }; return 0; }
foreign_port_redline() {
  local p
  for p in $(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(164[0-9]{2})\s*$' | sed 's/^://' | sort -u); do
    ours_port "$p" || { log "REDLINE R-PORT: foreign 164xx bound: $p (ours=16400-16409) — STOP NEW LOADS"; return 1; }
  done
  return 0
}

# 10s/30s sample row: ts, g0u, g0f, g1u, g1f, mem_avail_mb, load1, sglang_code, boots(s1..sN)
BC=()
row() {
  local o="" i
  for i in $(seq 1 "$N"); do o="${o}${BC[$i]:-0}"; done
  echo "$(ts),$(gpu_row),$(mem_avail_mb),$(load1),$(sglang_code),${o}" >> "$BOOT_CSV"
}

boot_dev() { # $1=index i; sets BC[i]=1 on success; returns 0 ok / 1 timeout / 2 redline
  local i="$1" port=$(( 16399 + i )) name="br-b6c-s$i"
  local t0 now elapsed bc st
  "$ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
  t0=$(date +%s)
  while :; do
    now=$(date +%s)
    elapsed=$(( now - t0 ))
    [ "$elapsed" -gt "$PER_DEV_TIMEOUT_S" ] && { log "TIMEOUT: $name after ${elapsed}s (no redline — device/harness failure)"; return 1; }
    # redlines during boot: STOP NEW LOADS (do not kill this one, do not start more)
    vram_redline || { row; return 2; }
    sglang_redline || { row; return 2; }
    mem_redline || { row; return 2; }
    foreign_port_redline || { row; return 2; }
    # adb TCP device only appears after `adb connect` (A+B attempt #2 lesson)
    "$ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
    bc=$("$ADB" -s "127.0.0.1:$port" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || echo "")
    st=$("$ADB" -s "127.0.0.1:$port" get-state 2>/dev/null | tr -d '\r\n' || echo "")
    [ "$st" = "offline" ] && bc=""
    if [ -n "$bc" ] && [ "$bc" != "0" ]; then
      BC[$i]=1; BOOT_T[$i]=$elapsed
      log "BOOT OK $name in ${elapsed}s (adb=$st) [up=$(up_count)]"
      row
      return 0
    fi
    row
    sleep "$BOOT_SLEEP"
  done
}
up_count() { local c=0 i; for i in $(seq 1 "$N"); do [ "${BC[$i]:-0}" = "1" ] && c=$((c+1)); done; echo "$c"; }

cmd_gate() {
  log "gate (W2-W5 hard; W1 observe-only — boss strategy 2026-10-22 15:59)"
  # W1 observe-only: report current util, never block
  log "W1-OBSERVE gpu: $(gpu_row) (util is agent-inference proxy; not blocking)"
  # W2 VRAM
  vram_redline || return 1
  # W3 30000
  sglang_redline || return 1
  # W4 MemAvailable floor
  mem_redline || return 1
  # W5 16400-16409 free
  local p
  for p in 16400 16401 16402 16403 16404 16405 16406 16407 16408 16409; do
    ss -ltn 2>/dev/null | grep -q "127.0.0.1:$p" && { log "NO-GO W5: port $p bound"; return 1; }
  done
  foreign_port_redline || return 1
  # host preflight (R5 CLI, read-only)
  node apps/api/src/cli/preflight.js >/dev/null 2>&1 || { log "NO-GO: host preflight failed"; return 1; }
  log "GO: W2 VRAM ok / W3 30000=200 / W4 MemAvail $(mem_avail_mb)MB / W5 16400-16409 free / preflight PASS (W1 observe)"
  return 0
}

cmd_boot() {
  mkdir -p "$EVID"
  log "=== A10-4 10-device controlled boot: GATE ==="
  cmd_gate || { log "ABORT: gate NO-GO — not booting (no residue to clean; verify residue separately)"; return 1; }

  # network (idempotent)
  if ! DC network inspect "$NET" >/dev/null 2>&1; then
    DC network create --subnet "$NET_SUBNET" "$NET" >/dev/null || { log "FATAL: cannot create $NET"; return 2; }
  fi
  log "network $NET ready (subnet $NET_SUBNET)"

  echo "ts,g0_util,g0_mem_free,g1_util,g1_mem_free,mem_avail_mb,load1,sglang_code,boots" > "$BOOT_CSV"
  log "PRE-SNAPSHOT gpu: $(gpu_row) | MemAvail $(mem_avail_mb)MB load1 $(load1) | 30000: $(sglang_code)"
  dmesg 2>/dev/null | tail -50 > "$EVID/s3-dmesg-pre.txt" || echo "dmesg unavailable (non-root)" > "$EVID/s3-dmesg-pre.txt"

  local STOPPED=0 STOP_REASON="" STOP_MEMAVAIL="" BOOTFAIL=0
  local i name port data_dir rc
  for i in $(seq 1 "$N"); do
    name="br-b6c-s$i"; port=$(( 16399 + i )); data_dir="$DATA_ROOT/s$i"
    # pre-create hard gates: stop NEW loads on any redline (never kill existing)
    vram_redline || { STOPPED=1; STOP_REASON="vram-pre-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
    sglang_redline || { STOPPED=1; STOP_REASON="sglang-pre-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
    mem_redline || { STOPPED=1; STOP_REASON="mem-pre-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
    foreign_port_redline || { STOPPED=1; STOP_REASON="port-pre-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; }
    # existence guards (exact name, no relay regex)
    if [ -n "$(sg docker -c "docker inspect -f '{{.Name}}' $name" 2>/dev/null)" ]; then
      log "FATAL: $name already exists — teardown first"; return 2
    fi
    [ -d "$data_dir" ] && { log "FATAL: data dir exists ($data_dir) — teardown first"; return 2; }
    mkdir -p "$data_dir"
    log "creating $name (ADB 127.0.0.1:$port, product spec) [will be device #$i]"
    if ! DC run -d \
        --name "$name" \
        --privileged \
        --memory 4294967296 \
        --cpus 2 \
        --gpus all \
        --network "$NET" \
        -p "127.0.0.1:$port:5555" \
        -v "$data_dir:/data" \
        "$IMAGE" \
        androidboot.redroid_width=720 \
        androidboot.redroid_height=1280 \
        androidboot.redroid_dpi=320 \
        androidboot.redroid_fps=30 \
        androidboot.redroid_gpu_mode=host > "$EVID/${name}-create.log" 2>&1; then
      log "FATAL: docker create failed $name"; tail -5 "$EVID/${name}-create.log" | sed 's/^/    /'
      STOPPED=1; STOP_REASON="create-fail-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break
    fi
    rc=0; boot_dev "$i" || rc=$?
    if [ "$rc" = "2" ]; then STOPPED=1; STOP_REASON="redline-during-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); log "STOP NEW LOADS after $i due to redline (existing devices left running)"; break; fi
    if [ "$rc" = "1" ]; then BOOTFAIL=1; log "BOOT TIMEOUT s$i — halting stagger (no more new loads)"; STOPPED=1; STOP_REASON="boot-timeout-s$i"; STOP_MEMAVAIL=$(mem_avail_mb); break; fi
    # stage markers at 1 / 5 / 10
    case "$i" in 1|5|10) log "STAGE $i reached: up=$(up_count) MemAvail=$(mem_avail_mb)MB $(gpu_row) load1=$(load1) 30000=$(sglang_code)";; esac
  done

  local K; K=$(up_count)
  log "STAGGER DONE: up=$K/$N stopped=$STOPPED reason=${STOP_REASON:-none} stopMemAvail=${STOP_MEMAVAIL:-n/a} bootfail=$BOOTFAIL (per-device s: $(for i in $(seq 1 "$N"); do [ "${BC[$i]:-0}" = "1" ] && printf 's%s=%ss ' "$i" "${BOOT_T[$i]}"; done))"

  # post-boot hard-gate re-check (W2/W3/W4/W5) against the K up
  if [ "$K" -gt 0 ]; then
    log "POST-BOOT GATE CHECK (W2/W3/W4/W5) [up=$K]"
    vram_redline || { log "STOP: vram redline post-boot"; }
    sglang_redline || { log "STOP: 30000 redline post-boot"; }
    mem_redline || { log "STOP: mem redline post-boot"; }
    foreign_port_redline || { log "STOP: foreign port post-boot"; }
  fi

  # soak (30s sampling, redlines observe+record; never kill)
  if [ "$K" -gt 0 ]; then
    log "SOAK ${SOAK_S}s @ up=$K (sampling ${SOAK_SLEEP}s, redlines)"
    local end; end=$(( $(date +%s) + SOAK_S ))
    while [ "$(date +%s)" -lt "$end" ]; do
      vram_redline || { log "SOAK-REDLINE vram (recording, not killing)"; }
      sglang_redline || { log "SOAK-REDLINE 30000 (recording, not killing)"; }
      mem_redline || { log "SOAK-REDLINE mem (recording, not killing)"; }
      row
      sleep "$SOAK_SLEEP"
    done
  fi

  # per-device evidence (getprop + renderD fd + logcat tail) for the K up
  for i in $(seq 1 "$N"); do
    [ "${BC[$i]:-0}" = "1" ] || continue
    name="br-b6c-s$i"; port=$(( 16399 + i ))
    "$ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
    "$ADB" -s "127.0.0.1:$port" shell getprop ro.build.display.id > "$EVID/${name}-getprop.txt" 2>&1 || true
    local sfpid
    sfpid=$("$ADB" -s "127.0.0.1:$port" shell pidof surfaceflinger 2>/dev/null | tr -d '\r' | head -1)
    if [ -n "$sfpid" ]; then
      "$ADB" -s "127.0.0.1:$port" shell "ls -l /proc/$sfpid/fd 2>/dev/null | grep -c renderD" > "$EVID/${name}-render-fd.txt" 2>&1 || echo "?" > "$EVID/${name}-render-fd.txt"
    else
      echo "surfaceflinger pid not found" > "$EVID/${name}-render-fd.txt"
    fi
    "$ADB" -s "127.0.0.1:$port" shell logcat -d -t 40 2>/dev/null > "$EVID/${name}-logcat.txt" || true
    "$ADB" disconnect "127.0.0.1:$port" >/dev/null 2>&1 || true
  done

  # stop all up (normal end-of-run teardown of OUR devices — not a redline kill)
  if [ "$K" -gt 0 ]; then
    log "STOP_ALL up=$K (end-of-run cleanup of our devices)"
    for i in $(seq 1 "$N"); do
      [ "${BC[$i]:-0}" = "1" ] || continue
      name="br-b6c-s$i"
      log "stopping $name"
      DC stop -t 30 "$name" >/dev/null 2>&1 || true
      DC logs --tail 200 "$name" > "$EVID/${name}-container.log" 2>&1 || true
    done
  fi
  dmesg 2>/dev/null | tail -50 > "$EVID/s3-dmesg-post.txt" || echo "dmesg unavailable (non-root)" > "$EVID/s3-dmesg-post.txt"
  log "POST-SNAPSHOT gpu: $(gpu_row) | MemAvail $(mem_avail_mb)MB load1 $(load1) | 30000: $(sglang_code)"

  # summary (stage mins computed from BOOT_CSV by the analyzer; record stop facts here)
  cat > "$SUMMARY_JSON" <<EOF
{
  "captured_at": "$(date -Iseconds)",
  "task": "water_army BR-Acceptance A10 — A10-4 10-device controlled boot",
  "devices_up": $K,
  "devices_target": $N,
  "redline_stop": $([ "$STOPPED" = "1" ] && echo true || echo false),
  "stop_reason": "${STOP_REASON}",
  "stop_memavailable_mb": ${STOP_MEMAVAIL:-null},
  "boot_timeout": $([ "$BOOTFAIL" = "1" ] && echo true || echo false),
  "per_device_boot_s": {$(for i in $(seq 1 "$N"); do [ "${BC[$i]:-0}" = "1" ] && printf '"s%s":%s,' "$i" "${BOOT_T[$i]}"; done | sed 's/,$//')},
  "note": "stage-min MemAvailable/VRAM/load1/30000 + capacity-at-10 derived from $BOOT_CSV by the analyzer (see report.md)"
}
EOF
  log "SUMMARY -> $SUMMARY_JSON"
  log "evidence in $EVID/br-b6c-s*-* + $BOOT_CSV + $SUMMARY_JSON"
  return 0
}

cmd_teardown() {
  log "removing br-b6c-* artifacts (containers -> network -> data root)"
  local c
  for c in $(DC ps -aq --filter 'name=br-b6c-'); do
    log "rm container $c"; DC rm -f "$c" >/dev/null 2>&1 || true
  done
  # network-membership sweep (catches misnamed containers on our bridge)
  for c in $(DC ps -aq --filter "network=$NET"); do
    log "rm network-attached container $c"; DC rm -f "$c" >/dev/null 2>&1 || true
  done
  DC network rm "$NET" >/dev/null 2>&1 && log "rm network $NET" || log "network $NET absent (ok)"
  if [ -d "$DATA_ROOT" ]; then
    log "rm data root $DATA_ROOT (alpine root shim for root-owned files, then host rmdir)"
    local i
    for i in 1 2; do
      if [ -n "$(DC images -q alpine:3.20 2>/dev/null)" ]; then
        # direct sg docker -c (NOT DC): DC's $* relay strips inner single quotes
        # so the container's 'sh -c' would only receive 'rm' and delete nothing
        # (silent; observed in A+B teardown).
        sg docker -c "docker run --rm -v $DATA_ROOT:/wipe alpine:3.20 sh -c 'rm -rf /wipe/* /wipe/.[!.]* 2>/dev/null'" >/dev/null 2>&1 || true
      fi
      rm -rf "$DATA_ROOT" 2>/dev/null || true
      [ ! -d "$DATA_ROOT" ] && break
      [ "$i" = "1" ] && log "data root not empty after wipe pass 1 — retrying"
      sleep 2
    done
    rmdir "$DATA_ROOT" 2>/dev/null || true
  fi
  local left
  left=$(DC ps -aq --filter 'name=br-b6c-' | wc -l)
  DC network inspect "$NET" >/dev/null 2>&1 && left=$(( left + 1 ))
  if [ "$left" -eq 0 ] && [ ! -d "$DATA_ROOT" ]; then
    log "TEARDOWN CLEAN: zero br-b6c-* residue"
    return 0
  fi
  [ -d "$DATA_ROOT" ] && left=$(( left + 1 ))
  [ -d "$DATA_ROOT" ] && log "note: data root $DATA_ROOT still present (root-owned files?)"
  log "FATAL: residue remains: $left"
  return 1
}

case "$SUB" in
  gate) cmd_gate ;;
  boot) cmd_boot ;;
  teardown) cmd_teardown ;;
  *) log "unknown subcommand: $SUB"; exit 2 ;;
esac

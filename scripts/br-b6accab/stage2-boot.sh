#!/usr/bin/env bash
# BR-B6-Acceptance A+B — Stage 2 (AB3): 5 synthetic identities, controlled
# staggered boot. Isolation contract identical to stage1-boot.sh (boss-approved
# 2026-10-22): br-b6r-* only, ports 16400-16404, own bridge br-b6r-ladder
# (172.38.210.0/24), NO real accounts / NO public interaction, NEVER touches
# SGLang 30000 (read-only health), user compose, C-item br-b6e-*.
#
# Stagger policy (boss 2026-10-22: "GPU burst 可控 batch/stagger，唔好 5 台
# 同時炸"): create+wait ONE device at a time — at most one device mid-boot,
# so the boot burst stays controlled. Measured AB2: single cold boot ~24s in
# an agent-idle window, so N=5 sequential ≈ 3-6 min total.
#
# Gates: W2/W3/W4/W5 hard before boot AND after boot (W1 observe-only per
# boss strategy 2026-10-22 15:59). Attempt redlines during boot/soak:
#   any GPU free VRAM < 1500MiB / 30000 non-200 or timeout /
#   MemAvailable < 16384MB / foreign 164xx bound -> STOP + save + report CEO.
#
# Subcommands:
#   boot [N=5]   — gate -> staggered create+wait -> post-boot gate -> 5min
#                  soak -> per-device evidence -> stop all -> post-snapshot
#   teardown     — delegates to stage1-boot.sh teardown (sweeps all br-b6r-*)
#
# Evidence dir: BRB6ACCAB_EVID (default /home/kenneth/.openclaw/workspace/logs/br-b6-accAB)
set -uo pipefail
cd "$(dirname "$0")/../.."

SUB="${1:?usage: stage2-boot.sh boot|teardown [N=5]}"
EVID="${BRB6ACCAB_EVID:-/home/kenneth/.openclaw/workspace/logs/br-b6-accAB}"
SAMPLES_CSV="$EVID/samples-30s.csv"
BOOT_CSV="$EVID/boot5-samples.csv"
IMAGE='water-army/redroid@sha256:591296d5656571f346994dc81608ca33744af4d0e9c9876241a8595e70143b55'
NET='br-b6r-ladder'
NET_SUBNET='172.38.210.0/24'   # user device net is 172.38.200.0/24 — no overlap
DATA_ROOT='/var/lib/water-army/redroid-accab'
ADB="$HOME/.local/share/platform-tools/adb"
PER_DEV_TIMEOUT_S=600          # AB2 cold boot ~24s; 600s is very generous
SOAK_S=300

DC() { sg docker -c "docker $*" 2>&1; }

log() { echo "[br-b6accab s2 $SUB] $*"; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- shared redlines (identical semantics to stage1-boot.sh) ---------------
sglang_probe() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000)
  [ "$code" = "200" ] || { log "REDLINE: 30000 health=$code — STOP"; return 1; }
  return 0
}
vram_redline() {
  local g0f g1f
  read -r g0f g1f <<<"$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d ' ')"
  [ -n "${g0f:-}" ] && [ "$g0f" -lt 1500 ] && { log "REDLINE: GPU0 free ${g0f}MiB < 1500 — STOP"; return 1; }
  [ -n "${g1f:-}" ] && [ "$g1f" -lt 1500 ] && { log "REDLINE: GPU1 free ${g1f}MiB < 1500 — STOP"; return 1; }
  return 0
}
mem_redline() {
  local ma
  ma=$(awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo)
  [ "$ma" -ge 16384 ] || { log "REDLINE: MemAvailable ${ma}MB < 16384 — STOP"; return 1; }
  return 0
}
gpu_row() { # -> "g0u,g0f,g1u,g1f"
  nvidia-smi --query-gpu=utilization.gpu,memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d ' ' | tr '\n' ' ' | tr ',' ' ' | awk '{print $1","$2","$3","$4}'
}

# 10s sample row: ts, g0u, g0f, g1u, g1f, memavail, load1, sglang_code, boots
# (boots = per-device flags s1..sN, '1' = boot_completed)
BC=()
row() {
  local ma load code o="" i
  ma=$(awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo)
  load=$(awk '{print $1}' /proc/loadavg)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000)
  for i in $(seq 1 "$N"); do o="${o}${BC[$i]:-0}"; done
  echo "$(ts),$(gpu_row),${ma},${load},${code},${o}" >> "$BOOT_CSV"
}

boot_dev() { # $1=index i (port 16399+i); sets BC[i]=1 on success
  local i="$1" port=$(( 16399 + i )) name="br-b6r-s$i"
  local t0 now elapsed bc st
  "$ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
  t0=$(date +%s)
  while :; do
    now=$(date +%s)
    elapsed=$(( now - t0 ))
    [ "$elapsed" -gt "$PER_DEV_TIMEOUT_S" ] && { log "TIMEOUT: $name after ${elapsed}s"; return 1; }
    # adb TCP devices only appear after `adb connect` (stage1 attempt #2 lesson)
    "$ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
    bc=$("$ADB" -s "127.0.0.1:$port" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || echo "")
    st=$("$ADB" -s "127.0.0.1:$port" get-state 2>/dev/null | tr -d '\r\n' || echo "")
    [ "$st" = "offline" ] && bc=""
    if [ -n "$bc" ] && [ "$bc" != "0" ]; then
      BC[$i]=1; BOOT_T[$i]=$elapsed
      log "BOOT OK $name in ${elapsed}s (adb=$st)"
      row
      return 0
    fi
    row
    sleep 10
  done
}

stop_all() { # $1=N
  local i name
  for i in $(seq 1 "$1"); do
    name="br-b6r-s$i"
    log "stopping $name"
    DC stop -t 30 "$name" >/dev/null 2>&1 || true
    DC logs --tail 200 "$name" > "$EVID/${name}-container.log" 2>&1 || true
  done
  dmesg 2>/dev/null | tail -50 > "$EVID/s2-dmesg-post.txt" || echo "dmesg unavailable (non-root)" > "$EVID/s2-dmesg-post.txt"
}

cmd_boot() {
  N="${1:-5}"
  mkdir -p "$EVID"
  log "gate (W2-W5 hard; W1 observe-only — boss strategy 2026-10-22 15:59)"
  BRB6ACCAB_W1_SOFT=1 bash scripts/br-b6accab/window-check.sh "$SAMPLES_CSV" || { log "NO-GO: W2-W5 gate failed"; return 1; }
  local bound
  bound=$(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(164[0-9]{2})\s*$' | head -5 || true)
  [ -z "$bound" ] || { log "NO-GO: 164xx bound: $bound"; return 1; }
  vram_redline || return 1
  sglang_probe || return 1
  mem_redline || return 1
  node apps/api/src/cli/preflight.js >/dev/null 2>&1 || { log "NO-GO: host preflight failed"; return 1; }
  log "GO: N=$N (staggered, one device mid-boot at a time)"

  if ! DC network inspect "$NET" >/dev/null 2>&1; then
    DC network create --subnet "$NET_SUBNET" "$NET" >/dev/null || { log "FATAL: cannot create $NET"; return 2; }
  fi
  log "network $NET ready (subnet $NET_SUBNET)"

  echo "ts,g0_util,g0_mem_free,g1_util,g1_mem_free,mem_avail_mb,load1,sglang_code,boots" > "$BOOT_CSV"
  log "PRE-SNAPSHOT gpu: $(gpu_row) | memavail: $(awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo)MB | 30000: $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health)"

  local i name port data_dir
  for i in $(seq 1 "$N"); do
    name="br-b6r-s$i"; port=$(( 16399 + i )); data_dir="$DATA_ROOT/s$i"
    DC ps -q --filter "name=^${name}\$" >/dev/null 2>&1 && { log "FATAL: $name exists — teardown first"; return 2; }
    [ -d "$data_dir" ] && { log "FATAL: data dir exists ($data_dir) — teardown first"; return 2; }
    mkdir -p "$data_dir"
    log "creating $name (ADB 127.0.0.1:$port, product spec)"
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
      stop_all "$i"
      return 2
    fi
    boot_dev "$i" || { log "STOP: $name boot failed — aborting, saving logs"; stop_all "$i"; return 1; }
  done
  log "ALL $N BOOTED (per-device s: $(for i in $(seq 1 "$N"); do printf 's%s=%ss ' "$i" "${BOOT_T[$i]}"; done))"

  # post-boot hard-gate re-check (W2/W3/W4/W5)
  log "POST-BOOT GATE CHECK (W2/W3/W4/W5)"
  vram_redline || { log "STOP: vram redline post-boot"; stop_all "$N"; return 1; }
  sglang_probe || { log "STOP: 30000 redline post-boot"; stop_all "$N"; return 1; }
  mem_redline || { log "STOP: mem redline post-boot"; stop_all "$N"; return 1; }
  for p in $(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(164[0-9]{2})\s*$' | sed 's/^://' | sort -u); do
    case "$p" in 1640[0-4]) ;; *) log "REDLINE-POST: foreign 164xx bound: $p"; stop_all "$N"; return 1 ;; esac
  done
  log "POST-BOOT GATE: PASS (VRAM ok / 30000=200 / MemAvail ok / 164xx ours-only)"

  # 5min soak with redlines (GPU0 VRAM floor here = the 5-device delta vs PRE-SNAPSHOT)
  log "soak ${SOAK_S}s (10s sampling, redlines)"
  local end
  end=$(( $(date +%s) + SOAK_S ))
  while [ "$(date +%s)" -lt "$end" ]; do
    vram_redline || { log "STOP: vram redline during soak"; break; }
    sglang_probe || { log "STOP: 30000 redline during soak"; break; }
    mem_redline || { log "STOP: mem redline during soak"; break; }
    row
    sleep 10
  done

  # per-device evidence (renderD fd at post-soak + display id + logcat tail)
  for i in $(seq 1 "$N"); do
    name="br-b6r-s$i"; port=$(( 16399 + i ))
    "$ADB" connect "127.0.0.1:$port" >/dev/null 2>&1 || true
    local sfpid
    sfpid=$("$ADB" -s "127.0.0.1:$port" shell pidof surfaceflinger 2>/dev/null | tr -d '\r' | head -1)
    if [ -n "$sfpid" ]; then
      "$ADB" -s "127.0.0.1:$port" shell "ls -l /proc/$sfpid/fd 2>/dev/null | grep -c renderD" > "$EVID/${name}-render-fd.txt" 2>&1 || echo "?" > "$EVID/${name}-render-fd.txt"
    else
      echo "surfaceflinger pid not found" > "$EVID/${name}-render-fd.txt"
    fi
    "$ADB" -s "127.0.0.1:$port" shell getprop ro.build.display.id > "$EVID/${name}-getprop.txt" 2>&1 || true
    "$ADB" -s "127.0.0.1:$port" shell logcat -d -t 20 2>/dev/null > "$EVID/${name}-logcat.txt" || true
    "$ADB" disconnect "127.0.0.1:$port" >/dev/null 2>&1 || true
  done

  stop_all "$N"
  log "POST-SNAPSHOT gpu: $(gpu_row) | memavail: $(awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo)MB (post-stop; use soak-min for 5-device VRAM delta)"
  log "evidence in $EVID/br-b6r-s*-* + $BOOT_CSV"
  return 0
}

case "$SUB" in
  boot) cmd_boot "${2:-5}" ;;
  teardown) bash scripts/br-b6accab/stage1-boot.sh teardown ;;
  *) log "unknown subcommand: $SUB"; exit 2 ;;
esac

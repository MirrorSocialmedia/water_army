#!/usr/bin/env bash
# BR-B6-Acceptance A+B — Stage 1/2 controlled redroid boot harness (AB2/AB3).
#
# Isolation contract (boss-approved 2026-10-22):
#   - prefix br-b6r-* only; port band 16400-16499 only; own bridge br-b6r-ladder
#   - NO real accounts, NO third-party platform interaction (device-only boot)
#   - NEVER touches: SGLang 30000 (read-only health), user compose, C-item br-b6e-*
#   - product container spec replicated from redroid-service.js (digest-pinned
#     image, privileged, 4G RAM, 2 vCPU, nvidia all-GPU, /data bind, 127.0.0.1 ADB)
#
# Subcommands:
#   gate      — W2-W5 HARD gate + port + host preflight. W1 (GPU util window)
#               is OBSERVE-ONLY since boss strategy 2026-10-22 15:59: SGLang
#               load = agents' own inference, so waiting for a util window is
#               self-locking. W2/W3/W4/W5 stay hard; re-verified post-boot.
#               Exit 0 = GO, 1 = NO-GO.
#   boot      — full controlled boot: gate -> create -> wait boot (10s sample,
#               30s 30000 health) -> 5min soak -> stop -> save evidence.
#   teardown  — remove ALL br-b6r-* artifacts (containers, network, data root).
#
# Evidence dir: BRB6ACCAB_EVID (default /home/kenneth/.openclaw/workspace/logs/br-b6-accAB)
set -uo pipefail
cd "$(dirname "$0")/../.."

SUB="${1:?usage: stage1-boot.sh gate|boot|teardown}"
EVID="${BRB6ACCAB_EVID:-/home/kenneth/.openclaw/workspace/logs/br-b6-accAB}"
SAMPLES_CSV="$EVID/samples-30s.csv"
BOOT_CSV="$EVID/boot-samples.csv"
IMAGE='water-army/redroid@sha256:591296d5656571f346994dc81608ca33744af4d0e9c9876241a8595e70143b55'
NET='br-b6r-ladder'
NET_SUBNET='172.38.210.0/24'   # user device net is 172.38.200.0/24 — no overlap
DATA_ROOT='/var/lib/water-army/redroid-accab'
ADB="$HOME/.local/share/platform-tools/adb"
BOOT_TIMEOUT_S=1800            # product health window (R5 cold boot ~24min)
SOAK_S=300                     # 5min post-boot soak for GPU0 render peak
DC() { sg docker -c "docker $*" 2>&1; }

log() { echo "[br-b6accab $SUB] $*"; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- 30000 redline probe: any 5xx/timeout during an attempt = STOP + alert ---
sglang_probe() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000)
  if [ "$code" != "200" ]; then
    log "REDLINE: 30000 health=$code — STOP condition met (save logs, report CEO)"
    return 1
  fi
  return 0
}

gpu_row() { # -> "g0u,g0f,g1u,g1f"
  nvidia-smi --query-gpu=utilization.gpu,memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d ' ' | tr '\n' ' ' | tr ',' ' ' | awk '{print $1","$2","$3","$4}'
}
host_row() { # -> "memavail_mb,load1"
  awk '/MemAvailable/ {a=int($2/1024)} END{print a}' /proc/meminfo; awk '{print $1}' /proc/loadavg
}

stop_and_evidence() { # $1=container name — stop + save logs (normal end or redline stop)
  local name="$1"
  log "stopping $name"
  DC stop -t 30 "$name" > /dev/null 2>&1 || true
  DC logs --tail 200 "$name" > "$EVID/${name}-container.log" 2>&1 || true
  dmesg 2>/dev/null | tail -50 > "$EVID/${name}-dmesg-post.txt" || true
  log "evidence in $EVID/${name}-*"
}

# --- vram redline: any GPU free < 1500 MiB ----------------------------------
vram_redline() {
  local g0f g1f
  read -r g0f g1f <<<"$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | tr -d ' ')"
  if [ -n "$g0f" ] && [ "$g0f" -lt 1500 ]; then log "REDLINE: GPU0 free ${g0f}MiB < 1500 — STOP"; return 1; fi
  if [ -n "$g1f" ] && [ "$g1f" -lt 1500 ]; then log "REDLINE: GPU1 free ${g1f}MiB < 1500 — STOP"; return 1; fi
  return 0
}

cmd_gate() {
  log "gate (W2-W5 hard; W1 observe-only — boss strategy 2026-10-22 15:59)"
  BRB6ACCAB_W1_SOFT=1 bash scripts/br-b6accab/window-check.sh "$SAMPLES_CSV" || { log "NO-GO: W2-W5 gate failed"; return 1; }
  # ADB port band preflight (16400 = s1 ... 16404 = s5)
  local bound p
  bound=$(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(164[0-9]{2})\s*$' | head -5 || true)
  if [ -n "$bound" ]; then log "NO-GO: 164xx bound: $bound"; return 1; fi
  for p in 16400 16401 16402 16403 16404; do
    ss -ltn 2>/dev/null | grep -q "127.0.0.1:$p" && { log "NO-GO: port $p bound"; return 1; }
  done
  # redlines that must hold even inside a window
  vram_redline || return 1
  sglang_probe || return 1
  # host preflight (R5 CLI, read-only)
  node apps/api/src/cli/preflight.js >/dev/null 2>&1 || { log "NO-GO: host preflight failed"; return 1; }
  # parallelism awareness: report C-item presence (informational, not a gate)
  local citem
  citem=$(DC ps -q --filter 'name=br-b6e-' | wc -l)
  log "GO: window open, 164xx free, redlines hold, host preflight PASS (C-item br-b6e-* containers: $citem — known active test, not residue)"
  return 0
}

cmd_boot() {
  local name="${1:-br-b6r-s1}" adb_port="${2:-16400}"
  local data_dir="$DATA_ROOT/${name#br-b6r-}"
  mkdir -p "$EVID"
  log "GATE first (window must be OPEN)"
  cmd_gate || { log "ABORT: gate failed — not booting outside window"; return 1; }

  # bridge (idempotent)
  if ! DC network inspect "$NET" >/dev/null 2>&1; then
    DC network create --subnet "$NET_SUBNET" "$NET" >/dev/null || { log "FATAL: cannot create $NET"; return 2; }
  fi
  log "network $NET ready (subnet $NET_SUBNET)"

  # pre-snapshot
  log "PRE-SNAPSHOT gpu: $(gpu_row) | host: $(host_row | paste -sd,) | 30000: $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health)"
  dmesg 2>/dev/null | tail -50 > "$EVID/${name}-dmesg-pre.txt" || echo "dmesg unavailable (non-root)" > "$EVID/${name}-dmesg-pre.txt"

  [ -d "$data_dir" ] && { log "FATAL: data dir exists ($data_dir) — refusing to clobber; teardown first"; return 2; }
  mkdir -p "$data_dir"

  log "creating container $name (ADB 127.0.0.1:$adb_port, product spec)"
  if ! DC run -d \
      --name "$name" \
      --privileged \
      --memory 4294967296 \
      --cpus 2 \
      --gpus all \
      --network "$NET" \
      -p "127.0.0.1:$adb_port:5555" \
      -v "$data_dir:/data" \
      "$IMAGE" \
      androidboot.redroid_width=720 \
      androidboot.redroid_height=1280 \
      androidboot.redroid_dpi=320 \
      androidboot.redroid_fps=30 \
      androidboot.redroid_gpu_mode=host > "$EVID/${name}-create.log" 2>&1; then
    log "FATAL: docker create failed"; cat "$EVID/${name}-create.log" | tail -10
    return 2
  fi
  log "container created: $(DC ps -q --filter "name=^${name}\$" | head -1)"

  # boot wait: 10s sample + 30s 30000 health + redlines; success =
  # ADB wire handshake (get-state=device) + sys.boot_completed=1
  echo "ts,g0_util,g0_mem_free,g1_util,g1_mem_free,mem_avail_mb,load1,sglang_code,boot_completed,adb_state" > "$BOOT_CSV"
  local t0=$(date +%s) next_health=0 bc=0 st=
  while :; do
    local now
    now=$(date +%s)
    local elapsed=$(( now - t0 ))
    [ "$elapsed" -gt "$BOOT_TIMEOUT_S" ] && { log "TIMEOUT: ${BOOT_TIMEOUT_S}s health window exhausted — saving logs"; break; }
    if [ "$now" -ge "$next_health" ]; then
      sglang_probe || { log "STOP: 30000 redline during boot — saving logs"; break; }
      next_health=$(( now + 30 ))
    fi
    vram_redline || { log "STOP: vram redline during boot — saving logs"; break; }
    bc=$("$ADB" -s "127.0.0.1:$adb_port" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || echo "")
    st=$("$ADB" -s "127.0.0.1:$adb_port" get-state 2>/dev/null | tr -d '\r\n' || echo "")
    [ "$st" = "offline" ] && bc=""
    [ -n "$bc" ] && [ "$bc" != "0" ] && { log "BOOT OK in ${elapsed}s (boot_completed=$bc, adb=$st)"; break; }
    local g h
    g=$(gpu_row); read -r _ h <<<"$(host_row | tr '\n' ' ')"
    echo "$(ts),${g},$(awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo),$(awk '{print $1}' /proc/loadavg),$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000),${bc:-},${st:-}" >> "$BOOT_CSV"
    sleep 10
  done

  # post-boot hard-gate re-check (W2/W3/W4/W5) — boss 2026-10-22 15:59:
  # gate verified once BEFORE boot and once AFTER boot
  if [ -n "${bc:-}" ] && [ "$bc" != "0" ]; then
    log "POST-BOOT GATE CHECK (W2/W3/W4/W5)"
    vram_redline || { log "STOP: vram redline post-boot"; stop_and_evidence "$name"; return 1; }
    sglang_probe || { log "STOP: 30000 redline post-boot"; stop_and_evidence "$name"; return 1; }
    local ma_post
    ma_post=$(awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo)
    [ "$ma_post" -ge 16384 ] || { log "REDLINE-POST: MemAvailable ${ma_post}MB < 16384"; stop_and_evidence "$name"; return 1; }
    local p
    for p in $(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(164[0-9]{2})\s*$' | sed 's/^://' | sort -u); do
      [ "$p" = "$adb_port" ] || { log "REDLINE-POST: foreign 164xx bound: $p"; stop_and_evidence "$name"; return 1; }
    done
    log "POST-BOOT GATE: PASS (W2 VRAM ok / W3 30000=200 / W4 MemAvail ${ma_post}MB / W5 164xx ours-only)"
  fi

  # 5min soak (if booted) for GPU0 render peak
  if [ -n "${bc:-}" ] && [ "$bc" != "0" ]; then
    log "soak ${SOAK_S}s (sampling 10s)"
    local soak_end=$(( $(date +%s) + SOAK_S ))
    while [ "$(date +%s)" -lt "$soak_end" ]; do
      vram_redline || { log "STOP: vram redline during soak"; break; }
      local g
      g=$(gpu_row)
      echo "$(ts),${g},$(awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo),$(awk '{print $1}' /proc/loadavg),$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000),1,soak" >> "$BOOT_CSV"
      sleep 10
    done
    # in-device render check (R5 contract): SurfaceFlinger holds renderD128 fd
    local sfpid
    sfpid=$("$ADB" -s "127.0.0.1:$adb_port" shell pidof surfaceflinger 2>/dev/null | tr -d '\r' | head -1)
    if [ -n "$sfpid" ]; then
      "$ADB" -s "127.0.0.1:$adb_port" shell "ls -l /proc/$sfpid/fd 2>/dev/null | grep -c renderD" > "$EVID/${name}-render-fd.txt" 2>&1 || true
    else
      echo "surfaceflinger pid not found" > "$EVID/${name}-render-fd.txt"
    fi
    "$ADB" -s "127.0.0.1:$adb_port" shell getprop ro.build.display.id > "$EVID/${name}-getprop.txt" 2>&1 || true
  fi

  # stop + evidence
  stop_and_evidence "$name"
  log "POST-SNAPSHOT gpu: $(gpu_row) | host: $(host_row | paste -sd,)"
  [ -n "${bc:-}" ] && [ "$bc" != "0" ] && return 0
  return 1
}

cmd_teardown() {
  log "removing br-b6r-* artifacts (containers -> network -> data root)"
  local c
  for c in $(DC ps -aq --filter 'name=br-b6r-'); do
    log "rm container $c"; DC rm -f "$c" >/dev/null 2>&1 || true
  done
  # network-membership sweep (catches misnamed containers attached to our bridge)
  if DC network inspect "$NET" >/dev/null 2>&1; then
    for c in $(DC network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$NET" 2>/dev/null); do
      log "rm network-attached container $c"; DC rm -f "$c" >/dev/null 2>&1 || true
    done
  fi
  DC network rm "$NET" >/dev/null 2>&1 && log "rm network $NET" || log "network $NET absent (ok)"
  if [ -d "$DATA_ROOT" ]; then
    log "rm data root $DATA_ROOT (alpine root shim for root-owned files, then host rmdir)"
    if [ -n "$(DC images -q alpine:3.20 2>/dev/null)" ]; then
      DC run --rm -v "$DATA_ROOT:/wipe" alpine:3.20 sh -c 'rm -rf /wipe/* /wipe/.[!.]* 2>/dev/null' >/dev/null 2>&1 || true
    fi
    rm -rf "$DATA_ROOT" 2>/dev/null || true
    rmdir "$DATA_ROOT" 2>/dev/null || true
  fi
  # verify zero residue (our artifacts only)
  local left
  left=$(DC ps -aq --filter 'name=br-b6r-' | wc -l)
  DC network inspect "$NET" >/dev/null 2>&1 && left=$(( left + 1 ))
  if [ "$left" -eq 0 ] && [ ! -d "$DATA_ROOT" ]; then
    log "TEARDOWN CLEAN: zero br-b6r-* residue"
    return 0
  fi
  log "FATAL: residue remains: $left"
  return 1
}

case "$SUB" in
  gate) cmd_gate ;;
  boot) cmd_boot "${2:-br-b6r-s1}" "${3:-16400}" ;;
  teardown) cmd_teardown ;;
  *) log "unknown subcommand: $SUB"; exit 2 ;;
esac

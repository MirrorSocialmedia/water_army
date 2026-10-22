#!/usr/bin/env bash
# RAM-G2 G2 (Phase D/E) — shared helpers for the ladder harness.
#
# Phase D runs the PRODUCT gate live: every boot goes through
#   POST /api/devices/redroid (scratch API @16490, repo HEAD code) —
# the gate's ADMIT_LUA decides BEFORE any side effect. We never docker-run
# devices directly (that was A10; here the gate IS the subject under test).
#
# Isolation contract (boss hard lines, identical to G1/A10):
#   - device names redroid-brb6g-l1..l10 (app naming contract redroid-*);
#     ADB ports 16400-16409 (127.0.0.1 only, product constant)
#   - bridge br-b6g-ladder 172.38.221.0/24 (MD-specified; G1 used it too,
#     torn down after G1 — recreated idempotently)
#   - dataDir root /var/lib/water-army/redroid-ramgate-g2 (isolated from
#     G1's -g1 and the product /var/lib/water-army/redroid)
#   - scratch infra ports 16490 (api) / 16494 (pg) / 16495 (redis) /
#     16496 (worker health) — all inside the approved 16400-16499 window
#   - NEVER touches: SGLang 30000 (read-only health + tiny completion),
#     user compose water-army-*, Identity data under /var/lib/water-army/redroid
#   - scratch processes: PIDFILE only (G1 incident lesson — pgrep patterns
#     match container host processes; /proc/<pid>/cgroup pre-check if any
#     pattern kill is ever even considered)
#
# CTO-idle-during-boot: the whole staggered boot is ONE long command
# (ladder.sh); the operator generates no LLM output between kickoff and
# return (GPU-inference window discipline, A10 proven).

R2_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R2_REPO="$(cd "$R2_DIR/../.." && pwd)"
R2_EVID="${R2_EVID:-/home/kenneth/.openclaw/workspace/logs/ramgate-g2}"
R2_SCRATCH_STATE="${R2_SCRATCH_STATE:-/tmp/ramgate-g2}"   # pidfiles + cookies (chmod 700)
R2_SECRETS="${R2_SECRETS:-/tmp/ramgate-g2/env.sh}"        # chmod 600, never in repo

R2_API="http://127.0.0.1:16490"
R2_ADB="$HOME/.local/share/platform-tools/adb"
R2_NET="br-b6g-ladder"
R2_NET_SUBNET="172.38.221.0/24"
R2_DATA_ROOT="/var/lib/water-army/redroid-ramgate-g2"
R2_N=10                          # ladder target
R2_BOOT_TIMEOUT_S=600            # A10 measured 24-26s per device; 600s very generous
R2_BOOT_POLL_S=10
R2_SOAK_S=300
R2_SOAK_POLL_S=30
R2_REDLINE_MEM_MB=16384          # HARD_FLOOR — a host-level stop condition (task)
R2_REDLINE_VRAM_MIB=1500
R2_OURS_PORTS="16400 16401 16402 16403 16404 16405 16406 16407 16408 16409 16490 16494 16495 16496"
R2_TEMPLATE_NAME="g2-host-gpu"
R2_IMAGE="water-army/redroid:14.0.0-240527-matrixa-r3"   # = digest 591296d5 (A10 10/10 image)

DC() { sg docker -c "docker $*" 2>&1; }
log() { echo "[ramgate-g2 $SUBCMD] $(date -u +%H:%M:%S) $*" | tee -a "$R2_EVID/harness.log"; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

mem_avail_mb() { awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo; }
load1() { awk '{print $1}' /proc/loadavg; }
sglang_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000; }
gpu_row() { # -> "g0u g0f g1u g1f"
  nvidia-smi --query-gpu=utilization.gpu,memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d ' ' | tr '\n' ' ' | tr ',' ' ' | awk '{print $1","$2","$3","$4}'
}

# ---- redlines (hard, observed + recorded; stop NEW loads only) ----
mem_redline() {
  local ma; ma=$(mem_avail_mb)
  if [ "$ma" -lt "$R2_REDLINE_MEM_MB" ]; then
    log "REDLINE R-MEM: MemAvailable ${ma}MB < ${R2_REDLINE_MEM_MB} — STOP NEW LOADS (task stop condition)"
    return 1
  fi
  return 0
}
vram_redline() {
  local g0f g1f
  read -r g0f g1f <<<"$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d ' ')"
  if [ -n "${g0f:-}" ] && [ "$g0f" -lt "$R2_REDLINE_VRAM_MIB" ]; then
    log "REDLINE R-VRAM: GPU0 free ${g0f}MiB < $R2_REDLINE_VRAM_MIB — STOP NEW LOADS"; return 1
  fi
  if [ -n "${g1f:-}" ] && [ "$g1f" -lt "$R2_REDLINE_VRAM_MIB" ]; then
    log "REDLINE R-VRAM: GPU1 free ${g1f}MiB < $R2_REDLINE_VRAM_MIB — STOP NEW LOADS"; return 1
  fi
  return 0
}
sglang_redline() {
  local code; code=$(sglang_code)
  if [ "$code" != "200" ]; then
    log "REDLINE R-SGL: 30000 health=$code (want 200) — STOP NEW LOADS"; return 1
  fi
  return 0
}
foreign_port_redline() {
  local p ours
  for p in $(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(164[0-9]{2})\s*$' | sed 's/^://' | sort -u); do
    ours=0
    for o in $R2_OURS_PORTS; do [ "$p" = "$o" ] && ours=1; done
    if [ "$ours" = "0" ]; then
      log "REDLINE R-PORT: foreign 164xx bound: $p — STOP NEW LOADS"; return 1
    fi
  done
  return 0
}

# ---- API helpers (cookie session) ----
api_login() { # [$1=cookie_file]
  local resp ck="${1:-$R2_SCRATCH_STATE/cookie.txt}"
  [ -s "$ck" ] && return 0
  [ -f "$R2_SECRETS" ] || { log "FATAL: $R2_SECRETS missing"; return 1; }
  # shellcheck disable=SC1090
  . "$R2_SECRETS"
  resp=$(curl -s -c "$ck" -X POST "$R2_API/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$G2_ADMIN_USER\",\"password\":\"$G2_ADMIN_PASS\"}")
  echo "$resp" | grep -q '"role"' || { log "FATAL: login failed: $(echo "$resp" | head -c 200)"; return 1; }
  log "api login ok (admin)"
}
api() { # $1=method $2=path [$3=body] -> stdout; rc!=0 on http error; body on stderr-adjacent? NO: prints body, sets API_CODE
  local method="$1" path="$2" body="${3:-}" cookie="$R2_SCRATCH_STATE/cookie.txt"
  api_login || return 1
  local args=( -s -w '\n%{http_code}' -b "$cookie" --max-time "${R2_API_TIMEOUT:-30}" "$R2_API$path" )
  [ -n "$body" ] && args+=( -H 'Content-Type: application/json' -d "$body" )
  case "$method" in
    GET) API_OUT=$(curl "${args[@]}") ;;
    POST) API_OUT=$(curl -X POST "${args[@]}") ;;
    PUT) API_OUT=$(curl -X PUT "${args[@]}") ;;
    DELETE) API_OUT=$(curl -X DELETE "${args[@]}") ;;
    *) return 9 ;;
  esac
  API_CODE="${API_OUT##*$'\n'}"
  API_BODY="${API_OUT%$'\n'*}"
  [ "$API_CODE" -ge 200 ] 2>/dev/null && [ "$API_CODE" -lt 300 ]
}
gate_status() { api GET '/api/system/ram-gate'; echo "$API_BODY"; }
gate_decisions() { api GET '/api/system/ram-gate/decisions?limit=30'; echo "$API_BODY"; }

# ---- CSV sampling row (A10 cadence format + gates columns) ----
BC=()
BT=()   # boot time seconds per device
row() {
  local o="" i
  for i in $(seq 1 "$R2_N"); do o="${o}${BC[$i]:-0}"; done
  echo "$(ts),$(gpu_row),$(mem_avail_mb),$(load1),$(sglang_code),${o}" >> "$R2_EVID/ladder-samples.csv"
}
init_csv() {
  echo "ts,g0_util,g0_mem_free,g1_util,g1_mem_free,mem_avail_mb,load1,sglang_code,boots" > "$R2_EVID/ladder-samples.csv"
}
up_count() { local c=0 i; for i in $(seq 1 "$R2_N"); do [ "${BC[$i]:-0}" = "1" ] && c=$((c+1)); done; echo "$c"; }

dev_name() { echo "redroid-brb6g-l$1"; }
dev_port() { echo $(( 16399 + $1 )); }

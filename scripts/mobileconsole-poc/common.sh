#!/usr/bin/env bash
# =============================================================================
# Mobile Console (MC) scratch stack — shared helpers
#
# Recipe = G1/G2 (RAM Gate) proven harness; isolation per task MD:
#   - device prefix redroid-brmc-*; ADB 16500-16549 (127.0.0.1 only)
#   - bridge br-mc-ladder 172.38.222.0/24 (+ br-mc-probe 172.38.223.0/24)
#   - dataDir root /var/lib/water-army/redroid-mobileconsole
#   - scratch infra 16490 (api) / 16494 (pg) / 16495 (redis)
#   - NEVER touches: SGLang 30000 (read-only health), user compose water-army-*,
#     user ADB band 15000-15999, forbidden ports 15532/15432/3001/3011/3100/3008/9800/30000
#   - scratch processes: PIDFILE only (G1 pgrep-incident lesson)
#   - CTO-idle-during-boot: the whole boot+PoC is ONE long command (run-poc.sh)
# =============================================================================
MC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_REPO="$(cd "$MC_DIR/../.." && pwd)"
MC_EVID="${MC_EVID:-/home/kenneth/.openclaw/workspace/logs/mobileconsole-poc}"
MC_STATE="${MC_STATE:-/tmp/mobileconsole}"            # pidfiles + cookies (chmod 700)
MC_SECRETS="$MC_STATE/env.sh"                          # chmod 600, never in repo
MC_API="http://127.0.0.1:16490"
MC_ADB="$HOME/.local/share/platform-tools/adb"
MC_NET="br-mc-ladder"
MC_NET_SUBNET="172.38.222.0/24"
MC_PROBE_NET="br-mc-probe"
MC_PROBE_SUBNET="172.38.223.0/24"
MC_DATA_ROOT="/var/lib/water-army/redroid-mobileconsole"
MC_TEMPLATE_NAME="mc-host-gpu"
MC_IMAGE="water-army/redroid:14.0.0-240527-matrixa-r3"   # = digest 591296d5 (A10 10/10 image)
MC_PGC="mc-scratch-pg"
MC_RDC="mc-scratch-redis"
MC_PG_URL="postgresql://postgres:postgres@127.0.0.1:16494/water_army_mc"
MC_RD_URL="redis://127.0.0.1:16495"
MC_DEVICE_NAME="redroid-brmc-poc"
MC_ADB_RANGE_START=16500
MC_ADB_RANGE_END=16549
MC_SIDECAR_PORT=16545     # PoC sidecar HTTP/WS (host loopback)
MC_FWD_VIDEO=16546        # adb forward host port (video)
MC_FWD_CONTROL=16547      # adb forward host port (control)
MC_JAR_PATH="/tmp/scrcpy-server-v5.0.1"                # pinned, sha256 in ADR-019
MC_JAR_SHA256="764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536"
MC_BOOT_TIMEOUT_S=1200    # cold boot ~13min on A10 (TOOLS.md); generous ceiling

DC() { # single command string (docker receives one properly-quoted string)
  sg docker -c "docker $1" 2>&1
}
log() { local tag="$1"; shift; echo "[mobileconsole $tag] $(date -u +%H:%M:%S) $*" | tee -a "$MC_EVID/harness.log"; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mem_avail_mb() { awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo; }
load1() { awk '{print $1}' /proc/loadavg; }
sglang_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000; }
gpu_free_mib() { nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | tr '\n' ' ' | tr -d ' '; }

# ---- redlines (G2 discipline): stop NEW loads, never kill existing ----
mem_redline() {
  local ma; ma=$(mem_avail_mb)
  [ "$ma" -lt 16384 ] && { log redline "R-MEM: MemAvailable ${ma}MB < 16384 — STOP"; return 1; }
  return 0
}
vram_redline() {
  local g
  for g in $(gpu_free_mib); do
    [ -n "$g" ] && [ "$g" -lt 1500 ] && { log redline "R-VRAM: GPU free ${g}MiB < 1500 — STOP"; return 1; }
  done
  return 0
}
sglang_redline() {
  local c; c=$(sglang_code)
  [ "$c" != "200" ] && { log redline "R-SGL: 30000 health=$c (want 200) — STOP"; return 1; }
  return 0
}
foreign_port_redline() {
  local p ours
  # ours: scratch infra 16490/16494/16495, PoC sidecar 16545, adb forwards 16546/16547,
  # AND our device ADB band 16500-16549 (product publishes device adbd on 127.0.0.1)
  local adb_ours=""
  local n
  for n in $(seq 16500 16549); do adb_ours="$adb_ours $n"; done
  for p in $(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(16[45][0-9]{2})\s*$' | sed 's/^://' | sort -u); do
    case " 16490 16494 16495 16545 16546 16547$adb_ours " in *" $p "*) continue;; esac
    log redline "R-PORT: foreign 164xx/165xx bound: $p — STOP"
    return 1
  done
  return 0
}

# ---- API helpers (cookie session) ----
api_login() { # [$1=cookie_file]
  local resp ck="${1:-$MC_STATE/cookie.txt}"
  [ -s "$ck" ] && return 0
  [ -f "$MC_SECRETS" ] || { log FATAL "$MC_SECRETS missing"; return 1; }
  # shellcheck disable=SC1090
  . "$MC_SECRETS"
  resp=$(curl -s -c "$ck" -X POST "$MC_API/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$MC_ADMIN_USER\",\"password\":\"$MC_ADMIN_PASS\"}")
  echo "$resp" | grep -q '"role"' || { log FATAL "login failed: $(echo "$resp" | head -c 200)"; return 1; }
  log api "login ok ($MC_ADMIN_USER)"
}
api() { # $1=method $2=path [$3=body] -> stdout body; sets API_CODE
  local method="$1" path="$2" body="${3:-}" cookie="$MC_STATE/cookie.txt"
  api_login || return 1
  local args=( -s -w '\n%{http_code}' -b "$cookie" --max-time 30 "$MC_API$path" )
  [ -n "$body" ] && args+=( -H 'Content-Type: application/json' -d "$body" )
  case "$method" in
    GET) API_OUT=$(curl "${args[@]}") ;;
    POST) API_OUT=$(curl -X POST "${args[@]}") ;;
    PUT) API_OUT=$(curl -X PUT "${args[@]}") ;;
    *) return 2 ;;
  esac
  API_CODE=$(echo "$API_OUT" | tail -1)
  echo "$API_OUT" | sed '$d'
}

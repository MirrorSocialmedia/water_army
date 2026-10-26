#!/usr/bin/env bash
# =============================================================================
# realdevice-master (rdev) scratch stack — shared helpers
#
# Discipline = MC ticket (ADR-019/023) + task MD:
#   - prefixes: containers rdev-*, devices redroid-rdev-d*, network br-rdev-ladder
#   - ADB 16500-16549 (127.0.0.1 only, product-published)
#   - NEVER touches: SGLang 30000 (read-only health), user compose water-army-*,
#     forbidden ports 15532/15432/3001/3011/3100/3008/9800/30000 (+3012 user web)
#   - scratch processes: PIDFILE only (never pgrep-match)
#   - RAM redline before every boot batch
# =============================================================================
RD_REPO=/home/kenneth/.openclaw/workspace/water_army
RD_EVID="$RD_REPO/logs/realdevice-master"
RD_STATE="${RD_STATE:-/tmp/rdev-state}"
RD_SECRETS="$RD_STATE/env.sh"
RD_API="http://127.0.0.1:16490"
RD_WEB="http://127.0.0.1:16492"
RD_ADB="$HOME/.local/share/platform-tools/adb"
RD_NET="br-rdev-ladder"
RD_NET_SUBNET="172.38.222.0/24"
RD_DATA_ROOT="/var/lib/water-army/redroid-rdev"
RD_IMAGE="water-army/redroid:14.0.0-240527-matrixa-r3"
RD_PGC="rdev-pg"
RD_RDC="rdev-redis"
RD_DB="water_army_rdev"
RD_PG_URL="postgresql://postgres:postgres@127.0.0.1:16494/$RD_DB"
RD_JAR_PATH="/tmp/scrcpy-server-v5.0.1"
RD_JAR_SHA256="764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536"
RD_JAR_BYTES=733930

D() { docker "$@" 2>&1; }
log() { local tag="$1"; shift; echo "[rdev $tag] $(date -u +%H:%M:%S) $*" | tee -a "$RD_EVID/harness.log"; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mem_avail_mb() { awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo; }

# ---- redlines: stop NEW loads, never kill existing ----
mem_redline() {
  local ma; ma=$(mem_avail_mb)
  if [ "$ma" -lt 16384 ]; then log redline "R-MEM: MemAvailable ${ma}MB < 16384 — STOP"; return 1; fi
  log mem "MemAvailable ${ma}MB (>= 16384) OK"
  return 0
}
sglang_redline() {
  local c; c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000)
  if [ "$c" != "200" ]; then log redline "R-SGL: 30000 health=$c (want 200) — STOP"; return 1; fi
  log sglang "30000 health=200 OK"
  return 0
}
user_stack_redline() {
  local n
  n=$(docker ps --format '{{.Names}}' | grep -c '^water-army-')
  if [ "$n" -ne 5 ]; then log redline "R-STACK: user stack water-army-* = $n (want 5) — STOP"; return 1; fi
  log stack "user stack water-army-* 5/5 OK"
  return 0
}
# foreign-port check: bound 164xx/165xx ports must be ours
RD_OURS="16490 16491 16492 16493 16494 16495 16460 16461 16462 16463 16464 16465 16466 16467 16468 16469"
foreign_port_redline() {
  local p adb_ours="" n
  for n in $(seq 16500 16549); do adb_ours="$adb_ours $n"; done
  for p in $(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(16[45][0-9]{2})\s*$' | sed 's/^://' | sort -u); do
    case " $RD_OURS$adb_ours " in *" $p "*) continue;; esac
    log redline "R-PORT: foreign 164xx/165xx bound: $p — STOP"; return 1
  done
  return 0
}
preboot_redlines() { mem_redline && sglang_redline && user_stack_redline && foreign_port_redline; }

# ---- stop by pidfile (scratch only) ----
stop_by_pidfile() {
  local pf="$1"
  if [ -f "$pf" ]; then
    local pid; pid=$(cat "$pf")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # cgroup guard (2026-10-23 lesson): never SIGKILL a docker-scoped pid
      local cg; cg=$(cat "/proc/$pid/cgroup" 2>/dev/null | head -1 || true)
      case "$cg" in *docker*) log FATAL "refusing to kill $pid — cgroup is docker-scoped: $cg"; return 1;; esac
      kill "$pid" 2>/dev/null || true
      for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pf"
  fi
}

# ---- API helpers (cookie session) ----
api_login() { # [$1=cookie_file]
  local resp ck="${1:-$RD_STATE/cookie.txt}"
  [ -s "$ck" ] && return 0
  [ -f "$RD_SECRETS" ] || { log FATAL "$RD_SECRETS missing"; return 1; }
  # shellcheck disable=SC1090
  . "$RD_SECRETS"
  resp=$(curl -s -c "$ck" -X POST "$RD_API/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$RD_ADMIN_USER\",\"password\":\"$RD_ADMIN_PASS\"}")
  echo "$resp" | grep -q '"role"' || { log FATAL "login failed: $(echo "$resp" | head -c 200)"; return 1; }
  log api "login ok ($RD_ADMIN_USER)"
}
api() { # $1=method $2=path [$3=body] -> stdout body; sets API_CODE
  local method="$1" path="$2" body="${3:-}" cookie="$RD_STATE/cookie.txt"
  api_login || return 1
  local args=( -s -w '\n%{http_code}' -b "$cookie" --max-time 60 "$RD_API$path" )
  [ -n "$body" ] && args+=( -H 'Content-Type: application/json' -d "$body" )
  case "$method" in
    GET) API_OUT=$(curl "${args[@]}") ;;
    POST) API_OUT=$(curl -X POST "${args[@]}") ;;
    PUT) API_OUT=$(curl -X PUT "${args[@]}") ;;
    DELETE) API_OUT=$(curl -X DELETE "${args[@]}") ;;
    *) return 2 ;;
  esac
  API_CODE=$(echo "$API_OUT" | tail -1)
  echo "$API_OUT" | sed '$d'
}
DBQ() { printf '%s' "$1" | docker exec -i "$RD_PGC" psql -U postgres -d "$RD_DB" -At -v ON_ERROR_STOP=1 2>&1; }

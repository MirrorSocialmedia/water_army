#!/usr/bin/env bash
# =============================================================================
# rdev P1 — scratch stack bringup (zero-state rebuild after P5-era teardown)
#
# Idempotent: safe to re-run while parts are up. Redlines before any NEW load.
# NEVER touches user stack water-army-* / SGLang 30000 (read-only health).
#
# Run: bash scripts/realdevice-master/bringup.sh
# =============================================================================
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

mkdir -p "$RD_STATE" "$RD_EVID" "$RD_DATA_ROOT" /var/lib/water-army/apk-rdev
chmod 700 "$RD_STATE"

# ---- 1. redlines (before ANY new load) -------------------------------------
preboot_redlines || exit 1

# ---- 2. network --------------------------------------------------------------
if ! docker network inspect "$RD_NET" >/dev/null 2>&1; then
  D network create --subnet "$RD_NET_SUBNET" "$RD_NET" | tee -a "$RD_EVID/harness.log"
else
  log net "network $RD_NET exists (reuse)"
fi

# ---- 3. pg + redis (scratch, throwaway) --------------------------------------
start_infra() { # $1=container $2=image $3=hostport $4=containerport $5+=container command
  local name="$1" img="$2" hport="$3" cport="$4"; shift 4
  if [ "$(D ps -q -f name="^${name}$")" ]; then log infra "$name running (reuse)"; return 0; fi
  D rm -f "$name" >/dev/null 2>&1 || true
  D run -d --name "$name" -p "127.0.0.1:${hport}:${cport}" "$img" "$@" >/dev/null || { log FATAL "$name failed to start"; return 1; }
  log infra "$name up (127.0.0.1:$hport -> container $cport)"
}
if [ -z "$(D ps -q -f name="^${RD_PGC}$")" ]; then
  D rm -f "$RD_PGC" >/dev/null 2>&1 || true
  D run -d --name "$RD_PGC" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:16494:5432" postgres:16-alpine >/dev/null || { log FATAL "pg failed to start"; exit 1; }
  log infra "rdev-pg up (127.0.0.1:16494 -> container 5432)"
fi
start_infra "$RD_RDC" "redis:7-alpine" 16495 6379 redis-server --appendonly no || exit 1

for i in $(seq 1 30); do
  printf 'SELECT 1\n' | docker exec -i "$RD_PGC" psql -U postgres -d postgres -At 2>/dev/null | grep -q 1 && RDQ=1 || RDQ=0
  [ "$RDQ" = "1" ] && break; sleep 1
done
[ "$RDQ" = "1" ] || { log FATAL "pg not ready"; exit 1; }

# ---- 4. schema (fresh db per ticket — prisma migrate deploy) -----------------
PGMAIN() { printf '%s' "$1" | docker exec -i "$RD_PGC" psql -U postgres -d postgres -At 2>/dev/null; }
PGMAIN "SELECT 1 FROM pg_database WHERE datname='$RD_DB'" | grep -q 1 || PGMAIN "CREATE DATABASE $RD_DB" >/dev/null
( cd "$RD_REPO" && DATABASE_URL="$RD_PG_URL" npx prisma migrate deploy 2>&1 | tail -3 | tee -a "$RD_EVID/harness.log" )
# client regen (2026-10-26 incident: stale generated client missing W3
# egressState fields — hermetic fakes masked it; live device.create 500'd).
( cd "$RD_REPO" && npx prisma generate 2>&1 | tail -1 | tee -a "$RD_EVID/harness.log" )
DBQ "SELECT count(*) FROM _prisma_migrations" | tee -a "$RD_EVID/harness.log"

# ---- 5. scrcpy jar (pinned sha256, ADR-019) ----------------------------------
if [ ! -s "$RD_JAR_PATH" ]; then
  log jar "fetching scrcpy-server-v5.0.1 (release asset)"
  curl -sfL --max-time 120 -o "$RD_JAR_PATH" \
    "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1" || log FATAL "jar download failed"
fi
actual_sha=$(sha256sum "$RD_JAR_PATH" | cut -d' ' -f1)
actual_bytes=$(stat -c%s "$RD_JAR_PATH")
[ "$actual_sha" = "$RD_JAR_SHA256" ] && [ "$actual_bytes" = "$RD_JAR_BYTES" ] \
  || { log FATAL "scrcpy jar sha256/size mismatch: $actual_sha / $actual_bytes"; exit 1; }
log jar "scrcpy-server-v5.0.1 verified (sha256+size)"

# ---- 6. scratch secrets (one-time fixtures, chmod 600, NEVER in repo) --------
if [ ! -f "$RD_SECRETS" ]; then
  {
    echo "RD_ADMIN_USER=rdev-admin"
    echo "RD_ADMIN_PASS=rdev-e2e-admin-pw"
    echo "export RD_ADMIN_USER RD_ADMIN_PASS"
    echo "export MC_SESSION_SECRET=$(openssl rand -hex 32)"
    echo "export MC_APP_ENCRYPTION_KEY=$(openssl rand -hex 32)"
    echo "export MC_WORKER_API_TOKEN=$(openssl rand -hex 24)"
    echo "export MC_STREAM_TICKET_SECRET=$(openssl rand -hex 32)"
    echo "export MC_STREAM_SIDECAR_TOKEN=$(openssl rand -hex 24)"
  } > "$RD_SECRETS"
  chmod 600 "$RD_SECRETS"
  log secrets "env.sh generated (scratch fixtures)"
fi

# ---- 7. echo server (W3 IP-echo; harmless until W3 switch ON) ----------------
stop_by_pidfile "$RD_STATE/echo.pid"
( exec node "$SCRIPT_DIR/echo-server.mjs" ) > "$RD_EVID/echo-server.log" 2>&1 &
echo $! > "$RD_STATE/echo.pid"
for i in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:16491/healthz)" = "200" ] && break; sleep 0.3
done

# ---- 8. API (repo HEAD code) --------------------------------------------------
stop_by_pidfile "$RD_STATE/api.pid"
( # shellcheck disable=SC1091
  . "$RD_SECRETS"
  cd "$RD_REPO"
  export NODE_ENV=production
  export APP_HOST=127.0.0.1 APP_PORT=16490
  export APP_PUBLIC_URL="http://127.0.0.1:16492"
  export SESSION_SECRET="$MC_SESSION_SECRET"
  export APP_ENCRYPTION_KEY="$MC_APP_ENCRYPTION_KEY"
  export WORKER_API_TOKEN="$MC_WORKER_API_TOKEN"
  export DATABASE_URL="$RD_PG_URL"
  export REDIS_URL="redis://127.0.0.1:16495"
  export REDROID_DATA_ROOT="$RD_DATA_ROOT"
  export REDROID_ADB_RANGE_START=16500 REDROID_ADB_RANGE_END=16549
  export REDROID_ADB_BINARY="$RD_ADB"
  export DEVICE_NETWORK_NAME="$RD_NET" DEVICE_NETWORK_SUBNET="$RD_NET_SUBNET"
  export STREAM_TICKET_SECRET="$MC_STREAM_TICKET_SECRET"
  export STREAM_SIDECAR_TOKEN="$MC_STREAM_SIDECAR_TOKEN"
  export SIDECAR_PORT=16493
  export SIDECAR_FWD_RANGE_START=16460 SIDECAR_FWD_RANGE_END=16469
  export SCRCPY_JAR="$RD_JAR_PATH" SCRCPY_JAR_SHA256="$RD_JAR_SHA256"
  export STREAM_LEASE_TTL_MS=30000
  export STREAM_RECONCILE_INTERVAL_MS=10000
  # phase switches (see progress file): W1 ON from the start (dedicated scratch
  # host), W2 ON for the E-phase (A9 restarts OFF), W3 OFF until P5.
  export WA_REDROID_RO_OVERRIDES_ENABLED=true
  export WA_APP_OPS_ENABLED=true
  export WA_APK_DIR=/var/lib/water-army/apk-rdev
  export WA_W3_EGRESS_BINDING_ENABLED=false
  export WA_W3_EGRESS_ECHO_HOST=127.0.0.1 WA_W3_EGRESS_ECHO_PORT=16491
  exec node apps/api/src/server.js
) > "$RD_EVID/scratch-api.log" 2>&1 &
echo $! > "$RD_STATE/api.pid"
API_UP=0
for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$RD_API/api/health/ready" || true)
  [ "$code" = "200" ] && { API_UP=1; break; }
  kill -0 "$(cat "$RD_STATE/api.pid")" 2>/dev/null || break
  sleep 0.5
done
[ "$API_UP" = "1" ] || { log FATAL "api not ready (last log lines:)"; tail -20 "$RD_EVID/scratch-api.log" | tee -a "$RD_EVID/harness.log"; exit 1; }
log api "ready 200 (pid $(cat "$RD_STATE/api.pid"))"

# ---- 9. web (built dist + proxy) ---------------------------------------------
stop_by_pidfile "$RD_STATE/web.pid"
(
  cd "$RD_REPO"
  export WEB_HOST=127.0.0.1 WEB_PORT=16492
  export API_UPSTREAM="http://127.0.0.1:16490"
  exec node apps/web/server.js
) > "$RD_EVID/scratch-web.log" 2>&1 &
echo $! > "$RD_STATE/web.pid"
for i in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$RD_WEB/")" = "200" ] && break; sleep 0.3
done
log web "up (pid $(cat "$RD_STATE/web.pid"))"

# ---- 10. sidecar (API supervisor spawns it) + preflight ------------------------
SIDECAR_UP=0
for i in $(seq 1 30); do
  ss -ltn 2>/dev/null | grep -q ':16493 ' && { SIDECAR_UP=1; break; }; sleep 0.5
done
[ "$SIDECAR_UP" = "1" ] && log sidecar "16493 listening" || log WARN "sidecar not listening yet (supervisor may still be starting)"

# ---- 11. users + base template -------------------------------------------------
( cd "$RD_REPO" && node "$SCRIPT_DIR/seed-users.mjs" ) | tee -a "$RD_EVID/harness.log"
api GET /api/redroid/templates > "$RD_EVID/templates-after-bringup.json"
if ! grep -q '"rdev-base"' "$RD_EVID/templates-after-bringup.json"; then
  api POST /api/redroid/templates '{"name":"rdev-base","image":"'"$RD_IMAGE"'","androidVersion":"14","width":720,"height":1280,"dpi":320,"fps":30,"gpuMode":"host","privileged":true,"privilegedReason":"rdev scratch: redroid kernel/boot requires privileged (MC ticket precedent)","memoryLimitBytes":4294967296}' \
    > "$RD_EVID/template-create-base.json"
  log template "rdev-base created (720x1280/320dpi, gpu host, 4GiB limit)"
else
  log template "rdev-base exists (reuse)"
fi

# ---- 12. final report -----------------------------------------------------------
{
  echo "=== rdev bringup $(ts) ==="
  echo "MemAvailable MiB: $(mem_avail_mb)"
  echo "user stack: $(docker ps --format '{{.Names}}' | grep -c '^water-army-')/5"
  echo "sglang 30000: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:30000/health)"
  echo "api ready: $(curl -s -o /dev/null -w '%{http_code}' "$RD_API/api/health/ready")"
  echo "web: $(curl -s -o /dev/null -w '%{http_code}' "$RD_WEB/")"
  echo "echo: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:16491/healthz)"
  echo "pg migrations: $(DBQ 'SELECT count(*) FROM migrations')"
  echo "containers:"; docker ps --format '{{.Names}}' | grep -E '^rdev-|^redroid-' | sort
  echo "adb: $($RD_ADB devices 2>/dev/null | tail -n +2 | wc -l) devices"
} | tee "$RD_EVID/bringup-report.txt"
log bringup "DONE"

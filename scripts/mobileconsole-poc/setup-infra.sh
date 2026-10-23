#!/usr/bin/env bash
# =============================================================================
# Mobile Console — scratch stack setup (G2 recipe, MC prefix/ports)
#
# Subcommands:
#   setup   — idempotent: pg + redis + network + migrate + admin + api + template
#   verify  — read-only checks (api health, login, template, gate status)
#
# Device creation is NOT here — run-poc.sh owns the boot window (one long
# command, CTO-idle discipline).
# =============================================================================
set -uo pipefail
SUBCMD="${1:-setup}"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mkdir -p "$MC_EVID" "$MC_STATE"
chmod 700 "$MC_STATE"

cmd_secrets() {
  if [ -f "$MC_SECRETS" ]; then log secrets "exist ($MC_SECRETS)"; return 0; fi
  {
    echo "MC_ADMIN_USER=${MC_ADMIN_USER:-mcadmin}"
    echo "MC_ADMIN_PASS=$(openssl rand -hex 20)"
    echo "MC_SESSION_SECRET=$(openssl rand -hex 32)"
    echo "MC_APP_ENCRYPTION_KEY=$(openssl rand -hex 32)"
    echo "MC_WORKER_API_TOKEN=$(openssl rand -hex 32)"
  } > "$MC_SECRETS"
  chmod 600 "$MC_SECRETS"
  log secrets "written to $MC_SECRETS (chmod 600; never in repo)"
}

cmd_setup() {
  cmd_secrets
  # ---- scratch containers (idempotent) ----
  if [ -z "$(DC 'ps -q --filter name=^${MC_PGC}$')" ]; then
    DC "rm -f $MC_PGC" >/dev/null 2>&1 || true
    DC "run -d --name $MC_PGC -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:16494:5432 postgres:17.6" > "$MC_EVID/scratch-pg-create.log" 2>&1 \
      || { log FATAL "scratch pg start failed"; return 1; }
    log infra "scratch pg $MC_PGC @16494"
  else log infra "scratch pg $MC_PGC already up"; fi
  if [ -z "$(DC 'ps -q --filter name=^${MC_RDC}$')" ]; then
    DC "rm -f $MC_RDC" >/dev/null 2>&1 || true
    DC "run -d --name $MC_RDC -p 127.0.0.1:16495:6379 redis:7.4.5" > "$MC_EVID/scratch-redis-create.log" 2>&1 \
      || { log FATAL "scratch redis start failed"; return 1; }
    log infra "scratch redis $MC_RDC @16495"
  else log infra "scratch redis $MC_RDC already up"; fi

  local i
  for i in $(seq 1 30); do
    DC "exec $MC_PGC pg_isready -U postgres" >/dev/null 2>&1 && break
    sleep 1
  done
  DC "exec $MC_PGC psql -U postgres -tAc 'SELECT 1 FROM pg_database WHERE datname=$$water_army_mc$$'" | grep -q 1 \
    || DC "exec $MC_PGC psql -U postgres -c 'CREATE DATABASE water_army_mc'" >/dev/null 2>&1
  log infra "scratch db water_army_mc ready"

  # ---- device bridge (MD-specified subnet; idempotent) ----
  if ! DC "network inspect $MC_NET" >/dev/null 2>&1; then
    DC "network create --subnet $MC_NET_SUBNET $MC_NET" >/dev/null \
      || { log FATAL "cannot create $MC_NET"; return 1; }
    log infra "network $MC_NET ready ($MC_NET_SUBNET)"
  else log infra "network $MC_NET already exists"; fi
  if ! DC "network inspect $MC_PROBE_NET" >/dev/null 2>&1; then
    DC "network create --subnet $MC_PROBE_SUBNET $MC_PROBE_NET" >/dev/null || true
    log infra "network $MC_PROBE_NET ready ($MC_PROBE_SUBNET)"
  else log infra "network $MC_PROBE_NET already exists"; fi

  # ---- migrations (fresh scratch db) ----
  ( cd "$MC_REPO" && DATABASE_URL="$MC_PG_URL" npx prisma migrate deploy > "$MC_EVID/migrate-deploy.log" 2>&1 ) \
    || { log FATAL "migrate deploy failed"; tail -5 "$MC_EVID/migrate-deploy.log"; return 1; }
  log infra "migrations deployed"

  # ---- first admin (refuses if any user exists — fresh db) ----
  # shellcheck disable=SC1090
  . "$MC_SECRETS"
  local users_n
  users_n=$(DC "exec $MC_PGC psql -U postgres -d water_army_mc -tAc 'SELECT count(*) FROM users'" 2>/dev/null || echo '?')
  if [ "$users_n" = "?" ]; then sleep 3; users_n=$(DC "exec $MC_PGC psql -U postgres -d water_army_mc -tAc 'SELECT count(*) FROM users'" 2>/dev/null || echo '?'); fi
  if [ "$users_n" = "0" ]; then
    ( cd "$MC_REPO" && DATABASE_URL="$MC_PG_URL" REDIS_URL="$MC_RD_URL" \
        node apps/api/src/cli/setup-admin.js ) < <(printf '%s\n%s\n%s\n' "$MC_ADMIN_USER" "$MC_ADMIN_PASS" "$MC_ADMIN_PASS") \
      > "$MC_EVID/setup-admin.log" 2>&1 || { log FATAL "setup-admin failed"; tail -5 "$MC_EVID/setup-admin.log"; return 1; }
    log infra "admin user created"
  else log infra "admin user already exists"; fi

  # ---- API (pidfile; NEVER pattern-kill — G1 incident lesson) ----
  local pidfile="$MC_STATE/api.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log infra "scratch api already running (pid $(cat "$pidfile"))"
  else
    rm -f "$MC_STATE/cookie.txt"
    (
      cd "$MC_REPO"
      export NODE_ENV=production
      export APP_HOST=127.0.0.1 APP_PORT=16490
      export SESSION_SECRET="$MC_SESSION_SECRET"
      export APP_ENCRYPTION_KEY="$MC_APP_ENCRYPTION_KEY"
      export WORKER_API_TOKEN="$MC_WORKER_API_TOKEN"
      export DATABASE_URL="$MC_PG_URL"
      export REDIS_URL="$MC_RD_URL"
      export REDROID_DATA_ROOT="$MC_DATA_ROOT"
      export REDROID_ADB_RANGE_START=$MC_ADB_RANGE_START REDROID_ADB_RANGE_END=$MC_ADB_RANGE_END
      export REDROID_ADB_BINARY="$MC_ADB"
      export DEVICE_NETWORK_NAME="$MC_NET" DEVICE_NETWORK_SUBNET="$MC_NET_SUBNET"
      exec node apps/api/src/server.js
    ) > "$MC_EVID/scratch-api.log" 2>&1 &
    echo $! > "$pidfile"
    local ok=0
    for i in $(seq 1 20); do
      sleep 1
      curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$MC_API/api/health/live" 2>/dev/null | grep -q 200 && { ok=1; break; }
    done
    [ "$ok" = "1" ] || { log FATAL "scratch api not listening on 16490"; tail -10 "$MC_EVID/scratch-api.log"; return 1; }
    log infra "scratch api up (pid $(cat "$pidfile"), @16490)"
  fi

  mkdir -p "$MC_DATA_ROOT" && chmod 750 "$MC_DATA_ROOT" 2>/dev/null || true
  log infra "dataDir root ready: $MC_DATA_ROOT"
  cmd_verify_template
  log setup "SETUP DONE"
}

cmd_verify_template() {
  api_login || return 1
  local existing code
  api GET '/api/redroid/templates'; code=$API_CODE; existing="$API_OUT"
  if [ "$code" != "200" ]; then log WARN "template list failed ($code): ${existing:0:200}"; return 1; fi
  if echo "$existing" | grep -q "\"name\":\"$MC_TEMPLATE_NAME\""; then
    log template "$MC_TEMPLATE_NAME already exists"; return 0
  fi
  api POST '/api/redroid/templates' "$(cat <<EOF
{
  "name": "$MC_TEMPLATE_NAME",
  "image": "$MC_IMAGE",
  "androidVersion": "14",
  "width": 720, "height": 1280, "dpi": 320, "fps": 30,
  "gpuMode": "host",
  "privileged": true,
  "privilegedReason": "MC PoC: replicate A10-4/G2 proven spec (redroid requires privileged on this host, 10/10 CONFIRMED-safe)",
  "cpuLimit": 2,
  "memoryLimitBytes": 4294967296
}
EOF
)" > "$MC_EVID/template-create.json"
  [ "$API_CODE" = "201" ] || [ "$API_CODE" = "200" ] || { log FATAL "template create failed: $API_OUT"; return 1; }
  log template "$MC_TEMPLATE_NAME created (r3 image, 720x1280/320/30, host GPU, privileged, 2vCPU/4GiB)"
}

cmd_verify() {
  log verify "== read-only checks =="
  log verify "api health: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$MC_API/api/health/live") / ready: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$MC_API/api/health/ready")"
  api_login || { log FAIL "login"; return 1; }
  api GET '/api/gate/status' > "$MC_EVID/gate-status-verify.json" 2>/dev/null || true
  grep -o '"enabled":[a-z]*' "$MC_EVID/gate-status-verify.json" 2>/dev/null || log warn "gate status unreadable"
   log verify "image present: $(DC "images -q $MC_IMAGE" | head -1 | cut -c1-12)"
  log verify "jar sha256 check: $(sha256sum "$MC_JAR_PATH" 2>/dev/null | cut -c1-16)... (want ${MC_JAR_SHA256:0:16})"
  log verify "verify done"
}

case "$SUBCMD" in
  setup) cmd_setup ;;
  verify) cmd_verify ;;
  secrets) cmd_secrets ;;
  *) echo "usage: $0 setup|verify|secrets" >&2; exit 2 ;;
esac

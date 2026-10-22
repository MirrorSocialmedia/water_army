#!/usr/bin/env bash
# RAM-G2 Phase D — scratch stack setup (replicates the G1 real-device recipe,
# ports/subnet per G2 MD: pg@16494, redis@16495, api@16490, worker-health@16496,
# bridge br-b6g-ladder 172.38.221.0/24, dataDir root .../redroid-ramgate-g2).
#
# Subcommands:
#   setup     — idempotent: containers + network + db + admin + api + template
#   verify    — gate ON + status + preflight + image pin (read-only checks)
#   secrets   — (re)generate /tmp/ramgate-g2/env.sh (chmod 600) if missing
set -uo pipefail
SUBCMD="${1:-setup}"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mkdir -p "$R2_EVID" "$R2_SCRATCH_STATE"
chmod 700 "$R2_SCRATCH_STATE"

PGC="g2-scratch-pg"
RDC="g2-scratch-redis"
PG_URL="postgresql://postgres:postgres@127.0.0.1:16494/water_army_g2"
RD_URL="redis://127.0.0.1:16495"

cmd_secrets() {
  if [ -f "$R2_SECRETS" ]; then log "secrets exist ($R2_SECRETS)"; return 0; fi
  {
    echo "G2_ADMIN_USER=${G2_ADMIN_USER:-g2admin}"
    echo "G2_ADMIN_PASS=$(openssl rand -hex 20)"
    echo "G2_SESSION_SECRET=$(openssl rand -hex 32)"
    echo "G2_APP_ENCRYPTION_KEY=$(openssl rand -hex 32)"
    echo "G2_WORKER_API_TOKEN=$(openssl rand -hex 32)"
  } > "$R2_SECRETS"
  chmod 600 "$R2_SECRETS"
  log "secrets written to $R2_SECRETS (chmod 600; never in repo)"
}

cmd_setup() {
  cmd_secrets
  # ---- scratch containers (idempotent) ----
  if [ -z "$(DC ps -q --filter "name=^${PGC}$")" ]; then
    DC rm -f "$PGC" >/dev/null 2>&1 || true
    DC run -d --name "$PGC" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
      -p 127.0.0.1:16494:5432 postgres:17.6 > "$R2_EVID/scratch-pg-create.log" 2>&1 \
      || { log "FATAL: scratch pg start failed"; return 1; }
    log "scratch pg $PGC @16494"
  else log "scratch pg $PGC already up"; fi
  if [ -z "$(DC ps -q --filter "name=^${RDC}$")" ]; then
    DC rm -f "$RDC" >/dev/null 2>&1 || true
    DC run -d --name "$RDC" -p 127.0.0.1:16495:6379 redis:7.4.5 > "$R2_EVID/scratch-redis-create.log" 2>&1 \
      || { log "FATAL: scratch redis start failed"; return 1; }
    log "scratch redis $RDC @16495"
  else log "scratch redis $RDC already up"; fi

  # wait for pg accept + db existence
  local i
  for i in $(seq 1 30); do
    if docker exec "$PGC" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec "$PGC" psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='water_army_g2'" | grep -q 1 \
    || docker exec "$PGC" psql -U postgres -c "CREATE DATABASE water_army_g2" >/dev/null 2>&1
  log "scratch db water_army_g2 ready"

  # ---- device bridge (MD-specified subnet; idempotent) ----
  if ! DC network inspect "$R2_NET" >/dev/null 2>&1; then
    DC network create --subnet "$R2_NET_SUBNET" "$R2_NET" >/dev/null \
      || { log "FATAL: cannot create $R2_NET"; return 1; }
    log "network $R2_NET ready ($R2_NET_SUBNET)"
  else log "network $R2_NET already exists"; fi

  # ---- migrations (fresh scratch db) ----
  ( cd "$R2_REPO" && DATABASE_URL="$PG_URL" npx prisma migrate deploy > "$R2_EVID/migrate-deploy.log" 2>&1 ) \
    || { log "FATAL: migrate deploy failed"; tail -5 "$R2_EVID/migrate-deploy.log"; return 1; }
  log "migrations deployed"

  # ---- first admin (refuses if any user exists — fresh db) ----
  # shellcheck disable=SC1090
  . "$R2_SECRETS"
  local users_n
  users_n=$(docker exec "$PGC" psql -U postgres -d water_army_g2 -tAc 'SELECT count(*) FROM users' 2>/dev/null || echo '?')
  if [ "$users_n" = "?" ]; then
    sleep 3
    users_n=$(docker exec "$PGC" psql -U postgres -d water_army_g2 -tAc 'SELECT count(*) FROM users' 2>/dev/null || echo '?')
  fi
  if [ "$users_n" = "0" ]; then
    ( cd "$R2_REPO" && DATABASE_URL="$PG_URL" REDIS_URL="$RD_URL" \
        node apps/api/src/cli/setup-admin.js ) < <(printf '%s\n%s\n%s\n' "$G2_ADMIN_USER" "$G2_ADMIN_PASS" "$G2_ADMIN_PASS") \
      > "$R2_EVID/setup-admin.log" 2>&1 || { log "FATAL: setup-admin failed"; tail -5 "$R2_EVID/setup-admin.log"; return 1; }
    log "admin user created"
  else
    log "admin user already exists"
  fi

  # ---- API (pidfile; NEVER pattern-kill — G1 incident lesson) ----
  local pidfile="$R2_SCRATCH_STATE/api.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "scratch api already running (pid $(cat "$pidfile"))"
  else
    rm -f "$R2_SCRATCH_STATE/cookie.txt"
    (
      cd "$R2_REPO"
      export NODE_ENV=production
      export APP_HOST=127.0.0.1 APP_PORT=16490
      export SESSION_SECRET="$G2_SESSION_SECRET"
      export APP_ENCRYPTION_KEY="$G2_APP_ENCRYPTION_KEY"
      export WORKER_API_TOKEN="$G2_WORKER_API_TOKEN"
      export DATABASE_URL="$PG_URL"
      export REDIS_URL="$RD_URL"
      export REDROID_DATA_ROOT="$R2_DATA_ROOT"
      export REDROID_ADB_RANGE_START=16400 REDROID_ADB_RANGE_END=16409
      export REDROID_ADB_BINARY="$R2_ADB"
      export DEVICE_NETWORK_NAME="$R2_NET" DEVICE_NETWORK_SUBNET="$R2_NET_SUBNET"
      # gate: pure defaults (task: run ladder under DEFAULT config first)
      exec node apps/api/src/server.js
    ) > "$R2_EVID/scratch-api.log" 2>&1 &
    echo $! > "$pidfile"
    # give it a moment, then verify it is listening
    local ok=0
    for i in $(seq 1 20); do
      sleep 1
      curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$R2_API/api/health" 2>/dev/null | grep -q 200 && { ok=1; break; }
    done
    [ "$ok" = "1" ] || { log "FATAL: scratch api not listening on 16490"; tail -10 "$R2_EVID/scratch-api.log"; return 1; }
    log "scratch api up (pid $(cat "$pidfile"), @16490)"
  fi

  # ---- dataDir root ----
  mkdir -p "$R2_DATA_ROOT" && chmod 750 "$R2_DATA_ROOT" 2>/dev/null || true
  log "dataDir root ready: $R2_DATA_ROOT"

  # ---- redroid template (replicates A10 stage3 product spec) ----
  cmd_verify_template
  log "SETUP DONE"
}

cmd_verify_template() {
  api_login || return 1
  local existing
  existing=$(api GET '/api/redroid/templates'); local code=$API_CODE
  if [ "$code" != "200" ]; then log "WARN: template list failed ($code)"; return 1; fi
  if echo "$existing" | grep -q "\"name\":\"$R2_TEMPLATE_NAME\""; then
    log "template $R2_TEMPLATE_NAME already exists"
    return 0
  fi
  # privileged requires a reason >= 10 chars (template schema)
  api POST '/api/redroid/templates' "$(cat <<EOF
{
  "name": "$R2_TEMPLATE_NAME",
  "image": "$R2_IMAGE",
  "androidVersion": "14",
  "width": 720, "height": 1280, "dpi": 320, "fps": 30,
  "gpuMode": "host",
  "privileged": true,
  "privilegedReason": "G2 real-device ladder: replicate A10-4 proven spec (redroid requires privileged on this host, 10/10 CONFIRMED-safe)",
  "cpuLimit": 2,
  "memoryLimitBytes": 4294967296
}
EOF
)" || { log "FATAL: template create failed: $API_BODY"; return 1; }
  echo "$API_BODY" > "$R2_EVID/template-create.json"
  log "template $R2_TEMPLATE_NAME created (r3 image, 720x1280/320/30, host GPU, privileged, 2vCPU/4GiB)"
}

cmd_verify() {
  log "== verify (read-only) =="
  log "api health: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$R2_API/api/health")"
  api_login || { log "FAIL: login"; return 1; }
  gate_status > "$R2_EVID/gate-status-verify.json"
  grep -q '"enabled":true' "$R2_EVID/gate-status-verify.json" && log "gate ENABLED (config live from AppSetting/defaults)" || { log "FAIL: gate not enabled"; return 1; }
  grep -o '"liveLeases":[0-9]*' "$R2_EVID/gate-status-verify.json" || true
  log "preflight: $(curl -s -b "$R2_SCRATCH_STATE/cookie.txt" "$R2_API/api/redroid/preflight?gpu=true" | head -c 300)"
  log "image present: $(DC images -q "$R2_IMAGE" | head -1 | cut -c1-12)"
  log "verify done"
}

case "$SUBCMD" in
  setup) cmd_setup ;;
  verify) cmd_verify ;;
  secrets) cmd_secrets ;;
  *) echo "usage: $0 setup|verify|secrets" >&2; exit 2 ;;
esac

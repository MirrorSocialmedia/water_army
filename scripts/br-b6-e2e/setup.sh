#!/usr/bin/env bash
# BR-B6 E2E setup (idempotent) — scratch pg+redis on 163xx with the br-b6-*
# container prefix + test images + schema + seed. Creates NOTHING on shared
# infra (B6 isolation rules: scratch only on 163xx/165xx, br-b6-* names).
# teardown.sh removes 100% of it.
set -euo pipefail
cd "$(dirname "$0")/../.."

RUN=.dev/br-b6-e2e
PG_PORT=16341
REDIS_PORT=16342
DB_NAME=cw_b6_e2e
DB_USER=cw_b6
DB_PASS=br_b6_e2e_pw
# host-port pool for batch container ADB endpoints (163xx prefix, above the
# api/pg/redis ports, inside the B6 scratch range; default is 16370-16419).
BATCH_PORT_RANGE=16360-16400

dc() { sg docker -c "docker $*"; }
mkdir -p "$RUN"
log() { echo "[br-b6-e2e-setup] $*"; }

# --- port pre-flight (B6 gen2: orphan-API collision guard) -------------------
# A previous run that died abnormally can leave an orphan API holding 16343
# (teardown only killed workers, never the run.sh-owned API). A fresh run
# would then bind-fail its own API, yet its ready-check curl would succeed
# against the ORPHAN (shared DB, old WORKER_API_TOKEN) → every worker
# service-token call 401s. Refuse to start if any scratch port is bound or
# a foreign APP_PORT=16343 process is alive.
port_in_use() { ss -ltn 2>/dev/null | grep -q "127.0.0.1:$1"; }
for p in "$PG_PORT" "$REDIS_PORT" 16343 16344; do
  if port_in_use "$p"; then
    log "FATAL: scratch port $p already bound — orphan from a previous run? (kill it, then retry)"
    exit 1
  fi
done
for proc in $(pgrep -f 'apps/api/src/server.js' 2>/dev/null || true); do
  if tr '\0' '\n' < "/proc/$proc/environ" 2>/dev/null | grep -q '^APP_PORT=16343$'; then
    log "FATAL: live API process $proc with APP_PORT=16343 (orphan) — kill it, then retry"
    exit 1
  fi
done
log "port pre-flight clear ($PG_PORT/$REDIS_PORT/16343/16344)"

# --- containers (ours only, by name) ----------------------------------------
dc rm -f br-b6-pg br-b6-redis >/dev/null 2>&1 || true
log "starting br-b6-pg ($PG_PORT) + br-b6-redis ($REDIS_PORT)"
dc run -d --name br-b6-pg \
  -e POSTGRES_DB="$DB_NAME" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" \
  -p "127.0.0.1:$PG_PORT:5432" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea >/dev/null
dc run -d --name br-b6-redis \
  -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 >/dev/null

log "waiting for pg"
for i in $(seq 1 60); do
  if dc exec br-b6-pg pg_isready -U "$DB_USER" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && { log "pg never became ready"; exit 1; }
done
log "waiting for redis"
for i in $(seq 1 30); do
  if dc exec br-b6-redis redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
  sleep 1
  [ "$i" = 30 ] && { log "redis never became ready"; exit 1; }
done

# --- test images (pinned dated tags; base pinned BY DIGEST) -------------------
log "building test images (water-army/brb6-adb-mock + brb6-broken :20261022)"
dc build -q -t water-army/brb6-adb-mock:20261022 -f scripts/br-b6-e2e/docker/Dockerfile scripts/br-b6-e2e/docker/ >/dev/null
dc build -q -t water-army/brb6-broken:20261022 -f scripts/br-b6-e2e/docker/Dockerfile.broken scripts/br-b6-e2e/docker/ >/dev/null

# --- schema (fresh scratch DB every run — setup drops+recreates ours only) ----
export DATABASE_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public"
log "prisma migrate deploy (scratch DB)"
npx prisma migrate deploy --schema prisma/schema.prisma 2>&1 | tail -2

# --- seed (admin + 200 + 10 identities; deterministic + idempotent) -----------
log "seeding admin + 216 identities (200 main / 10 overlap / 6 restart-wave)"
BRB6_DATA_ROOT="$RUN/data" node scripts/br-b6-e2e/seed.js

# --- env files (fresh secrets each run; .dev is gitignored) -------------------
SESSION_SECRET=$(openssl rand -hex 32)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
WORKER_API_TOKEN=$(openssl rand -hex 32)

cat > "$RUN/api.env" <<EOF
NODE_ENV=production
APP_HOST=127.0.0.1
APP_PORT=16343
APP_PUBLIC_URL=http://127.0.0.1:16343
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public
REDIS_URL=redis://127.0.0.1:$REDIS_PORT/0
SESSION_SECRET=$SESSION_SECRET
APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY
WORKER_API_TOKEN=$WORKER_API_TOKEN
# API owns the Docker socket for batch containers (MD §4 / threat T1) — real
# daemon on purpose (the E2E IS the live container path).
BATCH_CONTAINER_ALLOWED_IMAGES=water-army/brb6-adb-mock:20261022,water-army/brb6-broken:20261022
BATCH_ADB_HOST_PORT_RANGE=$BATCH_PORT_RANGE
BATCH_CONTAINER_DATA_ROOT=$RUN/data
LOG_LEVEL=info
EOF

cat > "$RUN/worker-base.env" <<EOF
NODE_ENV=production
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public
REDIS_URL=redis://127.0.0.1:$REDIS_PORT/0
WORKER_API_TOKEN=$WORKER_API_TOKEN
API_INTERNAL_URL=http://127.0.0.1:16343
# B4 gate (fail-closed): the worker's egress target is the internal API
# (loopback) — allowlist it. Zero public entries (deny-all for public).
QA_ENDPOINT_ALLOWLIST_INTERNAL=http://127.0.0.1:16343
LOG_LEVEL=info
# BullMQ concurrency = global cap: the sampler must be able to SEE 6 live
# slots (B2 G8 pattern). (B6 gen2 run-2: concurrency=1 serialized every run
# → the cap was never exercised and P1's binding check could never pass.)
TASK_MAX_CONCURRENCY=6
BATCH_SCHEDULER_INTERVAL_MS=2000
BATCH_HEARTBEAT_MS=2000
# TTL must outlive the longest run (10s hold + boot) or the reconciler
# isolates healthy runs mid-hold (B6 gen2 run-2: 8s TTL < 10s hold).
BATCH_SLOT_TTL_MS=30000
BATCH_CANCEL_POLL_MS=500
BATCH_SLOT_WAIT_MS=1000
BATCH_MAX_SLOT_DEFERS=60
BATCH_DEFAULT_TIMEOUT_MS=60000
# container adapter: 10s hold = the sandbox "work window" — wide enough that
# the P2 mid-hold docker kill reliably lands in-flight (2s probes × 5), and
# the P3b worker SIGKILL has ≥2 live containers to orphan.
# (B6 gen2 run-2: 2s hold let the kill race the success commit.)
CONTAINER_ADAPTER_HOLD_MS=10000
CONTAINER_ADAPTER_HEALTH_POLL_MS=2000
EOF

log "setup complete"

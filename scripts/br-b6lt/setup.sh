#!/usr/bin/env bash
# BR-B6 real-device ladder load-test setup (idempotent) — scratch pg+redis on
# 165xx + br-b6lt-* names + schema + 50 identities (MD §14.4 ladder).
# Creates NOTHING on shared infra. teardown.sh removes 100% of it.
set -euo pipefail
cd "$(dirname "$0")/../.."

RUN=.dev/br-b6lt
PG_PORT=16541
REDIS_PORT=16542
DB_NAME=cw_b6lt
DB_USER=cw_b6lt
DB_PASS=br_b6lt_pw
# ADB host-port pool (165xx, 50 ports — one per ladder-max container).
BATCH_PORT_RANGE=16550-16599
# Fleet image, digest-pinned (redline: dated tag + digest, no 'latest').
REDROID_IMG='water-army/redroid@sha256:591296d5656571f346994dc81608ca33744af4d0e9c9876241a8595e70143b55'

dc() { sg docker -c "docker $*"; }
mkdir -p "$RUN"
log() { echo "[br-b6lt-setup] $*"; }

# --- port pre-flight (same orphan-API collision guard as br-b6-e2e) ---------
port_in_use() { ss -ltn 2>/dev/null | grep -q "127.0.0.1:$1"; }
for p in "$PG_PORT" "$REDIS_PORT" 16543 16544; do
  if port_in_use "$p"; then
    log "FATAL: scratch port $p already bound — orphan from a previous run? (kill it, then retry)"
    exit 1
  fi
done
for proc in $(pgrep -f 'apps/api/src/server.js' 2>/dev/null || true); do
  if tr '\0' '\n' < "/proc/$proc/environ" 2>/dev/null | grep -q '^APP_PORT=16543$'; then
    log "FATAL: live API process $proc with APP_PORT=16543 (orphan) — kill it, then retry"
    exit 1
  fi
done
log "port pre-flight clear ($PG_PORT/$REDIS_PORT/16543)"

# --- image presence (must already exist locally — no pull in this plan) -----
if ! dc image inspect "$REDROID_IMG" >/dev/null 2>&1; then
  log "FATAL: $REDROID_IMG not present locally (and this plan does not pull)"
  exit 1
fi
log "image present: $REDROID_IMG"

# --- containers (ours only, by name) ----------------------------------------
dc rm -f br-b6lt-pg br-b6lt-redis >/dev/null 2>&1 || true
log "starting br-b6lt-pg ($PG_PORT) + br-b6lt-redis ($REDIS_PORT)"
dc run -d --name br-b6lt-pg \
  -e POSTGRES_DB="$DB_NAME" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" \
  -p "127.0.0.1:$PG_PORT:5432" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea >/dev/null
dc run -d --name br-b6lt-redis \
  -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 >/dev/null

log "waiting for pg"
for i in $(seq 1 60); do
  if dc exec br-b6lt-pg pg_isready -U "$DB_USER" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && { log "pg never became ready"; exit 1; }
done
log "waiting for redis"
for i in $(seq 1 30); do
  if dc exec br-b6lt-redis redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
  sleep 1
  [ "$i" = 30 ] && { log "redis never became ready"; exit 1; }
done

# --- schema (fresh scratch DB every run) -------------------------------------
export DATABASE_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public"
log "prisma migrate deploy (scratch DB)"
npx prisma migrate deploy --schema prisma/schema.prisma 2>&1 | tail -2

# --- seed (admin + 50 ladder identities) --------------------------------------
log "seeding admin + 50 identities"
BRB6LT_DATA_ROOT="$RUN/data" BRB6LT_PREFIX=brb6lt node scripts/br-b6lt/seed.js

# --- env files (fresh secrets each run) ---------------------------------------
SESSION_SECRET=$(openssl rand -hex 32)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
WORKER_API_TOKEN=$(openssl rand -hex 32)

# Allowlist: the fleet redroid image with product-grade limits (R5: 2GB/2vCPU)
# + 720x1280@30 (VRAM-pressure reduced vs R5's 1080x1920; capacity test, not
# render fidelity). gpu_mode=host is MANDATORY on this host (R5: swiftshader
# does not boot — surfaceflinger EGL crash loop).
ALLOWLIST_JSON=$(cat <<EOF
[{"image":"$REDROID_IMG","privileged":true,"reason":"BR-B6 S5 real-device ladder load test (MD §14.4)","memoryBytes":4294967296,"nanoCpus":2,"cmd":["androidboot.redroid_width=720","androidboot.redroid_height=1280","androidboot.redroid_dpi=320","androidboot.redroid_fps=30","androidboot.redroid_gpu_mode=host"]}]
EOF
)
# NOTE: the allowlist's nanoCpus field is in CPU units per the product
# contract (integration test: nanoCpus:2 -> HostConfig.NanoCpus 2e9 — the
# service multiplies by 1e9). Writing 2000000000 here re-scaled to 2e18
# nanocpus -> docker create 400 on every run (live-proven, ladder attempt 3,
# 273x 'range of CPUs is from 0.01 to 16.00').

cat > "$RUN/api.env" <<EOF
NODE_ENV=production
APP_HOST=127.0.0.1
APP_PORT=16543
APP_PUBLIC_URL=http://127.0.0.1:16543
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public
REDIS_URL=redis://127.0.0.1:$REDIS_PORT/0
SESSION_SECRET=$SESSION_SECRET
APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY
WORKER_API_TOKEN=$WORKER_API_TOKEN
# Single-quoted: the env file is shell-sourced; a bare JSON value would have
# its double quotes stripped by the shell at source time (boot hard-fail).
BATCH_CONTAINER_ALLOWED_IMAGES='$ALLOWLIST_JSON'
BATCH_ADB_HOST_PORT_RANGE=$BATCH_PORT_RANGE
BATCH_CONTAINER_DATA_ROOT=$RUN/data
# Real redroid boots: 30min boot-health window (R5 cold first boot ~24min),
# 10s poll (do not hammer a booting device), 5s probe timeout.
BATCH_CONTAINER_HEALTH_TIMEOUT_MS=1800000
BATCH_CONTAINER_HEALTH_POLL_MS=10000
BATCH_CONTAINER_HEALTH_PROBE_TIMEOUT_MS=5000
LOG_LEVEL=info
EOF

cat > "$RUN/worker-base.env" <<EOF
NODE_ENV=production
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public
REDIS_URL=redis://127.0.0.1:$REDIS_PORT/0
WORKER_API_TOKEN=$WORKER_API_TOKEN
API_INTERNAL_URL=http://127.0.0.1:16543
QA_ENDPOINT_ALLOWLIST_INTERNAL=http://127.0.0.1:16543
LOG_LEVEL=info
# Ladder: process up to 50 container jobs in parallel (the global cap is the
# real governor; serial workers would make the ladder meaningless).
# Health server: 16544 = ladder scratch (3001 is the user's dev port —
# binding it was a redline near-miss on the first live launch, 2026-10-22).
WORKER_HEALTH_PORT=16544
TASK_MAX_CONCURRENCY=50
BATCH_SCHEDULER_INTERVAL_MS=2000
BATCH_HEARTBEAT_MS=2000
BATCH_SLOT_TTL_MS=8000
BATCH_CANCEL_POLL_MS=1000
BATCH_SLOT_WAIT_MS=1000
BATCH_MAX_SLOT_DEFERS=600
# One run = boot (<=30min) + 10min soak => 45min hard ceiling.
BATCH_DEFAULT_TIMEOUT_MS=2700000
# container adapter: 10min hold = the soak window; 30s health re-probe.
CONTAINER_ADAPTER_HOLD_MS=600000
CONTAINER_ADAPTER_HEALTH_POLL_MS=30000
EOF

log "setup complete"

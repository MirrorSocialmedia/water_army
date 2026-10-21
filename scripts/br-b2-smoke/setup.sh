#!/usr/bin/env bash
# BR-B2 G8 — live smoke setup (idempotent). Scratch pg+redis on 163xx with the
# br-b2-* container prefix. Creates NOTHING on shared infra; teardown.sh
# removes 100%.
set -euo pipefail
cd "$(dirname "$0")/../.."

RUN=.dev/br-b2-smoke
PG_PORT=16321
REDIS_PORT=16322
DB_NAME=cw_b2_smoke
DB_USER=cw_b2
DB_PASS=br_b2_smoke_pw

# sg docker -c wants ONE command STRING; build it from the args.
dc() { sg docker -c "docker $*"; }

mkdir -p "$RUN"
log() { echo "[br-b2-smoke-setup] $*"; }

# --- containers (ours only, by name) ----------------------------------------
dc rm -f br-b2-pg br-b2-redis >/dev/null 2>&1 || true
log "starting br-b2-pg ($PG_PORT) + br-b2-redis ($REDIS_PORT)"
dc run -d --name br-b2-pg \
  -e POSTGRES_DB="$DB_NAME" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" \
  -p "$PG_PORT:5432" postgres:16-alpine >/dev/null
dc run -d --name br-b2-redis -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null

log "waiting for pg"
for i in $(seq 1 60); do
  if dc exec br-b2-pg pg_isready -U "$DB_USER" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && { log "pg never became ready"; exit 1; }
done
log "waiting for redis"
for i in $(seq 1 30); do
  if dc exec br-b2-redis redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
  sleep 1
  [ "$i" = 30 ] && { log "redis never became ready"; exit 1; }
done

# --- schema ------------------------------------------------------------------
export DATABASE_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public"
log "prisma migrate deploy (scratch DB)"
npx prisma migrate deploy --schema prisma/schema.prisma 2>&1 | tail -2

# --- seed (admin + 18 identities) --------------------------------------------
log "seeding admin + identities"
node scripts/br-b2-smoke/seed.js

# --- env files (fresh secrets each run; .dev is gitignored) -------------------
SESSION_SECRET=$(openssl rand -hex 32)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
WORKER_API_TOKEN=$(openssl rand -hex 32)

cat > "$RUN/api.env" <<EOF
NODE_ENV=production
APP_HOST=127.0.0.1
APP_PORT=16323
APP_PUBLIC_URL=http://127.0.0.1:16323
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public
REDIS_URL=redis://127.0.0.1:$REDIS_PORT/0
SESSION_SECRET=$SESSION_SECRET
APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY
WORKER_API_TOKEN=$WORKER_API_TOKEN
REDROID_ADAPTER=mock
DOCKER_SOCKET_PATH=
LOG_LEVEL=info
EOF

# Shared worker env; per-worker overrides (health port, scheduler on/off) are
# appended at start time.
cat > "$RUN/worker-base.env" <<EOF
NODE_ENV=production
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public
REDIS_URL=redis://127.0.0.1:$REDIS_PORT/0
WORKER_API_TOKEN=$WORKER_API_TOKEN
API_INTERNAL_URL=http://127.0.0.1:16323
# B4 gate (fail-closed) needs a loaded policy: the worker's own egress target
# is the internal API (loopback) — allowlist it. Public list stays unset
# (zero entries is legal; NO entries at all = policy unavailable = deny-all).
QA_ENDPOINT_ALLOWLIST_INTERNAL=http://127.0.0.1:16323
REDROID_ADAPTER=mock
DOCKER_SOCKET_PATH=
LOG_LEVEL=info
# Smoke-only: one BullMQ job per worker at a time. With maxActive=2 and two
# workers, two RUNNING runs are forced onto two DIFFERENT workers (pigeonhole)
# — that is what makes the Phase C kill -9 target deterministic (the killed
# worker provably owned the orphaned run). Production stays at 4.
TASK_MAX_CONCURRENCY=1
BATCH_SCHEDULER_INTERVAL_MS=2000
BATCH_HEARTBEAT_MS=2000
BATCH_SLOT_TTL_MS=8000
BATCH_CANCEL_POLL_MS=500
BATCH_SLOT_WAIT_MS=1000
BATCH_MAX_SLOT_DEFERS=40
BATCH_DEFAULT_TIMEOUT_MS=30000
BATCH_ADAPTER_REGISTRY=noop
NOOP_DURATION_MS=2500
NOOP_OUTCOME=ok
EOF

log "setup complete"

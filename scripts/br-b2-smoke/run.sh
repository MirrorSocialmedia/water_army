#!/usr/bin/env bash
# BR-B2 G8 — smoke orchestrator: API + driver (driver owns the worker pids).
# KEEP_INFRA=1 → leave pg/redis up after the run (for inspection); default
# tears EVERYTHING down (processes + br-b2-* containers + their volumes).
set -uo pipefail
cd "$(dirname "$0")/../.."

RUN=.dev/br-b2-smoke
mkdir -p "$RUN"
dc() { sg docker -c "docker $*"; }

teardown_all() {
  local rc=$?
  trap - EXIT INT TERM
  # pidfile-only kills — NEVER pattern-kill (other tenants may run
  # water_army processes from the same repo path; red line).
  for f in "$RUN"/pids/w* "$RUN"/pids/api; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
  sleep 1
  for f in "$RUN"/pids/w* "$RUN"/pids/api; do [ -f "$f" ] && kill -9 "$(cat "$f")" 2>/dev/null; done
  if [ "${KEEP_INFRA:-0}" != "1" ]; then
    dc rm -v -f br-b2-pg br-b2-redis >/dev/null 2>&1 || true
    echo "[br-b2-smoke] infra torn down (containers + volumes)"
  else
    echo "[br-b2-smoke] KEEP_INFRA=1 — pg/redis left running for inspection"
  fi
  exit $rc
}
trap teardown_all EXIT INT TERM

# 1) infra (idempotent)
bash scripts/br-b2-smoke/setup.sh

# 2) API (host node, scratch DB/redis)
rm -f "$RUN"/pids/* 2>/dev/null || true
echo "[br-b2-smoke] starting API :16323"
set -a; source "$RUN/api.env"; set +a
nohup setsid node apps/api/src/server.js > "$RUN/api.log" 2>&1 &
API_PID=$!
mkdir -p "$RUN/pids"; echo "$API_PID" > "$RUN/pids/api"

for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:16323/api/health/ready >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && { echo "[br-b2-smoke] API never became ready"; tail -20 "$RUN/api.log"; exit 1; }
done
echo "[br-b2-smoke] API ready (pid $API_PID)"

# 3) driver (own + kill all workers)
node scripts/br-b2-smoke/driver.mjs
RC=$?
echo "[br-b2-smoke] driver exit=$RC"
exit $RC

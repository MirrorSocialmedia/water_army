#!/usr/bin/env bash
# BR-B6 fault-injection runner — same scratch env as the E2E (163xx, br-b6-*),
# FRESH (setup drops+recreates the scratch DB), fault-driver instead of the
# main driver. Run AFTER the main E2E completes (never concurrently — the
# fault driver stops the scratch pg/redis containers mid-scenario).
#
# Run:  nohup setsid bash scripts/br-b6-e2e/fault-run.sh > .dev/br-b6-e2e/fault-run.out 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
RUN=.dev/br-b6-e2e
mkdir -p "$RUN/pids"

log() { echo "[br-b6-fault-run] $*"; }

cleanup() {
  log "teardown (always)"
  bash scripts/br-b6-e2e/teardown.sh || log "teardown reported issues"
}
trap cleanup EXIT

# the main E2E must not be running in this env (its pg/redis would be ours to
# stop — a mid-run collision). Guard: no live API on 16343 before we start.
if ss -ltn 2>/dev/null | grep -q "127.0.0.1:16343"; then
  log "FATAL: 16343 is bound — the main E2E (or an orphan) is in this env. Refusing."
  exit 1
fi

bash scripts/br-b6-e2e/setup.sh || { log "setup failed — aborting"; exit 1; }

log "starting API (16343)"
(
  set -a
  # shellcheck disable=SC1091
  source "$RUN/api.env"
  set +a
  exec node apps/api/src/server.js
) >> "$RUN/api.log" 2>> "$RUN/api.err.log" &
API_PID=$!
echo "$API_PID" > "$RUN/pids/api"

for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:16343/api/health/ready >/dev/null 2>&1; then break; fi
  sleep 1
  if ! kill -0 "$API_PID" 2>/dev/null; then
    log "API process died during startup"; tail -30 "$RUN/api.err.log"
    exit 1
  fi
  [ "$i" = 90 ] && { log "API never became ready"; tail -30 "$RUN/api.err.log"; exit 1; }
done
log "API ready (pid $API_PID)"

LISTENER_PID=$(ss -ltnp 2>/dev/null | grep ":16343 " | grep -oP 'pid=\K[0-9]+' | head -1)
if [ "${LISTENER_PID:-}" != "$API_PID" ]; then
  log "FATAL: 16343 served by pid ${LISTENER_PID:-?}, not ours ($API_PID) — orphan collision"
  exit 1
fi
log "listener identity verified (pid $API_PID)"

# NO worker here — the fault driver owns the worker lifecycle (F3 kills it).
node scripts/br-b6-e2e/fault-driver.mjs
RC=$?

log "fault-driver rc=$RC"
exit $RC

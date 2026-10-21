#!/usr/bin/env bash
# BR-B6 ladder load-test runner — setup → start API → driver (foreground) →
# always teardown. Run:  nohup setsid bash scripts/br-b6lt/run.sh > .dev/br-b6lt/run.out 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
RUN=.dev/br-b6lt
mkdir -p "$RUN/pids"

log() { echo "[br-b6lt-run] $*"; }

cleanup() {
  log "teardown (always)"
  bash scripts/br-b6lt/teardown.sh || log "teardown reported issues"
}
trap cleanup EXIT

# --- setup (idempotent; port pre-flight inside) ------------------------------
bash scripts/br-b6lt/setup.sh || { log "setup failed — aborting"; exit 1; }

# --- API ----------------------------------------------------------------------
log "starting API (16543)"
(
  set -a
  # shellcheck disable=SC1091
  source "$RUN/api.env"
  set +a
  exec node apps/api/src/server.js
) >> "$RUN/api.log" 2>> "$RUN/api.err.log" &
API_PID=$!
echo "$API_PID" > "$RUN/pids/api"

# wait for ready
for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:16543/api/health/ready >/dev/null 2>&1; then break; fi
  sleep 1
  if ! kill -0 "$API_PID" 2>/dev/null; then
    log "API process died during startup"; tail -30 "$RUN/api.err.log"
    exit 1
  fi
  [ "$i" = 90 ] && { log "API never became ready"; tail -30 "$RUN/api.err.log"; exit 1; }
done
log "API ready (pid $API_PID)"

# listener identity check (orphan-collision guard, same as br-b6-e2e)
LISTENER_PID=$(ss -ltnp 2>/dev/null | grep ":16543 " | grep -oP 'pid=\K[0-9]+' | head -1)
if [ "${LISTENER_PID:-}" != "$API_PID" ]; then
  log "FATAL: 16543 is served by pid ${LISTENER_PID:-?}, not our API pid $API_PID (orphan collision) — aborting"
  tail -5 "$RUN/api.err.log" 2>/dev/null || true
  exit 1
fi
log "listener identity verified (pid $API_PID)"

# --- worker (one; concurrency 50 handles the ladder) ---------------------------
log "starting worker"
(
  set -a
  # shellcheck disable=SC1091
  source "$RUN/worker-base.env"
  set +a
  exec node apps/worker/src/worker.js
) >> "$RUN/worker1.log" 2>> "$RUN/worker1.err.log" &
W1=$!
echo "$W1" > "$RUN/pids/w1"
sleep 2
if ! kill -0 "$W1" 2>/dev/null; then
  log "worker died at startup"; tail -30 "$RUN/worker1.err.log"
  exit 1
fi
log "worker running (pid $W1)"

# --- driver (foreground; its rc is the run's rc) -------------------------------
node scripts/br-b6lt/driver.mjs
RC=$?

log "driver rc=$RC"
exit $RC

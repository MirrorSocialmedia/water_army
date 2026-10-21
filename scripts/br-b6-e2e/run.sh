#!/usr/bin/env bash
# BR-B6 E2E runner — setup → start API → driver (foreground) → always teardown.
# Run:  nohup setsid bash scripts/br-b6-e2e/run.sh > .dev/br-b6-e2e/run.out 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/../.."
RUN=.dev/br-b6-e2e
mkdir -p "$RUN"

log() { echo "[br-b6-e2e-run] $*"; }

cleanup() {
  log "teardown (always)"
  bash scripts/br-b6-e2e/teardown.sh || log "teardown reported issues"
}
trap cleanup EXIT

bash scripts/br-b6-e2e/setup.sh || { log "SETUP FAILED"; exit 1; }

# start the API (the driver owns workers)
: > "$RUN/api.log"; : > "$RUN/api.err.log"
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

# wait for ready
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

# driver (foreground; its rc is the run's rc)
node scripts/br-b6-e2e/driver.mjs
RC=$?

log "driver rc=$RC"
exit $RC

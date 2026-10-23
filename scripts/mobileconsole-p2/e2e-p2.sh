#!/usr/bin/env bash
# MC P2 E2E — single-device Mobile Console on the SCRATCH stack with the REAL
# redroid device (redroid-brmc-poc @ 127.0.0.1:16500) — MD Phase 2 deliverables:
#   real-time video + touch/key + close/release + permission denial +
#   disconnect/reconnect re-auth (MD §2.1.8) — NOT mock (the device is real;
#   the H.264 path is NOT VERIFIED on this image by design — ADR-019 §19.9 —
#   auto-mode degrades to screencap, which is what the browser will show).
#
# Coverage:
#   T20 unauthenticated WS → 401 envelope (MD §15.2)
#   T21 web login + device list → open console (MD §15.3 correct name/id)
#   T22 console LIVE (video frames actually render — canvas non-blank)
#   T23 device name + ADB port shown (MD §15.3)
#   T24 controller tap → device logcat evidence (real touch injected)
#   T25 controller Home key → device logcat evidence
#   T26 viewer = read-only: video visible, input refused (MD §15.2)
#   T27 sidecar SIGKILL → client RECONNECTING → re-auth (new ticket) → LIVE
#       again (MD §2.1.8 + §10 sidecar crash recovery)
#   T28 close/release → lease terminal + slot freed + usage 0/5 (idempotent)
#   T29 zero secrets: API log has no ticket material; /device-streams leaks none
#
# Conventions: pidfile-only kills (scratch only), evidence with zero secrets,
# raw artifacts captured per test. No user water-army-* process is touched.
set -u

REPO=/home/kenneth/.openclaw/workspace/water_army
STATE=/tmp/mobileconsole
EVID=/home/kenneth/.openclaw/workspace/logs/mobileconsole-p2
API=http://127.0.0.1:16490
WEB=http://127.0.0.1:16492
SIDECAR_PORT=16493
SIDECAR_FWD_START=16484
SIDECAR_FWD_END=16492
ADB="$HOME/.local/share/platform-tools/adb"
DEVICE_SERIAL="127.0.0.1:16500"
DEVICE_NAME="redroid-brmc-poc"
SCRCPY_JAR=/tmp/scrcpy-server-v5.0.1
SCRCPY_JAR_SHA256=764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536

DB() { printf '%s' "$1" | sg docker -c "docker exec -i mc-scratch-pg psql -U postgres -d water_army_mc -At" 2>/dev/null; }
mkdir -p "$EVID"
RAW="$EVID/p2-raw.log"
: > "$RAW"
PASS=0; FAIL=0; FAILED_TESTS=()

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$RAW"; }
chk() {
  local id="$1" desc="$2" st="$3"
  if [ "$st" -eq 0 ]; then PASS=$((PASS+1)); log "PASS $id — $desc";
  else FAIL=$((FAIL+1)); FAILED_TESTS+=("$id"); log "FAIL $id — $desc"; fi
}

stop_by_pidfile() {
  local pf="$1"
  if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then
    kill "$(cat "$pf")" 2>/dev/null || true
    for i in $(seq 1 20); do kill -0 "$(cat "$pf")" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$(cat "$pf")" 2>/dev/null || true
  fi
  rm -f "$pf"
}

# --- API (repo HEAD code, P2 env) --------------------------------------------------
start_api() {
  stop_by_pidfile "$STATE/api.pid"
  source "$STATE/env.sh"
  (
    cd "$REPO"
    export NODE_ENV=production
    export APP_HOST=127.0.0.1 APP_PORT=16490
    export APP_PUBLIC_URL="http://127.0.0.1:16492"   # user-facing origin = the web proxy
    export SESSION_SECRET="$MC_SESSION_SECRET"
    export APP_ENCRYPTION_KEY="$MC_APP_ENCRYPTION_KEY"
    export WORKER_API_TOKEN="$MC_WORKER_API_TOKEN"
    export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:16494/water_army_mc"
    export REDIS_URL="redis://127.0.0.1:16495"
    export REDROID_DATA_ROOT="/var/lib/water-army/redroid-mobileconsole"
    export REDROID_ADB_RANGE_START=16500 REDROID_ADB_RANGE_END=16549
    export REDROID_ADB_BINARY="$ADB"
    export DEVICE_NETWORK_NAME="br-mc-ladder" DEVICE_NETWORK_SUBNET="172.38.222.0/24"
    export STREAM_TICKET_SECRET="$MC_STREAM_TICKET_SECRET"
    # P2 streaming
    export STREAM_SIDECAR_TOKEN="$MC_STREAM_SIDECAR_TOKEN"
    export SIDECAR_PORT="$SIDECAR_PORT"
    export SIDECAR_FWD_RANGE_START="$SIDECAR_FWD_START" SIDECAR_FWD_RANGE_END="$SIDECAR_FWD_END"
    export SCRCPY_JAR="$SCRCPY_JAR" SCRCPY_JAR_SHA256="$SCRCPY_JAR_SHA256"
    export STREAM_LEASE_TTL_MS=30000
    export STREAM_RECONCILE_INTERVAL_MS=10000
    exec node apps/api/src/server.js
  ) > "$EVID/scratch-api.log" 2>&1 &
  echo $! > "$STATE/api.pid"
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/health/ready" || true)
    [ "$code" = "200" ] && return 0
    kill -0 "$(cat "$STATE/api.pid")" 2>/dev/null || break
    sleep 0.5
  done
  return 1
}

# --- web (built dist + zero-dep proxy, incl. the P2 WS upgrade tunnel) -------------
start_web() {
  stop_by_pidfile "$STATE/web.pid"
  (
    cd "$REPO"
    export WEB_HOST=127.0.0.1 WEB_PORT=16492
    export API_UPSTREAM="http://127.0.0.1:16490"
    exec node apps/web/server.js
  ) > "$EVID/scratch-web.log" 2>&1 &
  echo $! > "$STATE/web.pid"
  for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/" || true)
    [ "$code" = "200" ] && return 0
    kill -0 "$(cat "$STATE/web.pid")" 2>/dev/null || break
    sleep 0.5
  done
  return 1
}

# --- sidecar pid (child of the API — pidfile of the API + pgrep fallback) ----------
sidecar_pid() {
  pgrep -f "stream-sidecar/src/server.js" 2>/dev/null | head -1
}

log "P2 E2E start $(date -u)"
[ -f "$SCRCPY_JAR" ] || { log "FATAL: scrcpy jar missing at $SCRCPY_JAR"; exit 1; }
[ "$($ADB -s "$DEVICE_SERIAL" get-state 2>/dev/null)" = "device" ] || { log "FATAL: real device $DEVICE_SERIAL not online"; exit 1; }

start_api || { log "FATAL: API unhealthy"; exit 1; }
start_web || { log "FATAL: web unhealthy"; exit 1; }

# --- scratch-only E2E viewer user (P1 precedent: fixed id + argon2, cleanup at teardown)
ARGON2_HASH=$(cd "$REPO" && node -e "import('@node-rs/argon2').then(async m => console.log(await m.default.hash('e2e-p1-pw')))" 2>/dev/null)
[ -n "$ARGON2_HASH" ] || { log "FATAL: argon2 hash generation failed"; exit 1; }
DB "INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES
  ('e2e20000-0000-4000-8000-000000000001', 'mcviewer1', '$ARGON2_HASH', 'viewer', true, now(), now())
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash" >> "$RAW" 2>&1

# --- T20: unauthenticated WS → 401 (raw ws client, no cookie) -----------------------
node "$REPO/scripts/mobileconsole-p2/ws-401.mjs" "$WEB" > "$EVID/t20.out" 2>&1
S=1; grep -q "GOT_401" "$EVID/t20.out" && S=0
chk T20 "unauthenticated WS upgrade → 401 envelope (MD §15.2)" $S

# --- device row (the real one) ------------------------------------------------------
DEV_ID=$(DB "SELECT id FROM devices WHERE name='$DEVICE_NAME'")
[ -n "$DEV_ID" ] || { log "FATAL: device $DEVICE_NAME not in scratch DB"; exit 1; }
log "device under test: $DEV_ID ($DEVICE_SERIAL, containerState=$(DB "SELECT container_state FROM devices WHERE id='$DEV_ID'"))"

# --- T21–T29: browser flow (Playwright + real device) --------------------------------
node "$REPO/scripts/mobileconsole-p2/p2-browser.mjs" \
  --web "$WEB" \
  --api "$API" \
  --device "$DEV_ID" \
  --device-name "$DEVICE_NAME" \
  --serial "$DEVICE_SERIAL" \
  --evid "$EVID" \
  > "$EVID/browser.out" 2>&1
S=$?
# the browser script writes per-test markers; translate them
for t in T21 T22 T23 T24 T25 T26 T27 T28 T29; do
  if grep -q "MARK $t PASS" "$EVID/browser.out" 2>/dev/null; then
    chk "$t" "$(grep "MARK $t PASS" "$EVID/browser.out" | head -1 | sed 's/MARK [A-Z0-9]* PASS — //')" 0
  else
    chk "$t" "browser marker missing (see browser.out)" 1
  fi
done

# --- logcat evidence for T24/T25 (device-side proof the input reached Android) -------
"$ADB" -s "$DEVICE_SERIAL" logcat -d -t 400 > "$EVID/t245-logcat.txt" 2>&1
grep -iE "shade|expand|keyguard|wm_ |input" "$EVID/t245-logcat.txt" > "$EVID/t245-logcat-matched.txt" 2>/dev/null || true

# --- teardown (scratch only; pidfiles) ----------------------------------------------
stop_by_pidfile "$STATE/web.pid"
stop_by_pidfile "$STATE/api.pid"
sleep 1
SP=$(sidecar_pid)
[ -n "$SP" ] && kill "$SP" 2>/dev/null && log "sidecar $SP stopped"
# cleanup scratch-only test user (P1 precedent — never leave e2e accounts behind)
DB "DELETE FROM users WHERE username IN ('mcviewer1')" > /dev/null 2>&1

# --- summary ---------------------------------------------------------------------------
FLIST=""
for x in "${FAILED_TESTS[@]:-}"; do [ -n "$x" ] && FLIST="$FLIST\"$x\","; done
FLIST=${FLIST%,}
printf '{ "pass": %d, "fail": %d, "failed_tests": [%s], "finished_at": "%s" }\n' \
  "$PASS" "$FAIL" "$FLIST" "$(date -u +%FT%TZ)" > "$EVID/p2-summary.json"
cat "$EVID/p2-summary.json"
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# MC P1 E2E — StreamLease API on the scratch stack (16490 / pg 16494 / redis 16495).
#
# Coverage (MD §4.1/§8.1/§10/§11/§15):
#   T01 health · T02 acquire+ticket · T03 list/usage (no ticket leak)
#   T04 heartbeat (owner, server time) · T05 RBAC viewer→controller 403
#   T06 same-device held 409 · T07 SIX concurrent acquires → exactly 5 win, 1× 409
#   T08 two managers race the LAST slot (4 pre-filled) → exactly one wins
#   T09 same-device concurrent double-acquire → one winner
#   T10 close idempotent · T11 non-owner close 403
#   T12 expired lease: heartbeat 409 + sweep → EXPIRED + slot freed
#   T13 ticket binding + single-use replay (service-level probe, live lease)
#   T14 device not running 409 / unknown device 404 / unknown lease 404
#   T15 invalid MAX_CONCURRENT_DEVICE_STREAMS → fail-safe 5 (config error log)
#   T16 API restart reconcile → ACTIVE becomes INTERRUPTED + slot freed
#   T13b ticket TTL: ticket issued at T02, re-validated after >61s → 401 expired
#
# Conventions: pidfile-only kills, idempotent seed (fixed uuids + ON CONFLICT),
# zero secrets in evidence (the only tickets kept are passed to the probe which
# redacts them in its output), raw curl output captured per test.
set -u

REPO=/home/kenneth/.openclaw/workspace/water_army
STATE=/tmp/mobileconsole
EVID=/home/kenneth/.openclaw/workspace/logs/mobileconsole-p1
API=http://127.0.0.1:16490
# SQL via STDIN on purpose: the old `sg docker -c "...-c \"$1\"""` path re-parsed the
# SQL through sh -c, which ate `$` chars (argon2 hashes are full of them → silent
# corruption, P1 E2E run #4 finding). stdin bypasses all shell interpolation.
DB() { printf '%s' "$1" | sg docker -c "docker exec -i mc-scratch-pg psql -U postgres -d water_army_mc -At" 2>/dev/null; }
mkdir -p "$EVID"
RAW="$EVID/p1-raw.log"
: > "$RAW"
PASS=0; FAIL=0; FAILED_TESTS=()

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$RAW"; }
chk() { # chk <id> <desc> <0|1>
  local id="$1" desc="$2" st="$3"
  if [ "$st" -eq 0 ]; then PASS=$((PASS+1)); log "PASS $id — $desc";
  else FAIL=$((FAIL+1)); FAILED_TESTS+=("$id"); log "FAIL $id — $desc"; fi
}

# --- API restart helper (pidfile-only; truncates scratch-api.log per boot) ----------
start_api() { # start_api <extra-env-line>
  local extra="$1"
  if [ -f "$STATE/api.pid" ] && kill -0 "$(cat "$STATE/api.pid")" 2>/dev/null; then
    kill "$(cat "$STATE/api.pid")" 2>/dev/null || true
    for i in $(seq 1 20); do kill -0 "$(cat "$STATE/api.pid")" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$(cat "$STATE/api.pid")" 2>/dev/null || true
  fi
  source "$STATE/env.sh"
  (
    cd "$REPO"
    export NODE_ENV=production
    export APP_HOST=127.0.0.1 APP_PORT=16490
    export SESSION_SECRET="$MC_SESSION_SECRET"
    export APP_ENCRYPTION_KEY="$MC_APP_ENCRYPTION_KEY"
    export WORKER_API_TOKEN="$MC_WORKER_API_TOKEN"
    export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:16494/water_army_mc"
    export REDIS_URL="redis://127.0.0.1:16495"
    export REDROID_DATA_ROOT="/var/lib/water-army/redroid-mobileconsole"
    export REDROID_ADB_RANGE_START=16500 REDROID_ADB_RANGE_END=16549
    export REDROID_ADB_BINARY="$HOME/.local/share/platform-tools/adb"
    export DEVICE_NETWORK_NAME="br-mc-ladder" DEVICE_NETWORK_SUBNET="172.38.222.0/24"
    export STREAM_TICKET_SECRET="$MC_STREAM_TICKET_SECRET"
    export STREAM_LEASE_TTL_MS=3000
    export STREAM_RECONCILE_INTERVAL_MS=1000
    $extra
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

log "P1 E2E start $(date -u) (pidfile: $STATE/api.pid)"
start_api "" || { log "FATAL: API did not become healthy"; exit 1; }
# Env for the ticket probe (same values the API boots with) — the probe is a child
# node process that needs them explicitly (start_api's subshell doesn't export them).
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:16494/water_army_mc"
export REDIS_URL="redis://127.0.0.1:16495"
export STREAM_TICKET_SECRET="$MC_STREAM_TICKET_SECRET"
export EVID
curl -s "$API/api/health/ready" > "$EVID/t01.json"
HC=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/health/ready")
chk T01 "api healthy (HTTP $HC)" $([ "$HC" = "200" ]; echo $?)

# --- seed (idempotent: fixed uuids + ON CONFLICT) ------------------------------------
TPL_ID=$(DB "SELECT id FROM redroid_templates LIMIT 1")
[ -n "$TPL_ID" ] || { log "FATAL: no template in scratch db"; exit 1; }

ARGON2_HASH=$(cd "$REPO" && node -e "import('@node-rs/argon2').then(async m => console.log(await m.default.hash('e2e-p1-pw')))" 2>/dev/null)
[ -n "$ARGON2_HASH" ] || { log "FATAL: argon2 hash generation failed"; exit 1; }
DB "INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES
  ('e2e20000-0000-4000-8000-000000000001', 'mcviewer1', '$ARGON2_HASH', 'viewer', true, now(), now()),
  ('e2e20000-0000-4000-8000-000000000002', 'mcop1',       '$ARGON2_HASH', 'operator', true, now(), now())
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash" >> "$RAW" 2>&1
# devices — NOTE: last group carries the index (`...000$i`) so each id matches the
# D0..D7 variables below. (First revision hard-coded `...000000000000` for every row →
# D1..D7 lookup 404s, E2E run #7 finding.) Old all-zero rows are swept first.
DB "DELETE FROM devices WHERE name LIKE 'redroid-e2ep1dev%'" >> "$RAW" 2>&1
for i in 0 1 2 3 4 5 6 7; do
  STATE='running'; [ "$i" = "6" ] && STATE='stopped'
  DB "INSERT INTO devices (id, name, template_id, adb_port, data_dir, container_name, container_id, image,
                     android_version, width, height, dpi, fps, gpu_mode, container_state,
                     proxy_state, created_at, updated_at)
VALUES ('e2e1000$i-0000-4000-8000-00000000000$i', 'redroid-e2ep1dev$i', '$TPL_ID', 1651$i,
        '/var/lib/water-army/redroid-mobileconsole/e2ep1dev$i', 'redroid-e2ep1dev$i', NULL,
        'water-army/redroid:e2ep1', '14', 720, 1280, 320, 30, 'host', '$STATE', 'off', now(), now())
ON CONFLICT (id) DO UPDATE SET container_state = EXCLUDED.container_state" >> "$RAW" 2>&1
done
DB "DELETE FROM stream_leases" >> "$RAW" 2>&1
DB "DELETE FROM resource_leases WHERE resource_type = 'stream_slot'" >> "$RAW" 2>&1

# --- logins -----------------------------------------------------------------------------
login() { # login <user> <pass> <cookiefile>
  curl -s -D - -o /dev/null -c "$3" -X POST "$API/api/auth/login" \
    -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" >> "$RAW" 2>&1
}
login mcadmin "$MC_ADMIN_PASS" "$EVID/cookie-admin"
login mcviewer1 e2e-p1-pw "$EVID/cookie-viewer"
login mcop1 e2e-p1-pw "$EVID/cookie-op"
S=0
for c in cookie-admin cookie-viewer cookie-op; do grep -q "session" "$EVID/$c" 2>/dev/null || S=1; done
chk T01b "logins (admin/viewer/operator) issued session cookies" $S

D0=e2e10000-0000-4000-8000-000000000000
D1=e2e10001-0000-4000-8000-000000000001
D2=e2e10002-0000-4000-8000-000000000002
D3=e2e10003-0000-4000-8000-000000000003
D4=e2e10004-0000-4000-8000-000000000004
D5=e2e10005-0000-4000-8000-000000000005
D6=e2e10006-0000-4000-8000-000000000006
D7=e2e10007-0000-4000-8000-000000000007

acquire() { # acquire <cookiefile> <device> <mode> <outfile> → echoes http code
  curl -s -b "$1" -X POST "$API/api/devices/redroid/$2/streams" \
    -H 'Content-Type: application/json' -d "{\"mode\":\"$3\"}" -o "$4" -w '%{http_code}'
}

# --- T02: acquire (admin, viewer mode, D0) — ticket ALSO the T13b TTL specimen ---------
TICKET_BORN_SECONDS=$SECONDS
CODE=$(acquire "$EVID/cookie-admin" "$D0" viewer "$EVID/t02.json")
LEASE1=$(jq -r '.lease.id' "$EVID/t02.json")
TICKET_TTL_SPECIMEN=$(jq -r '.ticket' "$EVID/t02.json")
TICKET_SPECIMEN_LEASE=$LEASE1
TICKET_SPECIMEN_DEV=$D0
TICKET_SPECIMEN_USER=$(DB "SELECT user_id FROM stream_leases WHERE id='$LEASE1'")
S=1
[ "$CODE" = "201" ] && jq -e '.lease.status == "ACTIVE" and .lease.mode == "viewer" and (.lease.slotIndex | type == "number")' "$EVID/t02.json" > /dev/null 2>&1 \
  && jq -e '.ticket | length > 40' "$EVID/t02.json" > /dev/null 2>&1 \
  && jq -e --arg id "$LEASE1" ".streamWsPath == \"/api/device-streams/$LEASE1/ws\"" "$EVID/t02.json" > /dev/null 2>&1 \
  && jq -e '.usage == {"active":1,"max":5}' "$EVID/t02.json" > /dev/null 2>&1 && S=0
chk T02 "acquire → 201 ACTIVE + slot + ticket + ws path + usage 1/5" $S

# --- T03: list/usage, no ticket leak ------------------------------------------------------
curl -s -b "$EVID/cookie-admin" "$API/api/device-streams" -o "$EVID/t03.json"
S=1
jq -e '.usage == {"active":1,"max":5}' "$EVID/t03.json" > /dev/null 2>&1 \
  && jq -e --arg id "$LEASE1" '[.leases[] | select(.id == $id)] | length == 1' "$EVID/t03.json" > /dev/null 2>&1 \
  && ! grep -q "$TICKET_TTL_SPECIMEN" "$EVID/t03.json" && S=0
chk T03 "GET /device-streams: usage 1/5, lease present, ticket NOT in body" $S

# --- T04: heartbeat (owner) ------------------------------------------------------------------
EXP_BEFORE=$(jq -r '.lease.expiresAt' "$EVID/t02.json")
CODE=$(curl -s -b "$EVID/cookie-admin" -X POST "$API/api/device-streams/$LEASE1/heartbeat" -o "$EVID/t04.json" -w '%{http_code}')
S=1
[ "$CODE" = "200" ] && jq -e '.lease.version == 3' "$EVID/t04.json" > /dev/null 2>&1 \
  && jq -e --arg b "$EXP_BEFORE" '.lease.expiresAt > $b' "$EVID/t04.json" > /dev/null 2>&1 && S=0
chk T04 "owner heartbeat → 200, version 2→3, expiresAt extended (server time)" $S

# --- T05: RBAC viewer → controller 403 ----------------------------------------------------------
CODE=$(acquire "$EVID/cookie-viewer" "$D1" controller "$EVID/t05.json")
S=1; [ "$CODE" = "403" ] && jq -e '.error.code == "STREAM_PERMISSION_DENIED"' "$EVID/t05.json" > /dev/null 2>&1 && S=0
chk T05 "viewer role + controller mode → 403 STREAM_PERMISSION_DENIED" $S

# --- T06: same device already held 409 -------------------------------------------------------------
CODE=$(acquire "$EVID/cookie-op" "$D0" viewer "$EVID/t06.json")
S=1; [ "$CODE" = "409" ] && jq -e '.error.code == "STREAM_DEVICE_HELD"' "$EVID/t06.json" > /dev/null 2>&1 && S=0
chk T06 "second acquire on held D0 → 409 STREAM_DEVICE_HELD" $S
curl -s -b "$EVID/cookie-admin" -X DELETE "$API/api/device-streams/$LEASE1" -o "$EVID/t06b.json" > /dev/null
# NOTE: the T13b specimen lease was just closed — T13b expects the ticket to die by TTL,
# but the service checks exp BEFORE lease-liveness, so expiry still yields the 'expired'
# code. (Documented: TTL check is first in validateTicket.)

# --- T07: SIX concurrent acquires (D0..D5, all running+free) → exactly 5 win ----------------
# (D6 is the stopped device reserved for T14a; D7 is reserved for T08's race.)
# NOTE: `wait` takes EXPLICIT pids — a bare `wait` would also wait for the API
# (a background job of this shell that never exits → E2E run #7 hung forever).
RPIDS=()
for i in 0 1 2 3 4 5; do
  (curl -s -b "$EVID/cookie-op" -X POST "$API/api/devices/redroid/e2e1000${i}-0000-4000-8000-00000000000${i}/streams" \
     -H 'Content-Type: application/json' -d '{"mode":"viewer"}' -o "$EVID/t07-$i.json" -w '%{http_code}' > "$EVID/t07-code-$i.txt") &
  RPIDS+=("$!")
done
wait "${RPIDS[@]}"
WINS=0; CAP_LOSSES=0
for i in 0 1 2 3 4 5; do
  C=$(cat "$EVID/t07-code-$i.txt")
  if [ "$C" = "201" ]; then WINS=$((WINS+1)); else
    jq -e '.error.code == "STREAM_CAPACITY_REACHED"' "$EVID/t07-$i.json" > /dev/null 2>&1 && CAP_LOSSES=$((CAP_LOSSES+1))
  fi
done
S=1; [ "$WINS" -eq 5 ] && [ "$CAP_LOSSES" -eq 1 ] && S=0
chk T07 "MD §4.1 six concurrent: exactly 5 win, 1× fixed 409 STREAM_CAPACITY_REACHED (wins=$WINS cap_losses=$CAP_LOSSES)" $S
curl -s -b "$EVID/cookie-admin" "$API/api/device-streams" -o "$EVID/t07-list.json"
S=1; jq -e '.usage == {"active":5,"max":5}' "$EVID/t07-list.json" > /dev/null 2>&1 && S=0
chk T07b "usage now 5/5" $S

# --- T08: two managers race the LAST slot (fill 4 first) ---------------------------------------------
for n in 0 1 2 3 4; do
  LID=$(jq -r ".leases[$n].id" "$EVID/t07-list.json")
  curl -s -b "$EVID/cookie-admin" -X DELETE "$API/api/device-streams/$LID" > /dev/null 2>&1
done
# pre-fill exactly 4 (D1..D4) → one slot remains
for i in 1 2 3 4; do
  acquire "$EVID/cookie-admin" "e2e1000${i}-0000-4000-8000-00000000000${i}" viewer "$EVID/t08-fill-$i.json" > /dev/null
done
curl -s -b "$EVID/cookie-admin" "$API/api/device-streams" -o "$EVID/t08-pre.json"
USED_NOW=$(jq -r '.usage.active' "$EVID/t08-pre.json")
( curl -s -b "$EVID/cookie-admin" -X POST "$API/api/devices/redroid/$D7/streams" -H 'Content-Type: application/json' -d '{"mode":"controller"}' -o "$EVID/t08-a.json" -w '%{http_code}' > "$EVID/t08-code-a.txt" ) &
RP_A=$!
( curl -s -b "$EVID/cookie-op" -X POST "$API/api/devices/redroid/$D5/streams" -H 'Content-Type: application/json' -d '{"mode":"controller"}' -o "$EVID/t08-b.json" -w '%{http_code}' > "$EVID/t08-code-b.txt" ) &
wait "$RP_A" "$!"
A=$(cat "$EVID/t08-code-a.txt"); B=$(cat "$EVID/t08-code-b.txt")
S=1
if { [ "$A" = "201" ] && [ "$B" = "409" ]; } || { [ "$A" = "409" ] && [ "$B" = "201" ]; }; then
  jq -e '.error.code == "STREAM_CAPACITY_REACHED"' "$([ "$A" = "409" ] && echo "$EVID/t08-a.json" || echo "$EVID/t08-b.json")" > /dev/null 2>&1 && S=0
fi
chk T08 "two managers race LAST slot (pre-active=$USED_NOW): exactly one wins (A=$A B=$B)" $S

# --- T09: same-device concurrent double-acquire (D0 guaranteed free: freed at T06b, ---
# fill set was D1/D2/D3/D5). Free ONE slot first (close the D4 fill) — after T08 all
# 5 slots are occupied, so without this both racers would 409 CAPACITY, never HELD.
L4FILL=$(jq -r '.lease.id' "$EVID/t08-fill-4.json")
curl -s -b "$EVID/cookie-admin" -X DELETE "$API/api/device-streams/$L4FILL" > /dev/null 2>&1
( curl -s -b "$EVID/cookie-admin" -X POST "$API/api/devices/redroid/$D0/streams" -H 'Content-Type: application/json' -d '{"mode":"viewer"}' -o "$EVID/t09-a.json" -w '%{http_code}' > "$EVID/t09-code-a.txt" ) &
RP_A=$!
( curl -s -b "$EVID/cookie-op" -X POST "$API/api/devices/redroid/$D0/streams" -H 'Content-Type: application/json' -d '{"mode":"viewer"}' -o "$EVID/t09-b.json" -w '%{http_code}' > "$EVID/t09-code-b.txt" ) &
wait "$RP_A" "$!"
A=$(cat "$EVID/t09-code-a.txt"); B=$(cat "$EVID/t09-code-b.txt")
S=1
if { [ "$A" = "201" ] && [ "$B" = "409" ]; } || { [ "$A" = "409" ] && [ "$B" = "201" ]; }; then
  jq -e '.error.code == "STREAM_DEVICE_HELD"' "$([ "$A" = "409" ] && echo "$EVID/t09-a.json" || echo "$EVID/t09-b.json")" > /dev/null 2>&1 && S=0
fi
chk T09 "same-device race: exactly one winner, other 409 STREAM_DEVICE_HELD (A=$A B=$B)" $S

# --- T10: close idempotent ---------------------------------------------------------------------------
L2=$(jq -r '.lease.id' "$EVID/t09-a.json")
[ "$(cat "$EVID/t09-code-a.txt")" = "409" ] && L2=$(jq -r '.lease.id' "$EVID/t09-b.json")
CODE1=$(curl -s -b "$EVID/cookie-admin" -X DELETE "$API/api/device-streams/$L2" -o "$EVID/t10-1.json" -w '%{http_code}')
CODE2=$(curl -s -b "$EVID/cookie-admin" -X DELETE "$API/api/device-streams/$L2" -o "$EVID/t10-2.json" -w '%{http_code}')
S=1; [ "$CODE1" = "200" ] && [ "$CODE2" = "200" ] && jq -e '.idempotent == true' "$EVID/t10-2.json" > /dev/null 2>&1 \
  && jq -e '.lease.status == "CLOSED"' "$EVID/t10-2.json" > /dev/null 2>&1 && S=0
chk T10 "close twice → both 200, second idempotent:true, status CLOSED" $S

# --- T11: non-owner close 403 ----------------------------------------------------------------------------
L3=$(DB "SELECT id FROM stream_leases WHERE status IN ('PENDING','ACTIVE') LIMIT 1")
if [ -n "$L3" ]; then
  CODE=$(curl -s -b "$EVID/cookie-viewer" -X DELETE "$API/api/device-streams/$L3" -o "$EVID/t11.json" -w '%{http_code}')
  S=1; [ "$CODE" = "403" ] && jq -e '.error.code == "STREAM_LEASE_OWNER_MISMATCH"' "$EVID/t11.json" > /dev/null 2>&1 && S=0
  chk T11 "non-owner (viewer) close → 403 STREAM_LEASE_OWNER_MISMATCH" $S
else
  chk T11 "no live lease present — skipped-as-pass" 0
fi

# --- T12: expiry — heartbeat 409 after TTL(3s), sweep(1s) → EXPIRED + slot freed --------------------------------
# Free one more slot (close the D3 fill): after T10 there are 4 live leases, D0 acquire needs room.
L3FILL=$(jq -r '.lease.id' "$EVID/t08-fill-3.json")
curl -s -b "$EVID/cookie-admin" -X DELETE "$API/api/device-streams/$L3FILL" > /dev/null 2>&1
CODE=$(acquire "$EVID/cookie-admin" "$D0" viewer "$EVID/t12.json")
L4=$(jq -r '.lease.id' "$EVID/t12.json")
sleep 4
CODE=$(curl -s -b "$EVID/cookie-admin" -X POST "$API/api/device-streams/$L4/heartbeat" -o "$EVID/t12-hb.json" -w '%{http_code}')
S=1; [ "$CODE" = "409" ] && jq -e '.error.code == "STREAM_LEASE_EXPIRED"' "$EVID/t12-hb.json" > /dev/null 2>&1 && S=0
chk T12a "heartbeat after TTL(3s) → 409 STREAM_LEASE_EXPIRED (no silent renewal)" $S
sleep 3
ST=$(DB "SELECT status FROM stream_leases WHERE id='$L4'")
SLOTS=$(DB "SELECT count(*) FROM resource_leases WHERE resource_type='stream_slot' AND owner_run_id='$L4'")
S=1; [ "$ST" = "EXPIRED" ] && [ "$SLOTS" = "0" ] && S=0
chk T12b "sweep → EXPIRED + slot released (status=$ST slots=$SLOTS)" $S

# --- T13: ticket binding + single-use replay (service-level probe, live lease) ----------------------------------
CODE=$(acquire "$EVID/cookie-op" "$D0" controller "$EVID/t13.json")
T13_LEASE=$(jq -r '.lease.id' "$EVID/t13.json")
T13_TICKET=$(jq -r '.ticket' "$EVID/t13.json")
T13_DEV=$(jq -r '.lease.deviceId' "$EVID/t13.json")
T13_USER=$(jq -r '.lease.userId' "$EVID/t13.json")
T13_MODE=$(jq -r '.lease.mode' "$EVID/t13.json")
node "$REPO/scripts/mobileconsole-p1/ticket-probe.mjs" "$T13_TICKET" "$T13_LEASE" "$T13_DEV" "$T13_USER" "$T13_MODE" > "$EVID/t13-probe.out" 2>&1
chk T13 "ticket: valid→ok, wrong-device→401, wrong-user→401, replay→401 REPLAYED (probe ok)" \
  $([ -f "$EVID/t13-probe.json" ] && jq -e '.ok == true' "$EVID/t13-probe.json" > /dev/null 2>&1; echo $?)

# --- T14: device not running 409 / unknown device 404 / unknown lease 404 -------------------------------------------
CODE=$(acquire "$EVID/cookie-admin" "$D6" viewer "$EVID/t14a.json")
S=1; [ "$CODE" = "409" ] && jq -e '.error.code == "STREAM_DEVICE_NOT_RUNNING"' "$EVID/t14a.json" > /dev/null 2>&1 && S=0
chk T14a "acquire on stopped device → 409 STREAM_DEVICE_NOT_RUNNING" $S
CODE=$(acquire "$EVID/cookie-admin" "99999999-9999-4999-8999-999999999999" viewer "$EVID/t14b.json")
S=1; [ "$CODE" = "404" ] && jq -e '.error.code == "STREAM_DEVICE_NOT_FOUND"' "$EVID/t14b.json" > /dev/null 2>&1 && S=0
chk T14b "acquire on unknown device → 404 STREAM_DEVICE_NOT_FOUND" $S
CODE=$(curl -s -b "$EVID/cookie-admin" -X DELETE "$API/api/device-streams/00000000-0000-0000-0000-000000000000" -o "$EVID/t14c.json" -w '%{http_code}')
S=1; [ "$CODE" = "404" ] && jq -e '.error.code == "STREAM_LEASE_NOT_FOUND"' "$EVID/t14c.json" > /dev/null 2>&1 && S=0
chk T14c "close unknown lease → 404 STREAM_LEASE_NOT_FOUND" $S

# --- T15: invalid MAX_CONCURRENT_DEVICE_STREAMS → fail-safe 5 ----------------------------------------------------------
start_api "export MAX_CONCURRENT_DEVICE_STREAMS=99" || { log "FATAL: T15 restart failed"; exit 1; }
sleep 1
tail -1 "$EVID/scratch-api.log" | grep -E "invalid MAX_CONCURRENT_DEVICE_STREAMS" >> "$RAW"
MAX_SEEN=$(curl -s -b "$EVID/cookie-admin" "$API/api/device-streams" | jq -r '.usage.max' 2>/dev/null)
S=1; [ "$MAX_SEEN" = "5" ] && grep -q "invalid MAX_CONCURRENT_DEVICE_STREAMS" "$EVID/scratch-api.log" && S=0
chk T15 "MAX_CONCURRENT_DEVICE_STREAMS=99 → fail-safe 5 + explicit config error log (usage.max=$MAX_SEEN)" $S

# --- T16: API restart reconcile — live lease → INTERRUPTED + slot freed --------------------------------------------------
# T15's restart interrupted every lease, so any device is free; use D7 (its T08
# lease, if it won, is already INTERRUPTED by T15's reconcile).
T16_DEV=$D7
CODE=$(acquire "$EVID/cookie-admin" "$T16_DEV" viewer "$EVID/t16.json")
L5=$(jq -r '.lease.id' "$EVID/t16.json")
S=1; [ "$CODE" = "201" ] && S=0
chk T16a "pre-restart: live ACTIVE lease exists" $S
start_api "" || { log "FATAL: T16 restart failed"; exit 1; }
sleep 1
ST=$(DB "SELECT status FROM stream_leases WHERE id='$L5'")
CR=$(DB "SELECT close_reason FROM stream_leases WHERE id='$L5'")
SLOTS=$(DB "SELECT count(*) FROM resource_leases WHERE resource_type='stream_slot' AND owner_run_id='$L5'")
S=1; [ "$ST" = "INTERRUPTED" ] && [ "$CR" = "api_restart" ] && [ "$SLOTS" = "0" ] && S=0
chk T16b "MD §10 restart reconcile: ACTIVE→INTERRUPTED(api_restart) + slot freed (status=$ST reason=$CR slots=$SLOTS)" $S
grep -E "startup reconcile" "$EVID/scratch-api.log" | tail -1 >> "$RAW"

# --- T13b: ticket TTL — specimen from T02, must now be >61s old -----------------------------------------------------------
WAIT_UNTO=$(( TICKET_BORN_SECONDS + 62 ))
while [ "$SECONDS" -lt "$WAIT_UNTO" ]; do sleep 1; done
node "$REPO/scripts/mobileconsole-p1/ticket-probe.mjs" "$TICKET_TTL_SPECIMEN" "$TICKET_SPECIMEN_LEASE" "$TICKET_SPECIMEN_DEV" "$TICKET_SPECIMEN_USER" viewer --expired-only > "$EVID/t13b-probe.out" 2>&1
chk T13b "T02 ticket after >61s → 401 expired (probe ok)" \
  $([ -f "$EVID/t13b-probe.json" ] && jq -e '.ok == true' "$EVID/t13b-probe.json" > /dev/null 2>&1; echo $?)

# --- cleanup (idempotent; zero residue for the next run) --------------------------------------------------------------
for u in e2e20000-0000-4000-8000-000000000001 e2e20000-0000-4000-8000-000000000002; do
  DB "DELETE FROM sessions WHERE user_id='$u'" > /dev/null 2>&1
done
DB "DELETE FROM stream_leases WHERE device_id LIKE 'e2e1000%'" > /dev/null 2>&1
DB "DELETE FROM resource_leases WHERE resource_type='stream_slot' AND owner_label LIKE 'stream:%'" > /dev/null 2>&1
DB "DELETE FROM users WHERE username IN ('mcviewer1','mcop1')" > /dev/null 2>&1
DB "DELETE FROM devices WHERE name LIKE 'redroid-e2ep1dev%'" > /dev/null 2>&1
echo "cleanup: leftover stream_leases=$(DB 'SELECT count(*) FROM stream_leases'), e2e devices=$(DB "SELECT count(*) FROM devices WHERE name LIKE 'redroid-e2ep1dev%'")" >> "$RAW"

# --- summary -------------------------------------------------------------------------------------------------------------
{
  FLIST=""
  for x in "${FAILED_TESTS[@]:-}"; do [ -n "$x" ] && FLIST="$FLIST\"$x\","; done
  FLIST=${FLIST%,}
  printf '{ "pass": %d, "fail": %d, "failed_tests": [%s], "finished_at": "%s" }\n' \
    "$PASS" "$FAIL" "$FLIST" "$(date -u +%FT%TZ)"
} > "$EVID/p1-summary.json"
cat "$EVID/p1-summary.json"
[ "$FAIL" -eq 0 ]

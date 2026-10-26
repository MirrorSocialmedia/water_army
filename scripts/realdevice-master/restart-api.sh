#!/usr/bin/env bash
# restart-api.sh — scratch rdev API restart (W3 phase).
#
# Mirrors bringup.sh's API launch block EXACTLY (same env surface) with the
# W3 switches flipped ON + the echo host pointed at the ladder gateway IP
# (172.38.222.1) — bringup's placeholder 127.0.0.1 is unreachable from the
# egress containers. Optional arg 1 = override env file (sourced LAST, so it
# wins): D8 passes an empty-echo override; D9 passes stale/poll overrides.
#
# Usage: restart-api.sh [override-env-file]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

OVERRIDE_FILE="${1:-}"

stop_by_pidfile "$RD_STATE/api.pid"
# wait for the port to actually release (max 15s)
for _ in $(seq 1 15); do
  if ! (exec 3<>/dev/tcp/127.0.0.1/16490) 2>/dev/null; then break; fi
  exec 3>&- 2>/dev/null || true
  sleep 1
done

( # shellcheck disable=SC1091
  . "$RD_SECRETS"
  cd "$RD_REPO"
  export NODE_ENV=production
  export APP_HOST=127.0.0.1 APP_PORT=16490
  export APP_PUBLIC_URL="http://127.0.0.1:16492"
  export SESSION_SECRET="$MC_SESSION_SECRET"
  export APP_ENCRYPTION_KEY="$MC_APP_ENCRYPTION_KEY"
  export WORKER_API_TOKEN="$MC_WORKER_API_TOKEN"
  export DATABASE_URL="$RD_PG_URL"
  export REDIS_URL="redis://127.0.0.1:16495"
  export REDROID_DATA_ROOT="$RD_DATA_ROOT"
  export REDROID_ADB_RANGE_START=16500 REDROID_ADB_RANGE_END=16549
  export REDROID_ADB_BINARY="$RD_ADB"
  export DEVICE_NETWORK_NAME="$RD_NET" DEVICE_NETWORK_SUBNET="$RD_NET_SUBNET"
  export STREAM_TICKET_SECRET="$MC_STREAM_TICKET_SECRET"
  export STREAM_SIDECAR_TOKEN="$MC_STREAM_SIDECAR_TOKEN"
  export SIDECAR_PORT=16493
  export SIDECAR_FWD_RANGE_START=16460 SIDECAR_FWD_RANGE_END=16469
  export SCRCPY_JAR="$RD_JAR_PATH" SCRCPY_JAR_SHA256="$RD_JAR_SHA256"
  export STREAM_LEASE_TTL_MS=30000
  export STREAM_RECONCILE_INTERVAL_MS=10000
  # phase switches: W1 ON (fingerprint), W2 ON (app ops), W3 ON (egress binding)
  export WA_REDROID_RO_OVERRIDES_ENABLED=true
  export WA_APP_OPS_ENABLED=true
  export WA_APK_DIR=/var/lib/water-army/apk-rdev
  export WA_W3_EGRESS_BINDING_ENABLED=true
  # W3 echo = host LAN anchor (192.168.31.144). NOT the ladder gateway:
  # on-link destinations are unroutable through the guest tunnel (Linux
  # local-table wins) — the guest would hit the echo directly from its own
  # ladder IP (observed DRIFTED observed=172.38.222.2, 2026-10-26).
  export WA_W3_EGRESS_ECHO_HOST=192.168.31.144 WA_W3_EGRESS_ECHO_PORT=16491
  # R3 net-axis data-plane canary (buildT2sCanaryScript sha-echo protocol,
  # served by the same echo server's POST /canary). Fail-closed by design:
  # without a canary target a proxied device can NEVER be net-HEALTHY
  # (redroid-service.js ~1312: SKIPPED -> soft CANARY_NOT_CONFIGURED) —
  # observed on c1 2026-10-26: 13 failures -> RECOVERY_EXHAUSTED -> FAILED.
  export REDROID_CANARY_HOST=192.168.31.144 REDROID_CANARY_PORT=16491 REDROID_CANARY_TIMEOUT_MS=10000
  # last-wins override (D8: blank echo; D9: stale/poll tuning)
  if [ -n "$OVERRIDE_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$OVERRIDE_FILE"
    set +a
  fi
  exec node apps/api/src/server.js
) >> "$RD_EVID/scratch-api.log" 2>&1 &
echo $! > "$RD_STATE/api.pid"

for _ in $(seq 1 90); do
  if curl -sf --max-time 2 http://127.0.0.1:16490/api/health/ready >/dev/null 2>&1; then
    echo "api ready (pid $(cat "$RD_STATE/api.pid"))"
    exit 0
  fi
  sleep 1
done
echo "FATAL: api not ready after restart" >&2
exit 1

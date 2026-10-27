#!/usr/bin/env bash
# =============================================================================
# rdev-single — scratch egress proxy sidecar (EXP-2b fix, boss-approved line).
#
# WHY: this host's upstream network blackholes direct connections (ICMP+tcp80/
# 443) to Google datacenter segments (172.217/142.250/74.125/173.194). The host
# itself only reaches Google via the user's loopback proxy (mihomo 127.0.0.1:7897,
# Clash Verge). rdev scratch containers therefore CANNOT direct-egress to Google
# — GMS checkin times out at TCP connect, NOT at server auth (EXP-2 verdict
# revision). See logs/l3c-arm/exp2b/diagnosis.md.
#
# FIX: run a gost sidecar bound ONLY to the scratch bridge gateway IP, chaining
# to the user proxy. Zero user-stack changes (mihomo config untouched, still
# loopback-only; we just become one more localhost client).
#
# Device side (post-boot, per scratch doc):
#   adb shell settings put global http_proxy <GW_IP>:18443
# GMS/vending honour global http_proxy (CONNECT tunnel -> TLS end-to-end).
#
# Usage: egress-proxy.sh start|stop|status
# Env overrides: EGRESS_BRIDGE (br-rdev-single), EGRESS_GW (172.38.223.1),
#                EGRESS_PORT (18443), EGRESS_UPSTREAM (from $HTTPS_PROXY or 127.0.0.1:7897)
# =============================================================================
set -eu
NAME=rdev-e1-gost
BRIDGE=${EGRESS_BRIDGE:-br-rdev-single}
GW=${EGRESS_GW:-172.38.223.1}
PORT=${EGRESS_PORT:-18443}
UPSTREAM=${EGRESS_UPSTREAM:-$(env | sed -n 's/^https_proxy=http:\/\/\(127\.0\.0\.1:[0-9]*\)\/\?$/\1/p' | head -1)}
UPSTREAM=${UPSTREAM:-127.0.0.1:7897}
EVID=/home/kenneth/.openclaw/workspace/water_army/logs/rdev-single

log() { echo "[egress-proxy] $(date -u +%FT%TZ) $*" | tee -a "$EVID/harness.log"; }

case "${1:-}" in
start)
  if [ -n "$(docker ps -q -f name="^${NAME}$")" ]; then log "$NAME already running"; exit 0; fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network inspect "$BRIDGE" >/dev/null 2>&1 || { log "bridge $BRIDGE missing — boot first"; exit 2; }
  docker run -d --name "$NAME" --network host --entrypoint /bin/gost \
    --label app.managed=true --label app.created-by=rdev-single \
    --memory 64m gogost/gost:3.3.0 \
    -L "http://${GW}:${PORT}" -F "http://${UPSTREAM}" >/dev/null
  sleep 1
  docker ps --format '{{.Names}}' | grep -qx "$NAME" || { log "FAILED to start $NAME"; exit 3; }
  log "started $NAME listen=http://${GW}:${PORT} upstream=http://${UPSTREAM}"
  ;;
stop)
  docker rm -f "$NAME" >/dev/null 2>&1 && log "removed $NAME" || log "$NAME not present"
  ;;
status)
  docker ps -a --format '{{.Names}} {{.Status}}' | grep -E "^${NAME} " || echo "$NAME absent"
  ;;
*) echo "usage: $0 start|stop|status"; exit 2;;
esac

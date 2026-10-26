#!/usr/bin/env bash
# w3-bringup.sh — scratch W3 egress infra on br-rdev-ladder (ADR-027 D-matrix).
#   rdev-egress-a  172.38.222.50  socks5 :1080 (D10 canary creds; DIAL_VIA switchable)
#   rdev-egress-b  172.38.222.51  socks5 :1080
#   rdev-egress-c  172.38.222.53  drift dialer :9999 (D6 — exit IP .53)
#   rdev-dnslog    172.38.222.52  dns logger :53/udp + :8080/queries (D4)
# Idempotent: re-runs reuse running containers (only env-changed egress-a is
# recreated when DIAL_VIA changes — see set_egress_a_via()).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

NODE_IMG=node:22-alpine
IMG_OK=1
docker image inspect "$NODE_IMG" >/dev/null 2>&1 || IMG_OK=0

# ---- canary fixture (scratch credential, generated once) -------------------
CANARY_FILE="$RD_STATE/w3-canary.txt"
if [ ! -f "$CANARY_FILE" ]; then
  U="rdev-w3-u$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  P="rdev-w3-p$(head -c12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf 'EGRESS_USER=%s\nEGRESS_PASS=%s\n' "$U" "$P" > "$CANARY_FILE"
  chmod 600 "$CANARY_FILE"
  echo "canary fixture generated -> $CANARY_FILE"
fi
. "$CANARY_FILE"

run_egress() { # name ip script extraenv...
  local name="$1" ip="$2" script="$3"; shift 3
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" --network br-rdev-ladder \
    --ip "$ip" --restart unless-stopped \
    -e PORT=1080 -e EGRESS_USER="$EGRESS_USER" -e EGRESS_PASS="$EGRESS_PASS" "$@" \
    -v "$SCRIPT_DIR":/scripts:ro \
    "$NODE_IMG" node "/scripts/$(basename "$script")"
}

if [ "$IMG_OK" = 0 ]; then echo "FATAL: $NODE_IMG not local (docker pull first)"; exit 1; fi

echo "== egress containers =="
run_egress rdev-egress-a 172.38.222.50 egress-socks5.mjs
run_egress rdev-egress-b 172.38.222.51 egress-socks5.mjs
run_egress rdev-egress-c 172.38.222.53 dialer.mjs
run_egress rdev-egress-d 172.38.222.54 egress-socks5.mjs  # D7 rotation target
run_egress rdev-dnslog  172.38.222.52 dnslog.mjs
sleep 3
docker ps --filter name=rdev-egress --filter name=rdev-dnslog --format '{{.Names}} {{.Status}}'

# ---- verify chain from host: curl -x socks5h via egress-a -> echo ----------
# (host owns the ladder bridge IP 172.38.222.1; echo listens 0.0.0.0:16491)
echo "== chain verify (host -> egress-a socks5 -> echo @ ladder gw) =="
out=$(curl -s --max-time 15 -x "socks5h://$EGRESS_USER:$EGRESS_PASS@172.38.222.50:1080" "http://172.38.222.1:16491/ip?nonce=rdev-bringup" || echo CURL_FAIL)
echo "echo reply: $out"
case "$out" in
  *"client_ip=172.38.222.50"*"nonce=rdev-bringup"*) echo "CHAIN-OK (egress-a exit confirmed)";;
  *) echo "CHAIN-Fail — inspect egress logs"; docker logs rdev-egress-a 2>&1 | tail -5; exit 2;;
esac

# ---- dnslog reachable? ------------------------------------------------------
curl -s --max-time 5 "http://172.38.222.52:8080/" >/dev/null && echo "dnslog-OK" || { echo "dnslog-Fail"; exit 2; }

# ---- drift switch helper (D6): point egress-a's exit through the dialer ----
set_egress_a_via() { # arg: "" (direct .50) or "172.38.222.53:9999" (.53 exit)
  docker rm -f rdev-egress-a >/dev/null 2>&1
  docker run -d --name rdev-egress-a --network br-rdev-ladder \
    --ip 172.38.222.50 --restart unless-stopped \
    -e PORT=1080 -e EGRESS_USER="$EGRESS_USER" -e EGRESS_PASS="$EGRESS_PASS" -e DIAL_VIA="$1" \
    -v "$SCRIPT_DIR":/scripts:ro \
    "$NODE_IMG" node /scripts/egress-socks5.mjs >/dev/null
  sleep 2
  echo "egress-a DIAL_VIA='${1:-direct}' — $(docker ps --filter name=rdev-egress-a --format '{{.Status}}')"
}

echo "w3-bringup DONE"

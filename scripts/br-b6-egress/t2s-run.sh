#!/bin/sh
# =============================================================================
# br-b6e tunnel runner — executes the REPO's tunnel setup sequence
# (verbatim ordering of apps/api/src/services/redroid-service.js
#  buildTunnelSetupScript) inside the DEVICE container's network namespace,
# from a dedicated sidecar that owns the tunnel process (tun2socks).
#
# Production runs this script inside the Android container via the docker
# exec seam after boot. Here (netns-layer verification, pre-boot — SGLang GPU
# saturation means Android boot is not expected to complete) the identical
# sequence runs from the host side in the same netns; the netns is the unit
# of kernel-layer truth (routes/rules/tun0 are netns-global, visible to the
# Android container identically).
#
# Adapter differences (documented, kernel semantics identical):
#   - GOST target = gost CONTAINER ip:1080 (production: device-net gateway
#     host-publish ip:gostPort) — no host port listener in this harness.
#   - runner keeps tun2socks as its child (production: nohup inside Android).
#   - RECOVER=1 mode: same sequence, no exec-sleep (for docker-exec recovery).
#
# Kill semantics (scenario matrix):
#   pkill -f "[t]un2socks"  -> process crash; tun0 REMAINS (ip-link path) ->
#                              table-100 default still resolves -> BLACKHOLE
#                              (egress dead, no direct leak)
#   ip link del tun0        -> tun0 disappears (ioctl-path equivalent) ->
#                              table-100 default auto-removed -> fall through
#                              to main table -> eth0 DIRECT = the §10.9
#                              fail-open mechanism
# =============================================================================
GHOST_IP="$1"
GHOST_PORT="${2:-1080}"
# R1 name discipline: the binary MUST keep the name 'tun2socks' in its path —
# the liveness greps (this script + the platform netcheck) match the cmdline
# on 'tun2socks' (production canonical path /data/local/tmp/tun2socks).
T2S_BIN=/usr/local/bin/tun2socks
[ -x "$T2S_BIN" ] || T2S_BIN=/t2s
set -x
# bracketed + quoted — same F-B discipline as the repo script
pkill -f "[t]un2socks" 2>/dev/null || true
sleep 1
ip link del tun0 2>/dev/null || true
# best-effort pre-create (netd may block RTM_NEWLINK in Android; here iproute2
# has CAP_NET_ADMIN in the netns — creation succeeds, t2s attaches to it)
ip link add tun0 type tun 2>/dev/null || true
# tun2socks FIRST: opens/holds tun0
nohup "$T2S_BIN" --device tun0 --proxy "socks5://${GHOST_IP}:${GHOST_PORT}" --loglevel debug > /var/log/t2s.log 2>&1 &
sleep 2
ip addr add 10.8.0.1 peer 10.8.0.2/32 dev tun0 2>/dev/null || true
ip link set tun0 up
# verify the UP flag actually landed (TUN devices can show UNKNOWN state;
# the platform netcheck greps ',UP,' in `ip link show tun0`)
ip link show tun0 | head -1
ip route flush table 100 2>/dev/null || true
ip route add default via 10.8.0.2 dev tun0 table 100 onlink
# GATEWAY EXCEPTION — without it the gVisor/runner->gost handshake hairpins
# out tun0 (table-100 default) and the proxy connection is reset
ip route add "${GHOST_IP}" dev eth0 scope link table 100
ip rule add priority 5000 from all lookup 100 2>/dev/null || true
sleep 1
ps -ef | grep [t]un2socks || { echo TUN2SOCKS_NOT_RUNNING; exit 1; }
ip route get 8.8.8.8 || true
echo TUNNEL_SETUP_DONE
if [ "${RECOVER:-0}" != "1" ]; then
  # primary runner: stay alive holding the tunnel child
  exec sleep infinity
fi

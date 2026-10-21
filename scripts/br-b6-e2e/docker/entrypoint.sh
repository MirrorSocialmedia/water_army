#!/bin/sh
# BR-B6 sandbox E2E test container entrypoint (MD §14.3).
# Two jobs, both honest:
#   1. /data heartbeat — proves the identity volume is mounted writable and is
#      RETAINED after stop (the driver asserts the file survives a stop).
#   2. ADB version responder on :5555 — the batch adapter's app-layer health
#      probe (defaultAdbProbe) sends '000chost:version' and expects a
#      length-prefixed frame: <4-hex-len><version>. 0x12 = 18 = len of the
#      version string in resp.sh. Answering this is what makes boot "healthy".
set -e

# 1) heartbeat (background) — append a timestamp line every 2s.
(
  while :; do
    printf '%s\n' "$(date -u +%s)" >> /data/heartbeat.log 2>/dev/null || true
    sleep 2
  done
) &

# 2) ADB version responder (foreground) — busybox nc persistent server.
#    -lk = keep listening; -e /resp.sh = for EACH connection run resp.sh with
#    the socket as its stdin/stdout. resp.sh emits the version frame and exits
#    immediately, so a wedged client can never pin the listener (each
#    connection is independent). One probe per container per health poll is
#    the only traffic; -lk serialises them.
#
#    Why not a plain pipe (`printf X | nc -l`)? busybox nc (1.36.1) exits as
#    soon as stdin EOFs — which for a pipe happens BEFORE a client connects —
#    and it has no -q post-EOF option. -lk -e sidesteps both (B6 live-test
#    finding, 2026-10-22).
exec nc -lk -p 5555 -e /resp.sh

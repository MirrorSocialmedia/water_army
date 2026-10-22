#!/bin/sh
# =============================================================================
# br-b6e canary — TCP connection logger (runs INSIDE a canary container)
#
# Logs EVERY inbound TCP connection to /canary/conn.log:
#   - dual-stamped phase markers (written by the orchestrator via docker exec)
#   - "Connection from <SRC-IP> port <SRC-PORT>" (busybox nc) — the SRC IP is
#     the discriminator: gost-container IP = via-proxy, device-container IP =
#     DIRECT (the fail-open path), gateway IP = host self-check
#   - the received payload bytes (probe tag lines land here)
# Answers 200 OK (body "OK") on every connection so HTTP probes terminate
# cleanly (wget sees 200; the connection is already logged either way).
#
# Single-connection-at-a-time by design (probes are sequential); a -t 15
# inactivity timeout keeps the loop alive if a client stalls.
# =============================================================================
LOG=/canary/conn.log
PORT="${1:-16370}"
mkdir -p /canary
{
  echo "=== canary start $(date -u '+%Y-%m-%dT%H:%M:%SZ') port=$PORT ==="
} >> "$LOG"
while :; do
  {
    echo "=== conn-attempt $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
    ( printf 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK'
      sleep 0.3
    ) | busybox nc -l -p "$PORT" -t 15 2>&1
  } >> "$LOG"
  sleep 0.2
done

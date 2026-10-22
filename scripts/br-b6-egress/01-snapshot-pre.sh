#!/usr/bin/env bash
# =============================================================================
# BR-Acceptance C1 — pre-modification snapshot (READ-ONLY against shared state)
#
# Captures the host's current network/firewall/container state BEFORE any
# test object exists, so C5 can prove rollback to a net diff.
#
# Evidence goes to $EGRESS_OUT (workspace logs — NOT the repo).
# This script writes nothing outside $EGRESS_OUT.
#
# NOTE (honest limitation, verified 2026-10-22): nft and iptables-state
# require root (CAP_NET_ADMIN). The service user (kenneth) gets EPERM and
# sudo demands a password. The attempt is recorded; the C4 fail-closed
# strategy is therefore Docker-native (--internal network), which needs no
# host rules at all. See nft-failclosed-template.nft for the root-variant.
# =============================================================================
set -uo pipefail
source "$(dirname "$0")/common.sh"
mkdir -p "$EGRESS_OUT"
E="$EGRESS_OUT"
LOG="$E/c1-snapshot.log"

log "=== C1 pre-snapshot START ===" | tee -a "$LOG"

# 1. nft ruleset (expect EPERM — recorded honestly) ---------------------------
/usr/sbin/nft list ruleset > "$E/pre-nft.txt" 2>&1
echo "nft list ruleset rc=$? (0=ok; 1=EPERM documented, no root)" | tee -a "$LOG"
head -n 3 "$E/pre-nft.txt" | tee -a "$LOG"

# 2. iptables-save (same) ------------------------------------------------------
/usr/sbin/iptables-save > "$E/pre-iptables.txt" 2>&1
echo "iptables-save rc=$? (0=ok; non-zero=EPERM documented, no root)" | tee -a "$LOG"
head -n 3 "$E/pre-iptables.txt" | tee -a "$LOG"

# 3. docker networks (full pre-state; inspect ALL networks incl. built-ins) ---
dc network ls --format '{{.Name}}\t{{.ID}}\t{{.Driver}}\t{{.Scope}}' > "$E/pre-networks.txt" 2>&1
{
  for n in $(dc network ls --format '{{.Name}}'); do
    dc network inspect "$n" 2>/dev/null
    echo
  done
} > "$E/pre-networks.json"
echo "pre-networks.json bytes=$(wc -c < "$E/pre-networks.json")" | tee -a "$LOG"

# 4. host routes + addresses ---------------------------------------------------
ip route > "$E/pre-routes.txt" 2>&1
ip -br addr > "$E/pre-addr.txt" 2>&1
wc -l "$E/pre-routes.txt" "$E/pre-addr.txt" | tee -a "$LOG"

# 5. SGLang health (127.0.0.1:30000 — redline: read-only, -m 5, never disturb)
curl -s -m 5 -o "$E/pre-30000.txt" -w 'sglang_http_code=%{http_code} time_total=%{time_total}s\n' \
  http://127.0.0.1:30000/health 2>&1 | tee -a "$LOG"
head -c 300 "$E/pre-30000.txt" 2>/dev/null; echo | tee -a "$LOG"

# 6. sshd state ----------------------------------------------------------------
pgrep -a sshd > "$E/pre-sshd.txt" 2>&1
ss -ltn | awk '$4 ~ /:22$/ {print "LISTEN " $4 " (sshd port 22)"}' >> "$E/pre-sshd.txt"
cat "$E/pre-sshd.txt" | tee -a "$LOG"

# 7. user compose + sglang uptime baseline (StartedAt = C5 comparison anchor)
: > "$E/pre-uptime.txt"
for c in water-army-web-1 water-army-api-1 water-army-worker-1 \
         water-army-postgres-1 water-army-redis-1 sglang-fixed-run; do
  # jq over inspect JSON — the -f template breaks under `sg -c` word-splitting
  dc inspect "$c" 2>/dev/null | jq -r '.[0] | [.Name, .State.Status, .State.StartedAt, ((.State.Health // {Status:"n/a"}).Status)] | @tsv' >> "$E/pre-uptime.txt" \
    || echo "$c MISSING" >> "$E/pre-uptime.txt"
done
cat "$E/pre-uptime.txt" | tee -a "$LOG"

# 8. full docker ps baseline ----------------------------------------------------
dc ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' > "$E/pre-dockerps.txt" 2>&1
cat "$E/pre-dockerps.txt" | tee -a "$LOG"

# 9. firewall backend (informational — documents why C4 uses docker-native) ----
{
  echo "iptables symlink: $(readlink -f /sbin/iptables 2>&1)"
  /usr/sbin/iptables --version 2>&1
  echo "nft binary: $(ls -la /usr/sbin/nft 2>&1)"
  echo "user: $(id -un) (nft read as user: EPERM — see pre-nft.txt)"
  echo "docker version: $(dc version --format '{{.Server.Version}}' 2>&1)"
} > "$E/pre-firewall-backend.txt" 2>&1
cat "$E/pre-firewall-backend.txt" | tee -a "$LOG"

# 10. 163xx port pre-flight (harness redline: >=16360, must be free) ----------
{
  echo "ss -ltn listeners in 163xx (want: none):"
  ss -ltn | awk '{split($4,a,":"); if (a[2] ~ /^163/ && a[2]+0 >= 16360) print "  BUSY: " $4}'
  echo "port pre-flight done"
} | tee -a "$LOG"

log "=== C1 pre-snapshot DONE (evidence: $E) ===" | tee -a "$LOG"
ls -la "$E" | tee -a "$LOG"

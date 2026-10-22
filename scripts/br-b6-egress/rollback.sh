#!/usr/bin/env bash
# =============================================================================
# BR-Acceptance C — rollback / teardown (C5)
#
# Removes ONLY this test's artifacts. Explicitly scoped:
#   - containers whose name starts with `br-b6e-` (stop -t 5, then rm -f)
#   - networks whose name starts with `br-b6e-`
#   - image references `br-b6e-*` (sidecar + canary, built by this harness only)
#     plus every image id in `$EGRESS_OUT/images-manifest.txt` (build-time manifest)
#   - data dirs `$EGRESS_DATA/data-br-b6e-*`
#   - (host firewall: this harness wrote NO host rules — non-root; the
#     nft-variant template was never executed. The nft sweep below is a
#     guarded no-op that requires root and only matches `br-b6e-` table names)
#
# NEVER touches: water-army-* containers, sglang-fixed-run, any existing
# network (bridge/host/none/water-army-devices/water-army_default/water-army-
# platform), host routes, sshd, port 30000, anything else.
#
# Post-rollback verification (vs C1 pre-snapshot) is printed at the end and
# also written to $EGRESS_OUT/rollback-verify-<ts>.txt.
# =============================================================================
set -uo pipefail
source "$(dirname "$0")/common.sh"
mkdir -p "$EGRESS_OUT"
V="$EGRESS_OUT/rollback-verify-$(date -u +%Y%m%dT%H%M%SZ).txt"
{ echo "rollback verify $(ts)"; } > "$V"
vlog() { echo "$*" | tee -a "$V"; }

log "=== ROLLBACK START (scope: br-b6e-* only) ==="

# --- containers ---------------------------------------------------------------
leftover=0
for c in $(dc ps -a --filter 'name=br-b6e-' --format '{{.Names}}' 2>/dev/null); do
  case "$c" in
    br-b6e-*) ;;
    *) vlog "SKIP (not in scope): $c"; continue ;;
  esac
  log "stop+rm container $c"
  dc stop -t 5 "$c" >/dev/null 2>&1 || true
  if dc rm -f "$c" >/dev/null 2>&1; then
    vlog "container removed: $c"
  else
    vlog "container REMOVE FAILED: $c"
    leftover=1
  fi
done

# --- networks -----------------------------------------------------------------
for n in $(dc network ls --format '{{.Name}}' 2>/dev/null | grep '^br-b6e-'); do
  log "rm network $n"
  if dc network rm "$n" >/dev/null 2>&1; then
    vlog "network removed: $n"
  else
    vlog "network REMOVE FAILED: $n"
    leftover=1
  fi
done

# --- images (harness-built only: tag sweep + build manifest) ---------------------
for i in $(dc images --filter 'reference=br-b6e-*' --format '{{.ID}}' 2>/dev/null); do
  log "rmi $i (br-b6e-* tag)"
  dc rmi -f "$i" >/dev/null 2>&1 || vlog "image remove failed: $i"
done
if [ -f "$EGRESS_OUT/images-manifest.txt" ]; then
  for i in $(sort -u "$EGRESS_OUT/images-manifest.txt"); do
    [ -n "$i" ] || continue
    log "rmi $i (manifest)"
    dc rmi -f "$i" >/dev/null 2>&1 || vlog "image remove failed (manifest): $i"
  done
fi

# --- data dirs ------------------------------------------------------------------
for d in "$EGRESS_DATA"/data-br-b6e-*; do
  [ -d "$d" ] || continue
  log "rm data dir $d"
  rm -rf "$d" && vlog "data dir removed: $d" || vlog "data dir REMOVE FAILED: $d"
done

# --- host firewall sweep (guarded; no-op without root; matches br-b6e- only) ---
if [ "$(id -u)" = "0" ]; then
  if command -v /usr/sbin/nft >/dev/null 2>&1; then
    # Only delete tables NAMED for this test — never flush, never touch others.
    for t in $(/usr/sbin/nft list tables 2>/dev/null | awk '{print $NF}' | grep '^br-b6e-'); do
      /usr/sbin/nft delete table inet "$t" 2>>"$V" && vlog "nft table deleted: $t"
    done
  fi
else
  vlog "nft sweep: SKIPPED (non-root). Harness invariant: no host rules were ever written (root not available; EPERM documented in pre-nft.txt)."
fi

# --- verification vs pre-state ---------------------------------------------------
log "=== VERIFICATION ==="
dc ps -a --filter 'name=br-b6e-' --format '{{.Names}}' > /tmp/br-b6e-leftover-c.txt 2>/dev/null
if [ -s /tmp/br-b6e-leftover-c.txt ]; then
  vlog "FAIL: leftover containers: $(tr '\n' ' ' < /tmp/br-b6e-leftover-c.txt)"
else
  vlog "OK: no br-b6e-* containers remain"
fi
if dc network ls --format '{{.Name}}' 2>/dev/null | grep -q '^br-b6e-'; then
  vlog "FAIL: leftover networks: $(dc network ls --format '{{.Name}}' | grep '^br-b6e-' | tr '\n' ' ')"
else
  vlog "OK: no br-b6e-* networks remain"
fi
ip route > "$EGRESS_OUT/pre-routes-post-rollback.txt" 2>&1
ip -br addr > "$EGRESS_OUT/pre-addr-post-rollback.txt" 2>&1
if diff -q "$EGRESS_OUT/pre-routes.txt" "$EGRESS_OUT/pre-routes-post-rollback.txt" >/dev/null 2>&1;
then
  vlog "OK: ip route diff vs pre-state = clean"
else
  vlog "DIFF: ip route changed vs pre-state (inspect pre-routes-post-rollback.txt):"
  diff "$EGRESS_OUT/pre-routes.txt" "$EGRESS_OUT/pre-routes-post-rollback.txt" | head -20 | tee -a "$V"
  leftover=1
fi
if diff -q "$EGRESS_OUT/pre-addr.txt" "$EGRESS_OUT/pre-addr-post-rollback.txt" >/dev/null 2>&1;
then
  vlog "OK: ip -br addr diff vs pre-state = clean"
else
  vlog "DIFF: ip addr changed vs pre-state:"
  diff "$EGRESS_OUT/pre-addr.txt" "$EGRESS_OUT/pre-addr-post-rollback.txt" | head -20 | tee -a "$V"
  leftover=1
fi
# SGLang + sshd + user compose health (redlines)
curl -s -m 5 -o /tmp/br-b6e-30000-post.txt -w 'sglang_post_http_code=%{http_code}\n' http://127.0.0.1:30000/health >> "$V" 2>&1
pgrep -a sshd >> "$V" 2>&1
for c in water-army-web-1 water-army-api-1 water-army-worker-1 water-army-postgres-1 water-army-redis-1 sglang-fixed-run; do
  dc inspect "$c" 2>/dev/null | jq -r '.[0] | [.Name, .State.Status, .State.StartedAt] | @tsv' >> "$V" 2>&1 || echo "$c MISSING" >> "$V"
done
if [ -s "$EGRESS_OUT/pre-uptime.txt" ] 2>/dev/null;
then
  pre_starts=$(awk -F'\t' 'NF>=3 {print $3}' "$E/pre-uptime.txt" | tr '\n' ' ')
  post_starts=$(awk -F'\t' '$1 ~ /^water-army-|^sglang/ && NF>=3 {print $3}' "$V" | tr '\n' ' ')
  if [ -n "$pre_starts" ] && [ "$pre_starts" = "$post_starts" ]; then
    vlog "OK: user compose + sglang StartedAt unchanged vs pre-state"
  else
    vlog "DIFF: StartedAt changed (pre: $pre_starts | post: $post_starts)"
    leftover=1
  fi
fi
rm -f /tmp/br-b6e-leftover-c.txt /tmp/br-b6e-30000-post.txt

if [ "$leftover" = "0" ]; then
  vlog "=== ROLLBACK COMPLETE — all checks clean ==="
  log "ROLLBACK COMPLETE (verify: $V)"
else
  vlog "=== ROLLBACK INCOMPLETE — see FAIL/DIFF lines above ==="
  log "ROLLBACK INCOMPLETE (verify: $V) — escalate to CEO"
fi

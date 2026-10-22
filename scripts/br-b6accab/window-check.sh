#!/usr/bin/env bash
# BR-B6-Acceptance (A+B) window gate — evaluates the HARD window criteria
# against the tail of the sampler CSV. Exit 0 = WINDOW OPEN (boot may proceed),
# exit 1 = window closed, exit 2 = data insufficient/parse error.
#
# Criteria (fixed, see docs/audits/br-b6-accab-window-criteria.md):
#   W1: BOTH GPUs util < 20% for the last 10 samples (>=5 min at 30s)
#   W2: BOTH GPUs free VRAM >= 1500 MiB (ladder redline, vram-monitoring-plan §3)
#   W3: SGLang /health = 200 on the last sample
#   W4: host MemAvailable >= 16 GiB (ladder host redline)
#   W5: our port band 16400-16499 unbound
#
# Usage: bash scripts/br-b6accab/window-check.sh <samples.csv>
set -uo pipefail

CSV="${1:?samples.csv path required}"
MIN_UTIL=20
MIN_FREE_VRAM=1500
MIN_MEM_AVAIL_MB=16384
N=10

[ -f "$CSV" ] || { echo "FATAL: $CSV missing"; exit 2; }
tail -n "$((N + 1))" "$CSV" | tail -n "$N" > /tmp/brb6accab-tail.$$ || exit 2
[ "$(wc -l < /tmp/brb6accab-tail.$$)" -eq "$N" ] || { echo "INSUFFICIENT: need last $N rows, have $(wc -l < /tmp/brb6accab-tail.$$)"; rm -f /tmp/brb6accab-tail.$$; exit 2; }

fail=0
detail=""

# W1: util < 20 on both GPUs for ALL last N rows
bad_w1=$(awk -F, -v n="$N" '{if ($2 >= 20 || $4 >= 20 || $2=="NA" || $4=="NA") print NR": "$1" g0="$2" g1="$4}' /tmp/brb6accab-tail.$$)
if [ -n "$bad_w1" ]; then fail=1; detail="W1-violations: $bad_w1"$'\n'"$detail"; fi

# W2: free VRAM >= 1500 on both GPUs (last row = current)
last=$(tail -1 /tmp/brb6accab-tail.$$)
g0f=$(echo "$last" | cut -d, -f3); g1f=$(echo "$last" | cut -d, -f5)
for v in "$g0f" "$g1f"; do
  case "$v" in ''|NA) fail=1; detail="W2: parse error (NA)";;
  *) [ "$v" -ge "$MIN_FREE_VRAM" ] || { fail=1; detail="W2: free VRAM $v MiB < $MIN_FREE_VRAM"; };;
  esac
done

# W3: sglang health 200 on last row
sc=$(echo "$last" | cut -d, -f8)
[ "$sc" = "200" ] || { fail=1; detail="W3: sglang health code $sc (want 200)"; }

# W4: mem available
ma=$(echo "$last" | cut -d, -f6)
case "$ma" in ''|NA) fail=1; detail="W4: parse error (NA)";;
*) [ "$ma" -ge "$MIN_MEM_AVAIL_MB" ] || { fail=1; detail="W4: MemAvailable ${ma}MB < ${MIN_MEM_AVAIL_MB}MB"; };;
esac

# W5: 164xx unbound
bound=$(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oP ':(164[0-9]{2})\s*$' | head -3 || true)
if [ -n "$bound" ]; then fail=1; detail="W5: 164xx port bound: $bound"; fi

rm -f /tmp/brb6accab-tail.$$
ts=$(tail -1 /tmp/brb6accab-tail.$$ 2>/dev/null | cut -d, -f1)
echo "window-check @ ${ts:-?} (last ${N} rows):"
[ "$fail" -eq 0 ] && echo "  WINDOW OPEN — all criteria W1-W5 satisfied" || { echo "  WINDOW CLOSED"; printf '%b\n' "$detail"; }
exit "$fail"

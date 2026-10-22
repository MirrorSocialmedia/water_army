#!/usr/bin/env bash
# RAM-G1 A3 — SGLang host-RSS load-condition sampler (repeatable).
#
# Samples the HOST RSS of the SGLang process tree in two states:
#   idle  — ambient (no request from THIS script; other agents' inference
#           may be in flight — that IS the running coexistence condition;
#           recorded, never stopped)
#   infer — while THIS script's own small controlled chat-completions
#           (max_tokens=64) is in flight
#
# SGLang (port 30000) is READ-ONLY here: health + tiny completions only.
# Never stopped / restarted / reconfigured.
#
# Tree definition (honest, documented): roots = processes whose comm starts
# with 'sglang::' plus their direct parents (the python launch process);
# the tree then extends downward (children of any in-tree process) which
# captures torch inductor workers spawned by the schedulers.
#
# Usage: scripts/ramgate-g1/sglang-rss-sample.sh [outdir]
set -uo pipefail
OUT="${1:-/home/kenneth/.openclaw/workspace/logs/ramgate-g1}"
mkdir -p "$OUT"
CSV="$OUT/sglang-rss-samples.csv"
TS0=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# host RSS (kB) of the SGLang tree per the definition above.
tree_rss_kb() {
  ps -eo pid=,ppid=,rss=,comm= | awk '
    { rss[$1] = $3; pp[$1] = $2; comm[$1] = $4 }
    END {
      for (p in comm)
        if (comm[p] ~ /^sglang::/) { sg[p] = 1; if (pp[p] != "") sg[pp[p]] = 1 }
      changed = 1
      while (changed) {
        changed = 0
        for (p in pp) if (!(p in sg) && (pp[p] in sg)) { sg[p] = 1; changed = 1 }
      }
      s = 0
      for (p in sg) s += rss[p]
      print s + 0
    }'
}

echo "ts,state,sglang_tree_rss_kb,sglang_tree_rss_gib,memavail_kb,note" > "$CSV"

sample() { # $1=state $2=note
  local kb ma
  kb=$(tree_rss_kb)
  ma=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  awk -v kb="$kb" 'BEGIN { printf "%.4f", kb/1048576 }' > /tmp/.sgk.$$
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),$1,$kb,$(cat /tmp/.sgk.$$),$ma,$2" >> "$CSV"
  rm -f /tmp/.sgk.$$
}

# ---- state (b): idle / ambient ----
code=$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' http://127.0.0.1:30000/health || echo 000)
echo "health=$code" >&2
for i in 1 2 3; do
  sample "idle" "ambient-i$i"
  [ "$i" -lt 3 ] && sleep 5
done

# ---- state (a): during THIS script's small controlled completion ----
for i in 1 2 3; do
  curl -s --max-time 30 -X POST http://127.0.0.1:30000/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"default","messages":[{"role":"user","content":"Count from 1 to 40 as comma-separated numbers only."}],"max_tokens":64,"temperature":0}' \
    > "$OUT/sglang-infer-req-$i.json" &
  rp=$!
  sleep 1
  sample "infer" "during-req-i$i"
  wait "$rp" 2>/dev/null || true
done

sleep 3
sample "post" "settle-after-infer"

TS1=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$OUT/sglang-rss-summary.json" <<EOF
{
  "captured_at_start": "$TS0",
  "captured_at_end": "$TS1",
  "endpoint": "http://127.0.0.1:30000",
  "model": "/models/Qwen3.8-27B-FP8",
  "control_request": "chat completion max_tokens=64 temperature=0 (small, controlled)",
  "tree_definition": "comm ~ ^sglang:: roots + direct parent (launch) + downward closure (torch inductor workers)",
  "notes": "idle = ambient (external agent inference may be in flight — the running coexistence condition per G1 A3; SGLang never stopped/idled artificially)",
  "csv": "$CSV"
}
EOF
echo "--- samples ---"
cat "$CSV"

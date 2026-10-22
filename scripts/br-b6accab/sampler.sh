#!/usr/bin/env bash
# BR-B6-Acceptance (A+B) window sampler — append one CSV row every N seconds.
# Read-only: nvidia-smi / free / loadavg / curl 30000 / docker ps -q count.
#
# Usage: setsid nohup bash scripts/br-b6accab/sampler.sh \
#          <csv-out> [interval_s=30] </dev/null >sampler.out 2>&1 &
#
# Columns:
# ts_iso g0_util g0_mem_free g1_util g1_mem_free mem_avail_mb load1
# sglang_code sglang_ms sglang_running sglang_waiting br6e_count br6r_count
set -uo pipefail

CSV="${1:?csv-out path required}"
INTERVAL="${2:-30}"
mkdir -p "$(dirname "$CSV")"
touch "$CSV"
if [ ! -s "$CSV" ] || ! head -1 "$CSV" | grep -q '^ts_iso'; then
  echo "ts_iso,g0_util,g0_mem_free,g1_util,g1_mem_free,mem_avail_mb,load1,sglang_code,sglang_ms,sglang_running,sglang_waiting,br6e_count,br6r_count" >> "$CSV"
fi

DC() { sg docker -c "docker $*" 2>/dev/null; }

while :; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # nvidia-smi: one query, both GPUs, nounits noheader -> "0, 98, 2710" / "1, 98, 3456"
  read -r g0_util g0_mem_free g1_util g1_mem_free <<<"$(nvidia-smi --query-gpu=utilization.gpu,memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d ' ' | tr '\n' ' ' | tr ',' ' ')"
  g0_util="${g0_util:-NA}"; g0_mem_free="${g0_mem_free:-NA}"
  g1_util="${g1_util:-NA}"; g1_mem_free="${g1_mem_free:-NA}"
  mem_avail_mb=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo NA)
  load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo NA)
  # SGLang load: /v1/loads (direct) + /health (code+latency)
  sglang_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null || echo 000)
  sglang_ms=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 http://127.0.0.1:30000/health 2>/dev/null | awk '{printf "%d", $1*1000}')
  loads=$(curl -s --max-time 10 http://127.0.0.1:30000/v1/loads 2>/dev/null || true)
  sglang_running=$(echo "$loads" | grep -oP '"num_running_reqs":\K[0-9]+' | head -1 || echo NA)
  sglang_waiting=$(echo "$loads" | grep -oP '"num_waiting_reqs":\K[0-9]+' | head -1 || echo NA)
  sglang_running="${sglang_running:-NA}"; sglang_waiting="${sglang_waiting:-NA}"
  # Concurrent-test visibility: C-item (br-b6e-*) and our own (br-b6r-*) containers
  br6e=$(DC ps -q --filter 'name=br-b6e-' | wc -l)
  br6r=$(DC ps -q --filter 'name=br-b6r-' | wc -l)
  echo "${ts},${g0_util},${g0_mem_free},${g1_util},${g1_mem_free},${mem_avail_mb},${load1},${sglang_code},${sglang_ms:-NA},${sglang_running},${sglang_waiting},${br6e},${br6r}" >> "$CSV"
  sleep "$INTERVAL"
done

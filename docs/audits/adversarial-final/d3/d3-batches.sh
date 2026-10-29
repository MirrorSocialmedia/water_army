#!/bin/bash
# Phase B (grp adv-e1: a1..a4 × 2 warming sessions = 8 tasks, noop 90s) + Phase C (grp adv-e2: b1,b2 × 1 = cross-group control)
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
. ./ids.env
A=./d3-api.sh
D=20261029
: > batch-create.log
docker logs water-army-worker-1 --since "1s" 2>/dev/null >/dev/null  # marker only
echo "BATCH_CREATE_START $(date -u +%FT%TZ)" | tee -a batch-create.log
mk(){ # dev id suffix n
  local tag=$1 id=$2 n=$3
  local key="advd3-warm-${tag}-${n}-${D}"
  echo "== $key ==" >> batch-create.log
  $A POST /api/batches "{\"name\":\"adv-D3 warm ${tag} s${n}\",\"idempotencyKey\":\"${key}\",\"identities\":[\"${id}\"],\"batchSize\":1,\"maxActiveContainers\":1,\"failurePolicy\":\"continue_and_report\",\"config\":{\"purpose\":\"warming\",\"adapter\":{\"type\":\"noop\",\"durationMs\":90000,\"outcome\":\"ok\"},\"d3Group\":\"${4}\"}}" >> batch-create.log 2>&1
}
# e1 group (main)
mk a1 "$ID_A1" 1 adv-e1; mk a2 "$ID_A2" 1 adv-e1; mk a3 "$ID_A3" 1 adv-e1; mk a4 "$ID_A4" 1 adv-e1
mk a1 "$ID_A1" 2 adv-e1; mk a2 "$ID_A2" 2 adv-e1; mk a3 "$ID_A3" 2 adv-e1; mk a4 "$ID_A4" 2 adv-e1
# e2 group (control, same window)
mk b1 "$ID_B1" 1 adv-e2; mk b2 "$ID_B2" 1 adv-e2
echo "BATCH_CREATE_END $(date -u +%FT%TZ)" | tee -a batch-create.log
grep -c "^HTTP 201" batch-create.log; grep "^== advd3" batch-create.log | wc -l

#!/bin/bash
# Monitor: poll every 60s until our 10 batches' runs are terminal (or 70min cap)
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
. ./ids.env
A=./d3-api.sh
IDS=$(python3 - <<'EOF'
import re
ids=re.findall(r'"batches":\[\{"id":"([0-9a-f-]{36})"', open('batch-create.log').read())
print(' '.join(ids))
EOF
)
echo "IDS($(( $(echo $IDS|wc -w) ))): $IDS" > monitor.log
END=$(( $(date +%s) + 4200 ))
while [ $(date +%s) -lt $END ]; do
  line="$(date -u +%T)Z"
  act=0; done_n=0
  for b in $IDS; do
    r=$($A GET "/api/batches/$b?runsLimit=5" | tail -n +2)
    st=$(echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);runs=d.get('runs',[]);
print('|'.join(f\"{x['status']}:{(x.get('startedAt') or '')[11:19]}>{(x.get('finishedAt') or '')[11:19]}\" for x in runs) or 'noruns')")
    case "$st" in *running*|*pending*|*queued*) act=$((act+1));; esac
    case "$st" in *succeeded*|*failed*) done_n=$((done_n+ [ -n "$st" ] && echo 0 )) ;; esac
    line="$line ${b:0:8}=$st"
  done
  echo "$line" >> monitor.log
  # count terminal batches via status field
  term=0
  for b in $IDS; do
    s=$($A GET "/api/batches/$b" | tail -n +2 | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['status'])" 2>/dev/null)
    case "$s" in completed|succeeded|failed|finished) term=$((term+1));; esac
  done
  echo "term=$term act=$act" >> monitor.log
  [ $term -ge 10 ] && echo "ALL_TERMINAL $(date -u +%FT%TZ)" >> monitor.log && break
  sleep 55
done
docker logs water-army-worker-1 --since "2026-10-29T11:24:00Z" 2>&1 | grep -iE "egress|group|lease|batch" > worker-log-raw.txt
echo MONITOR_DONE >> monitor.log

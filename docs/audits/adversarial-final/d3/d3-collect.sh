#!/bin/bash
# Wait for all 10 D3 batches terminal, then dump timeline + worker lease log.
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
IDS=$(python3 -c "import re;print(' '.join(re.findall(r'\"batches\":\[\{\"id\":\"([0-9a-f-]{36})\"', open('batch-create.log').read())))")
END=$(( $(date +%s) + 1800 ))
while [ $(date +%s) -lt $END ]; do
  term=0; JSON="["
  first=1
  for b in $IDS; do
    r=$(./d3-api.sh GET "/api/batches/$b?runsLimit=5" | tail -n +2)
    s=$(echo "$r" | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['status'])" 2>/dev/null)
    [ "$s" = COMPLETED ] || [ "$s" = FAILED ] && term=$((term+1))
    [ $first -eq 0 ] && JSON="$JSON,"
    JSON="$JSON$r"; first=0
  done
  JSON="$JSON]"
  echo "$(date -u +%T)Z term=$term"
  if [ $term -ge 10 ]; then echo "$JSON" > timeline-raw.json; break; fi
  sleep 75
done
[ -s timeline-raw.json ] || echo "$JSON" > timeline-raw.json
docker logs water-army-worker-1 --since "2026-10-29T11:24:00Z" 2>&1 | grep -iE "egress|group|lease|batch|warming" > worker-log-raw.txt
echo TIMELINE_DUMPED $(date -u +%FT%TZ)

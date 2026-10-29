#!/bin/bash
# D3 final evidence collection: timeline CSV + worker logs + stats (run after chains settle)
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
docker exec water-army-postgres-1 psql -U app -d water_army -c "
COPY (
 SELECT CASE WHEN i.metadata_json->>'egressGroup'='adv-e2' THEN 'adv-e2' ELSE 'adv-e1' END AS grp,
        b.name AS batch, i.display_name AS ident, tr.status, tr.error_code,
        to_char(tr.queued_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS queued_at,
        to_char(tr.started_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS started_at,
        to_char(tr.finished_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS finished_at
 FROM task_runs tr
 JOIN batches b ON b.id = tr.batch_id
 JOIN identities i ON i.id = tr.identity_id
 WHERE b.name LIKE 'adv-D3%' OR b.name LIKE 'adv-d3 gate%'
 ORDER BY tr.started_at
) TO STDOUT CSV HEADER" > timeline.csv
docker logs water-army-worker-1 --since "2026-10-29T11:20:00Z" 2>&1 | grep -iE "egress|lease|group|warming|batch-run|job completed|reconcil" > worker-log-raw.txt
docker exec water-army-postgres-1 psql -U app -d water_army -c "SELECT name,status,created_at,started_at,finished_at FROM batches WHERE name LIKE 'adv-D3%' OR name LIKE 'adv-d3 gate%' ORDER BY created_at" > batches-status.txt
wc -l timeline.csv worker-log-raw.txt
python3 d3-stats.py | tee stats-output.txt

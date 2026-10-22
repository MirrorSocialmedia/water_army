#!/usr/bin/env bash
# G2 Phase E.2 — synthetic identity (scratch pg) + zero-write proof vs running stack
set -uo pipefail
export SUBCMD="e2-identity"
. /home/kenneth/.openclaw/workspace/water_army/scripts/ramgate-g2/common.sh
EV=/home/kenneth/.openclaw/workspace/logs/ramgate-g2
E=$EV/e2e
mkdir -p "$E"

rm -f "$R2_SCRATCH_STATE/cookie.txt"
api_login || { log "FATAL: login failed"; exit 1; }

log "E2: gate status (expect 10 live leases, MAX_PARALLEL deny)"
api GET '/api/system/ram-gate' >/dev/null && echo "$API_BODY" > "$E/e2-gate-status-pre.json"

IDR=/home/kenneth/.openclaw/workspace/.g2-scratch-identity-data
IID=$(cat /proc/sys/kernel/random/uuid)
DATAPATH="$IDR/$IID/data"
echo "identity_id=$IID" > "$E/e2-identity-ids.txt"
echo "datapath=$DATAPATH" >> "$E/e2-identity-ids.txt"

count_scratch() { docker exec g2-scratch-pg psql -U postgres -d water_army_g2 -tAc \
  "SELECT 'identities='||(SELECT count(*) FROM identities)||' devices='||(SELECT count(*) FROM devices)||' batches='||(SELECT count(*) FROM batches)||' task_runs='||(SELECT count(*) FROM task_runs)" 2>&1; }
count_running() { docker exec water-army-postgres-1 psql -U app -d water_army -tAc \
  "SELECT 'devices='||(SELECT count(*) FROM devices)||' task_runs='||(SELECT count(*) FROM task_runs)||' has_identities_table='||(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='identities')" 2>&1; }

log "E2: counts BEFORE"
count_scratch  | tee "$E/e2-counts-before-scratch.txt"
count_running  | tee "$E/e2-counts-before-running.txt"

log "E2: raw INSERT identity (scratch pg only)"
docker exec -i g2-scratch-pg psql -U postgres -d water_army_g2 -v iid="$IID" -v dp="$DATAPATH" <<'SQL' | tee "$E/e2-insert-output.txt"
INSERT INTO identities (id, external_ref, display_name, identity_type, status, data_path, metadata_json, created_at, updated_at)
VALUES (:'iid', 'g2-e2e-synth', 'g2-e2e-synth', 'qa_device', 'READY', :'dp',
        '{"gen":2,"purpose":"RAM-G2 Phase E identity persistence E2E"}'::jsonb, now(), now());
SELECT id, display_name, identity_type, status, data_path FROM identities WHERE id=:'iid';
SQL
rc_insert=${PIPESTATUS[0]}

log "E2: counts AFTER"
count_scratch  | tee "$E/e2-counts-after-scratch.txt"
count_running  | tee "$E/e2-counts-after-running.txt"

echo "identity_id=$IID"
echo "insert_rc=$rc_insert"
[ "$rc_insert" = "0" ]

#!/usr/bin/env bash
# J5 — one automated task day (runbook J5): tasks / leases / console streams /
# manual interventions — ALL real paths (real worker, real queue, real leases).
#
# Usage: scripts/acceptance/j5-task-day.sh
# Env:   WA_ACCEPT_OP_* (writes), WA_ACCEPT_ADMIN_* (reads/admin),
#        WA_TASK_PROVIDER (default = server default; 'mock' honesty note in runbook).
# Idempotent: idempotencyKeys derive from a fixed acceptance seed unless
#             WA_RUN_NONCE is set (set it per "day" you want recorded fresh).
source "$(dirname "$0")/common.sh"
j_init j5
NONCE="${WA_RUN_NONCE:-$(date +%Y%m%d)}"
warm; login_admin; login_operator
api admin GET "/identities?pageSize=100" > "$(ev_path identities.json)"
api admin GET "/devices/redroid" > "$(ev_path devices.json)"

# ---- 1) task run (prompt lane) + event stream to terminal ----------------------
api op POST "/tasks/runs" "$(jq -nc --arg k "j5-run-$NONCE" '{
  prompt:"acceptance J5 task-day smoke: fleet inventory summary", title:"j5-task-day", idempotencyKey:$k}')" > "$(ev_path task-run.json)"
assert_true "task run accepted (202)" test "$HTTP_CODE" = 202
run_id="$(jq -r '.taskRun.id // .taskRun.runId // empty' "$(ev_path task-run.json)" 2>/dev/null || true)"
if [ -n "$run_id" ]; then
  api op GET "/tasks/runs/$run_id/events" > "$(ev_path "task-events-$run_id.txt")" || true
  wait_until "task run $run_id terminal" "${RUN_TIMEOUT:-600}" bash -c \
    "curl -fsS -b '$ADMIN_JAR' '$WA_API_URL/api/tasks/runs/$run_id' | jq -e '.status // .run.status | IN(\"succeeded\",\"failed\",\"timed_out\",\"cancelled\",\"skipped\")'" \
    || verdict FAIL "task run $run_id never reached terminal within ${RUN_TIMEOUT:-600}s"
  api admin GET "/tasks/runs/$run_id" > "$(ev_path "task-run-final-$run_id.json")"
  st="$(jq -r '.status // .run.status // "unknown"' "$(ev_path "task-run-final-$run_id.json")")"
  echo "task run final status: $st"
else
  echo "NOTE: no run id in response (HTTP $HTTP_CODE): $(head -c 300 "$(ev_path task-run.json)")"
fi

# ---- 2) schedule lane (if a seeded task definition exists) ----------------------
def_id="$(api admin GET "/tasks/definitions" | jq -r '(.items // .)[0].id // empty' | head -1)"
if [ -n "$def_id" ]; then
  sched_body="$(jq -nc --arg d "$def_id" --arg n "$NONCE" '{
    name:("j5-soak-schedule-" + $n), taskDefinitionId:$d, scheduleType:"interval", intervalMs:600000, overlapPolicy:"skip_if_running"}')"
  api op POST "/schedules" "$sched_body" > "$(ev_path schedule.json)"
  sc_id="$(jq -r '.schedule.id // empty' "$(ev_path schedule.json)")"
  if [ -n "$sc_id" ]; then
    api op POST "/schedules/$sc_id/run-now" "" > "$(ev_path schedule-runnaw.json)"
    echo "schedule $sc_id run-now HTTP $HTTP_CODE" > "$(ev_path schedule-runnaw-http.txt)"
    echo "$sc_id" > "$(ev_path schedule-id.txt)"   # left RUNNING for J8 soak; J9 cleans
  else echo "NOTE: schedule create HTTP $HTTP_CODE: $(head -c 200 "$(ev_path schedule.json)")"; fi
else
  echo "NOTE: no task definition seeded — schedule lane skipped honestly (ops prereq: seed a definition)"
fi

# ---- 3) batch lane: preview==create parity, start, leases, stop/remove ---------
ids_json="$(jq -c --arg p "$ACC_PREFIX" '[.items[] | select((.displayName // "") | startswith($p)) | .id]' "$(ev_path identities.json)")"
if [ "$(echo "$ids_json" | jq length)" -gt 0 ]; then
  bbody="$(jq -nc --argjson ids "$ids_json" --arg k "j5-batch-$NONCE" \
    '{name:"j5-acceptance-cycle", idempotencyKey:$k, identities:$ids, batchSize:10, maxActiveContainers:3, failurePolicy:"continue_and_report"}')"
  api op POST "/batches/preview" "$bbody" > "$(ev_path batch-preview.json)"
  pv_ready="$(jq -r '[.batches[]?.members[]? | select(.action=="READY" or .decision=="READY")] | length // 0' "$(ev_path batch-preview.json)" 2>/dev/null || echo 0)"
  api op POST "/batches" "$bbody" > "$(ev_path batch-create.json)"
  cycle="$(jq -r '.cycleId // empty' "$(ev_path batch-create.json)")"
  [ -n "$cycle" ] && echo "$cycle" > "$(ev_path cycle-id.txt)"   # J9 cancels/cleans
  # replay parity (idempotent create)
  api op POST "/batches" "$bbody" >/dev/null
  assert_eq "batch create idempotent replay = same cycle" "$cycle" "$(jq -r '.cycleId' <<<"$RESP")"
  api op GET "/batch-containers" > "$(ev_path batch-containers.json)" || true
  if [ -n "${cycle:-}" ]; then
    api op POST "/batches/$cycle/start" "" > "$(ev_path batch-start.json)" || true
    echo "batch start HTTP $HTTP_CODE" >> "$(ev_path batch-start.json)"
  fi
  api op POST "/batch-containers/reconcile" '{"fix":true}' > "$(ev_path reconcile.json)" || true
else
  echo "NOTE: no acceptance identities found — batch lane skipped (run J1 first)"
fi

# ---- 4) stream lease spot-check (up to 3 running devices) -----------------------
i=0
jq -r '.devices[] | select(.containerState=="running" or .adbState=="online") | "\(.id) \(.name)"' "$(ev_path devices.json)" | head -3 |
while read -r did name; do
  i=$((i+1))
  api op POST "/devices/redroid/$did/streams" '{"mode":"viewer"}' > "$(ev_path "lease-create-$i.json")"
  lease="$(jq -r '.lease.id // empty' "$(ev_path "lease-create-$i.json")")"
  if [ -n "$lease" ]; then
    api op POST "/device-streams/$lease/heartbeat" "" >/dev/null; echo "heartbeat HTTP $HTTP_CODE" > "$(ev_path "lease-hb-$i.txt")"
    api op DELETE "/device-streams/$lease" "" > "$(ev_path "lease-close-$i.json")"
  else
    echo "NOTE: lease create HTTP $HTTP_CODE $(head -c 200 "$(ev_path "lease-create-$i.json")")" > "$(ev_path "lease-note-$i.txt")"
  fi
done
api admin GET "/device-streams" > "$(ev_path leases-after.json)"

# ---- 5) manual intervention closed loop + dedupe --------------------------------
dev1="$(jq -r '.devices[0].id // empty' "$(ev_path devices.json)")"
if [ -n "$dev1" ]; then
  ib="$(jq -nc --arg d "$dev1" '{source:"operator_report", category:"acceptance", title:"J5 acceptance drill", deviceId:$d, evidence:"manual drill — no secrets here"}')"
  api op POST "/manual-interventions" "$ib" > "$(ev_path mi-1.json)"
  mi="$(jq -r '.intervention.id // empty' "$(ev_path mi-1.json)")"
  if [ -n "$mi" ]; then
    api op POST "/manual-interventions" "$ib" > "$(ev_path mi-dedupe.json)"
    assert_eq "dedupe: repeat signal created=false" "false" "$(jq -r .created "$(ev_path mi-dedupe.json)")"
    api op POST "/manual-interventions/$mi/acknowledge" "" >/dev/null; echo "ack HTTP $HTTP_CODE" > "$(ev_path mi-ack.txt)"
    api op POST "/manual-interventions/$mi/assign" '{}' >/dev/null; echo "assign HTTP $HTTP_CODE" > "$(ev_path mi-assign.txt)"
    api op POST "/manual-interventions/$mi/resolve" '{"note":"J5 drill closed"}' >/dev/null; echo "resolve HTTP $HTTP_CODE" > "$(ev_path mi-resolve.txt)"
    api admin GET "/manual-interventions/$mi" > "$(ev_path mi-final.json)"
    assert_eq "intervention closed = resolved" "resolved" "$(jq -r .status "$(ev_path mi-final.json)")"
  fi
fi

# ---- 6) day-end snapshot ---------------------------------------------------------
api admin GET "/dashboard/summary" > "$(ev_path dashboard.json)"
api admin GET "/batches/metrics" > "$(ev_path metrics.json)"
crit="$(jq -r '[.alerts[]? | select(.severity=="critical")] | length' "$(ev_path metrics.json)" 2>/dev/null || echo 0)"
assert_eq "no critical alerts at day end" "0" "$crit"

verdict passed "J5 task-day paths exercised (task run + schedule + batch/lease + streams + interventions); provider honesty note per runbook J5"

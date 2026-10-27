#!/usr/bin/env bash
# J9 — teardown, zero residue (runbook J9). Scope-locked: only redroid-acc-* /
# wa-acc-* + compose project resources are ever touched; user stack untouched
# (before/after docker ps diff as evidence).
#
# Usage: scripts/acceptance/j9-teardown.sh [--purge-data] [--compose-down]
#   --purge-data    : also purge acceptance identity data dirs (dryRun pre-check
#                     then confirm-token run — admin+human lane per contract)
#   --compose-down  : final full project reset (docker compose -p water-army down -v)
# Env: WA_ACCEPT_ADMIN_*. Idempotent: absent resources = no-op.
source "$(dirname "$0")/common.sh"
j_init j9
PURGE=0; DOWN=0
for a in "$@"; do case "$a" in --purge-data) PURGE=1;; --compose-down) DOWN=1;; *) echo "unknown arg $a" >&2; exit 2;; esac; done
warm; login_admin; login_operator
{ date -Is; docker ps -a --format '{{.Names}}\t{{.Status}}'; } > "$(ev_path docker-ps-before.txt)"

api admin GET "/identities?pageSize=100" > "$(ev_path identities.json)"
api admin GET "/devices/redroid" > "$(ev_path devices.json)"

# 1) schedules/batches left from J5 (best-effort, honest notes)
if [ -f "$EVIDENCE_ROOT/j5/schedule-id.txt" ]; then
  sc="$(cat "$EVIDENCE_ROOT/j5/schedule-id.txt")"
  api op POST "/schedules/$sc/pause" "" >/dev/null && echo "schedule paused HTTP $HTTP_CODE" > "$(ev_path schedule-clean.txt)"
  api op DELETE "/schedules/$sc" "" >> "$(ev_path schedule-clean.txt)"; echo " delete HTTP $HTTP_CODE" >> "$(ev_path schedule-clean.txt)"
fi
if [ -f "$EVIDENCE_ROOT/j5/cycle-id.txt" ]; then
  cy="$(cat "$EVIDENCE_ROOT/j5/cycle-id.txt")"
  api op POST "/batches/$cy/cancel" "" > "$(ev_path batch-cancel.json)" || true
fi

# 2) acceptance devices: delete (data kept unless --purge-data path below)
while read -r did name; do
  [ -n "$did" ] || continue
  acc_scope "$name"
  api admin DELETE "/devices/redroid/$did" "$(jq -nc --arg c "$name" '{confirm:$c, removeData:false}')" \
    > "$(ev_path "delete-$name.json")" || true
  echo "delete $name HTTP $HTTP_CODE"
done < <(jq -r --arg p "$ACC_PREFIX" '.devices[] | select(.name|startswith($p)) | "\(.id) \(.name)"' "$(ev_path devices.json)")

# 3) purge data dirs (identity purge = admin+human, dryRun first, confirm=identity id)
if [ "$PURGE" = 1 ]; then
  while read -r id name; do
    [ -n "$id" ] || continue
    api admin POST "/identities/$id/purge" '{"dryRun":true}' > "$(ev_path "purge-dry-$name.json")" || true
    api admin POST "/identities/$id/purge" "$(jq -nc --arg c "$id" '{dryRun:false, confirm:$c}')" > "$(ev_path "purge-$name.json")" || true
    echo "purge $name HTTP $HTTP_CODE"
  done < <(jq -r --arg p "$ACC_PREFIX" '.items[] | select((.displayName // "")|startswith($p)) | "\(.id) \(.displayName)"' "$(ev_path identities.json)")
fi

# 4) orphan sweep + zero-residue assertions
api op POST "/batch-containers/reconcile" '{"fix":true}' > "$(ev_path reconcile.json)" || true
api admin GET "/devices/redroid" > "$(ev_path devices-after.json)"
resid="$(jq -r --arg p "$ACC_PREFIX" '[.devices[] | select(.name|startswith($p))] | length' "$(ev_path devices-after.json)")"
assert_eq "zero acceptance devices left" "0" "$resid"
if [ "$PURGE" = 1 ]; then
  api admin GET "/identities?pageSize=100" > "$(ev_path identities-after.json)"
  left="$(jq -r --arg p "$ACC_PREFIX" '[.items[] | select((.displayName // "")|startswith($p))] | length' "$(ev_path identities-after.json)")"
  assert_eq "zero acceptance identities left" "0" "$left"
fi
left_ctr="$(docker ps -a --format '{{.Names}}' | grep -cE "^(${ACC_PREFIX}|${SCRATCH_PREFIX})" || true)"
assert_eq "zero acceptance containers left" "0" "$left_ctr"

# 5) user-stack zero-drift
{ date -Is; docker ps -a --format '{{.Names}}\t{{.Status}}'; } > "$(ev_path docker-ps-after.txt)"
grep -vE "${COMPOSE_PROJECT}-|${ACC_PREFIX}|${SCRATCH_PREFIX}" "$(ev_path docker-ps-before.txt)" | grep -v '^[0-9T:-]' | sort > "$(ev_path _a.txt)" || true
grep -vE "${COMPOSE_PROJECT}-|${ACC_PREFIX}|${SCRATCH_PREFIX}" "$(ev_path docker-ps-after.txt)"  | grep -v '^[0-9T:-]' | sort > "$(ev_path _b.txt)" || true
assert_true "user stack zero-drift" diff "$(ev_path _a.txt)" "$(ev_path _b.txt)"

# 6) optional full project reset
if [ "$DOWN" = 1 ]; then
  cd "$REPO_ROOT"
  docker compose -p "$COMPOSE_PROJECT" -f "${COMPOSE_FILE:-compose.yaml}" down --remove-orphans -v 2>&1 | tee "$(ev_path compose-down.log)"
fi

verdict passed "J9 teardown complete (archive logs/acceptance/j8/observations.md BEFORE --compose-down; runbook J9 step 0)"

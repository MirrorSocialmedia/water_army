#!/usr/bin/env bash
# J7 — container recycle + rebuild + login-state/data retention proof (runbook J7).
# Three T2/ADR-029 claim paths on REAL usage residue from J3-J5:
#   A = retention rebuild: delete (default, keep data) → same-identity recreate
#       → claim re-claim ALLOWED → human verifies Gmail/Chrome sessions intact.
#   B = cross-identity conflict: delete keep-data → OTHER identity recreating
#       the same device name → 409 DATA_DIR_CLAIM_CONFLICT → original re-claim OK.
#   C = full clear: removeData=true → dir + claim released → fresh environment.
#
# Usage: scripts/acceptance/j7-rebuild-retention.sh
# Env:   WA_ACCEPT_ADMIN_* (delete/create = admin), WA_J7_A/B/C (device names,
#        default redroid-acc-01 / redroid-acc-02 / redroid-acc-03; all must be
#        inside acc scope), ADB (host-side dataDir probes run via docker exec
#        on api container if WA_DATA_ROOT_IN_CONTAINER=1).
# Idempotent: state-based (already-deleted → skip delete; claim checks idempotent).
source "$(dirname "$0")/common.sh"
j_init j7
A="${WA_J7_A:-redroid-acc-01}"; B="${WA_J7_B:-redroid-acc-02}"; C="${WA_J7_C:-redroid-acc-03}"
for n in "$A" "$B" "$C"; do acc_scope "$n"; done
warm; login_admin
api admin GET "/identities?pageSize=100" > "$(ev_path identities.json)"
api admin GET "/devices/redroid" > "$(ev_path devices.json)"
lookup_dev() { jq -r --arg n "$1" '.devices[] | select(.name==$n) | "\(.id) \(.identityId // "")"' "$(ev_path devices.json)" | head -1; }
lookup_id()  { jq -r --arg n "$1" '.items[] | select((.displayName // "")==$n or (.name // "")==$n) | .id' "$(ev_path identities.json)" | head -1; }
tpl="$(jq -r '.devices[0].templateName // empty' "$(ev_path devices.json)" | head -1)"
[ -n "$tpl" ] || { verdict FAIL "no existing acceptance device to derive template from — run J2 first"; exit 1; }

delete_dev() { # delete_dev <name> <removeData true|false> <confirm=name> -> echoes resp file
  read -r did _ <<<"$(lookup_dev "$name")" || true
  [ -z "${did:-}" ] && { echo "SKIP delete: $name already absent"; return 0; }
  local f="$(ev_path "delete-$name-$(date +%s).json")"
  api admin DELETE "/devices/redroid/$did" "$(jq -nc --arg c "$name" --argjson r "${2:-false}" '{confirm:$c, removeData:$r}')" > "$f"
  echo "$f"
}
recreate() { # recreate <name> <identityNameForBinding> -> file
  local idn="$2"; local id; id="$(lookup_id "$idn")"
  local f="$(ev_path "recreate-$name-$(date +%s).json")"
  api admin POST "/devices/redroid" "$(jq -nc --arg n "$name" --arg t "$tpl" --arg k "j7-$name-$idn-v1" --arg id "$id" \
    '{name:$n, templateName:$t, idempotencyKey:$k} + (if $id=="" then {} else {identityId:$id} end)')" > "$f"
  echo "$f"
}

echo "== A: retention rebuild ($A) =="
fa="$(delete_dev "$A" false)"
if [ -f "$fa" ]; then
  assert_eq "A delete keeps data" "false" "$(jq -r .dataRemoved "$fa")"
  assert_eq "A delete keeps claim" "false" "$(jq -r .claimReleased "$fa")"
fi
fa2="$(recreate "$A" "$A")"
assert_eq "A same-identity re-claim allowed (201)" "201" "$HTTP_CODE"
echo "A next: start device + human check (Gmail App signed-in + Chrome FB/IG/Threads sessions intact) → sign off in runbook J7 table"

echo "== B: cross-identity claim conflict ($B vs $A's dir owner swap) =="
# B: delete keep-data, then try recreating B's NAME bound to A's identity (foreign claim)
fb="$(delete_dev "$B" false)"
b_owner_foreign="$(lookup_id "$A")"   # A owns A's dir; binding B's name to A's identity = foreign for dir redroid-acc-02
read -r _ _ <<<"$(lookup_dev "$B" 2>/dev/null || true)" || true
# claim conflict triggers on DIR name: recreate device named $B but bound to $A identity
fbb="$(ev_path "recreate-$B-foreign-$(date +%s).json")"
api admin POST "/devices/redroid" "$(jq -nc --arg n "$B" --arg t "$tpl" --arg k "j7-$B-foreign-v1" --arg id "$b_owner_foreign" \
  '{name:$n, templateName:$t, idempotencyKey:$k, identityId:$id}')" > "$fbb"
# NOTE: claim keys on the identity's OWN claimed dir (one identity one home).
# Foreign-identity create on a claimed dir name = 409; same identity = allowed.
if [ "$HTTP_CODE" = 409 ]; then
  grep -Eq 'DATA_DIR_CLAIM_CONFLICT|ONE_IDENTITY_ONE_DATA_HOME|CLAIM' "$fbb" \
    && echo "PASS  B foreign/second-home claim rejected ($(jq -r '.error.code // "409"' "$fbb" 2>/dev/null))" \
    || verdict FAIL "B unexpected 409 body: $(head -c 200 "$fbb")"
elif [ "$HTTP_CODE" = 201 ] || [ "$HTTP_CODE" = 200 ]; then
  # A's identity already claims redroid-acc-01's home; naming a device redroid-acc-02
  # under A = "second data home" 409 (one identity one home) OR re-claim if A owns B dir.
  verdict FAIL "B expected claim conflict, got $HTTP_CODE — inspect $fbb (contract drift?)"
else
  verdict FAIL "B unexpected HTTP $HTTP_CODE: $(head -c 200 "$fbb")"
fi
fb2="$(recreate "$B" "$B")"   # original identity recreates → allowed
assert_eq "B original-identity re-claim allowed" "201" "$HTTP_CODE"

echo "== C: full clear ($C) =="
fc="$(delete_dev "$C" true)"
if [ -f "$fc" ]; then
  assert_eq "C removeData removes data" "true" "$(jq -r .dataRemoved "$fc")"
  assert_eq "C claim released" "true" "$(jq -r .claimReleased "$fc")"
fi
fc2="$(recreate "$C" "$C")"
assert_eq "C recreate allowed after release (201)" "201" "$HTTP_CODE"
echo "C next: start + human check (Gmail NOT signed-in = fresh env) → sign off runbook J7"

api admin GET "/devices/redroid" > "$(ev_path devices-final.json)"
verdict passed "J7 three-path claim/retention API semantics green (human session-intact sign-offs in runbook J7 = remaining evidence for J verdict)"

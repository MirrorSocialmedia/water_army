#!/usr/bin/env bash
# J3 — Gmail App manual login (long-term anchor) — VERIFY side + human transition.
# Humans do the login (Console controller → Gmail App → inbox usable);
# THIS script asserts the resulting login-state machine truth via API.
#
# Usage:
#   scripts/acceptance/j3-gmail-anchor.sh           # assert-only (after humans logged in)
#   scripts/acceptance/j3-gmail-anchor.sh --mark    # human confirms → operator transitions
#
# Env: WA_ACCEPT_OP_* (transition = operator+ session; the ONLY write path),
#      WA_ACCEPT_ADMIN_* (reads), WA_ACCEPT_NAMES/WA_ACCEPT_IPS as J1.
# Idempotent: state-based (already-CONFIRMED identities skip transition;
#             --mark on CONFIRMED = no-op, NOT the 409 self-transition).
source "$(dirname "$0")/common.sh"
j_init j3
MODE="${1:-assert}"
warm; login_admin; login_operator

# operator session = WA_ACCEPT_OP_*; reads via admin
api admin GET "/identities?pageSize=100" > "$(ev_path identities.json)"
lookup_id() { jq -r --arg n "$1" '.items[] | select((.displayName // "")==$n or (.name // "")==$n) | .id' "$(ev_path identities.json)" | head -1; }

for name in $(acc_names); do
  [ -n "$name" ] || continue
  id="$(lookup_id "$name")"
  [ "$id" != "" ] && [ "$id" != "null" ] || { verdict FAIL "identity $name not found"; continue; }
  api admin GET "/identities/$id/login" > "$(ev_path "login-$name.json")"
  state="$(jq -r '.login.loginState // "MISSING"' "$(ev_path "login-$name.json")")"
  echo "  $name: $state"
  if [ "$MODE" = "--mark" ]; then
    if [ "$state" = "PENDING_LOGIN" ]; then
      # evidence: human-confirm note — credential-shaped words = 400 by contract (zero secrets)
      api op POST "/identities/$id/login/transition" \
        "$(jq -nc --arg d "$(date -Is)" '{to:"CONFIRMED_LOGGED_IN", evidence:("J3 Gmail app manual login confirmed " + $d)}')" \
        > "$(ev_path "transition-$name.json")"
      assert_eq "transition PENDING→CONFIRMED ($name)" "200" "$HTTP_CODE"
    elif [ "$state" = "CONFIRMED_LOGGED_IN" ]; then
      echo "SKIP  $name already CONFIRMED_LOGGED_IN (idempotent — no self-transition 409)"
    else
      verdict FAIL "$name unexpected loginState $state (human flow incomplete?)"
    fi
    api admin GET "/identities/$id/login" > "$(ev_path "login-$name.json")"
    state="$(jq -r '.login.loginState // "MISSING"' "$(ev_path "login-$name.json")")"
  fi
  assert_eq "anchor state = CONFIRMED_LOGGED_IN ($name)" "CONFIRMED_LOGGED_IN" "$state"
  api admin GET "/identities/$id/login/audit?limit=50" > "$(ev_path "audit-$name.json")"
  assert_true "audit trail has the PENDING→CONFIRMED row ($name)" \
    jq -e '.items | map(select(.toState=="CONFIRMED_LOGGED_IN" and .fromState=="PENDING_LOGIN" and .actorUserId != null)) | length >= 1' "$(ev_path "audit-$name.json")"
done

# contract re-proofs on ONE identity (fail-closed machine, live):
first_id="$(lookup_id "$(acc_names | cut -d' ' -f1)")"
if [ "$first_id" != "" ] && [ "$first_id" != "null" ]; then
  api op POST "/identities/$first_id/login/transition" '{"to":"CONFIRMED_LOGGED_IN","evidence":"self-transition probe"}' >/dev/null
  assert_eq "self-transition rejected 409 INVALID_LOGIN_TRANSITION" "409" "$HTTP_CODE"
  echo "$RESP" > "$(ev_path contract-selftransition.json)"
  api op POST "/identities/$first_id/login/transition" '{"to":"CONFIRMED_LOGGED_IN","evidence":"entered password abc123token"}' >/dev/null
  assert_eq "credential-shaped evidence rejected 400 (zero-secrets)" "400" "$HTTP_CODE"
  echo "$RESP" > "$(ev_path contract-evidence.json)"
fi

verdict passed "J3 Gmail anchor: all identities CONFIRMED_LOGGED_IN + audit + fail-closed contracts live (human checklist sign-off in runbook J3 required for the J verdict)"

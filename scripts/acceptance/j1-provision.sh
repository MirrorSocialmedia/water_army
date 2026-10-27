#!/usr/bin/env bash
# J1 — provision 10 acceptance identities (idempotent; runbook J1).
# Run twice: 1st = created×10, 2nd = replayed×10 (idempotency proof, both runs green).
#
# Usage: scripts/acceptance/j1-provision.sh
# Env:   WA_ACCEPT_ADMIN_* (admin: provision is admin-only),
#        WA_ACCEPT_NAMES (optional csv; default redroid-acc-01..10),
#        WA_ACCEPT_IPS   (optional csv, parallel independent egress IPs for W3/J6).
# Idempotent: yes (POST /identities/provision replays existing externalRef).
source "$(dirname "$0")/common.sh"
j_init j1
warm
login_admin

names_json="$(acc_names | tr ' ' '\n' | grep -v '^$' | jq -R . | jq -sc .)"
ips_json="null"
if [ -n "${WA_ACCEPT_IPS:-}" ]; then ips_json="$(acc_ips | tr ' ' '\n' | grep -v '^$' | jq -R . | jq -sc .)"; fi
body="$(jq -nc --argjson n "$names_json" --argjson ips "$ips_json" \
  '{names:$n, identityType:"qa_device"} + (if $ips == null then {} else {egressIps:$ips} end)')"

api admin POST "/identities/provision" "$body" > "$(ev_path provision-run1.json)"
assert_eq "provision HTTP 200" "200" "$HTTP_CODE"
n_expected="$(echo "$names_json" | jq 'length')"
created1="$(jq -r .created "$(ev_path provision-run1.json)")"
replayed1="$(jq -r .replayed "$(ev_path provision-run1.json)")"
echo "run1: created=$created1 replayed=$replayed1 (of $n_expected)"
if [ "$created1" != "$n_expected" ] && [ "$replayed1" != "$n_expected" ]; then
  verdict FAIL "run1 neither fully created nor fully replayed (mixed state)"; exit 1
fi

# run2 = idempotent replay proof (never duplicates rows)
api admin POST "/identities/provision" "$body" > "$(ev_path provision-run2.json)"
assert_eq "idempotent replay: created = 0" "0" "$(jq -r .created "$(ev_path provision-run2.json)")"
assert_eq "idempotent replay: replayed = n" "$n_expected" "$(jq -r .replayed "$(ev_path provision-run2.json)")"

# per-identity: fingerprint auto-ensured (deterministic, ADR-028) + login PENDING_LOGIN
: > "$(ev_path identity-loginstates.txt)"
while read -r name; do
  [ -z "$name" ] && continue
  id="$(jq -r --arg n "$name" '.items[] | select(.name==$n) | .identityId' "$(ev_path provision-run2.json)")"
  [ -n "$id" ] && [ "$id" != "null" ] || { verdict FAIL "no identityId for $name"; continue; }
  echo "$name $id" >> "$(ev_path identity-ids.txt)"
  api admin GET "/identities/$id/fingerprint" > "$(ev_path "fp-$name.json")"
  assert_true "fingerprint auto-ensured for $name" jq -e '.profile != null' "$(ev_path "fp-$name.json")"
  api admin GET "/identities/$id/login" > "$(ev_path "login-$name.json")"
  js="$(jq -r '.login.loginState // "MISSING"' "$(ev_path "login-$name.json")")"
  assert_eq "initial loginState = PENDING_LOGIN ($name)" "PENDING_LOGIN" "$js"
  sdn="$(jq -r --arg n "$name" '.items[] | select(.name==$n) | .suggestedDeviceName' "$(ev_path provision-run2.json)")"
  assert_eq "suggestedDeviceName == name ($name)" "$name" "$sdn"
done < <(acc_names)

# fleet fingerprint collisions: non-blocking
api admin GET "/identities/fingerprints/collisions" > "$(ev_path collisions.json)"
assert_eq "fingerprint collision report non-blocking" "false" "$(jq -r .blocking "$(ev_path collisions.json)")"

verdict passed "J1 fleet spec green (created/replay + fingerprints + initial login states)"

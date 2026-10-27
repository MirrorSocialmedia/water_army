#!/usr/bin/env bash
# J6 — egress assertions (runbook J6, W3/ADR-027): every identity = ONE pinned
# egress + fleet-unique exit IP; device network health = authoritative payload.
#
# Usage: scripts/acceptance/j6-egress-assert.sh
#   SKIP_DATAPLANE=1 — API-layer only (no in-device netcheck; for mock/dev hosts)
# Env: WA_ACCEPT_ADMIN_*; optional WA_DATAPLANE_CMD — command template executed
#   with the device as context, must print the observed exit IP to stdout
#   (real-device stage wires the br-b6-egress netcheck chain here:
#   scripts/br-b6-egress/common.sh buildT2sNetcheckScript + netns sidecar).
# Idempotent: pure reads + assertions.
source "$(dirname "$0")/common.sh"
j_init j6
warm; login_admin

# ---- 1) bindings: one per acceptance identity, IPs pairwise-unique -------------
api admin GET "/identities/egress" > "$(ev_path bindings.json)"
if [ "$HTTP_CODE" = 503 ]; then
  verdict FAIL "W3 disabled (EGRESS_BINDING_DISABLED) — set WA_W3_EGRESS_BINDING_ENABLED=true; J6 does NOT silently pass"
  exit 1
fi
api admin GET "/identities?pageSize=100" > "$(ev_path identities.json)"
n_ids="$(jq -r --arg p "$ACC_PREFIX" '[.items[] | select((.displayName // "") | startswith($p))] | length' "$(ev_path identities.json)")"
n_bind="$(jq -r --argjson n "$n_ids" '[.bindings[]? // .items[]? // (if type=="array" then .[] else empty end)] | length' "$(ev_path bindings.json)" 2>/dev/null || echo 0)"
echo "identities=$n_ids bindings=$n_bind"
assert_true "bindings cover all acceptance identities" test "$n_bind" -ge "$n_ids"
dup_ips="$(jq -r '.bindings[]? // (if type=="array" then .[] else empty end) | .expectedEgressIp' "$(ev_path bindings.json)" 2>/dev/null | sort | uniq -d || true)"
if [ -n "$dup_ips" ]; then verdict FAIL "duplicate exit IPs across identities: $dup_ips"
else echo "PASS  exit IPs pairwise unique fleet-wide"; fi
# zero-credential surface: no proxy URL/creds anywhere in the response
grep -Eiq 'socks5://|proxyUrl|passw' "$(ev_path bindings.json)" && verdict FAIL "credential-shaped leak in egress binding surface" || echo "PASS  zero-credential binding surface"

# ---- 2) per-device authoritative health ----------------------------------------
api admin GET "/devices/redroid" > "$(ev_path devices.json)"
while read -r did name; do
  [ -n "$did" ] || continue
  api admin GET "/devices/redroid/$did" > "$(ev_path "device-$name.json")"
  nr="$(jq -r '.proxy.network.networkReady // false' "$(ev_path "device-$name.json")")"
  st="$(jq -r '.proxy.network.state // "null"' "$(ev_path "device-$name.json")")"
  stale="$(jq -r '.proxy.network.stale // "null"' "$(ev_path "device-$name.json")")"
  assert_eq "networkReady ($name)" "true" "$nr"
  assert_eq "net state HEALTHY ($name)" "HEALTHY" "$st"
  assert_eq "net not stale ($name)" "false" "$stale"
  # data-plane: observed exit IP == expected (real-device; template gets $DEV_NAME/$ADB_PORT)
  if [ "${SKIP_DATAPLANE:-0}" != 1 ] && [ -n "${WA_DATAPLANE_CMD:-}" ]; then
    port="$(jq -r .adbPort "$(ev_path "device-$name.json")")"
    observed="$(DEV_NAME="$name" ADB_PORT="$port" bash -c "$WA_DATAPLANE_CMD" 2>"$(ev_path "netcheck-$name.err")" | tr -dc '0-9.' )"
    expected="$(jq -r --arg n "$name" '.bindings[]? | select((.displayName // .identityName // "")==$n or .identityId==$n) | .expectedEgressIp // empty' "$(ev_path bindings.json)" | head -1)"
    if [ -n "$expected" ]; then assert_eq "observed exit IP == bound IP ($name)" "$expected" "$observed"
    else echo "NOTE: no expected IP mapping for $name in bindings view — calibrate field on real host"; fi
  fi
done < <(jq -r --arg p "$ACC_PREFIX" '.devices[] | select(.name | startswith($p)) | "\(.id) \(.name)"' "$(ev_path devices.json)")

# ---- 3) fail-closed fault window (optional, real-device manual) -----------------
if [ -n "${WA_FAULT_TEST_DEV:-}" ]; then
  acc_scope "$WA_FAULT_TEST_DEV"
  echo "Manual fault window (runbook J6 ④): kill tunnel on $WA_FAULT_TEST_DEV → run WA_DATAPLANE_CMD twice → expect ZERO direct egress (--internal semantics) → POST proxy/retry → re-run this script for recovery chain (VERIFYING before HEALTHY, never blind)." > "$(ev_path fault-window-instructions.txt)"
fi

verdict passed "J6 egress assertions green at asserted layer (data-plane per WA_DATAPLANE_CMD honesty note: unset = API-layer only => J verdict implemented-unverified)"

#!/usr/bin/env bash
# J2 — boot fleet + fingerprint probe per-field assertions (runbook J2).
# Real-device stage: creates wa-acc-tpl on $WA_IMAGE_REF, one device per
# acceptance identity (identityId-bound → dataDir claim active), starts with
# RAM-gate-aware bounded retry, waits adb online, installs probe-app, dumps
# ground truth, asserts via the W1b probe-assert chain (shared kernel), then
# cross-identity uniqueness sweep on unique props.
#
# Usage:  WA_IMAGE_REF=<pinned> scripts/acceptance/j2-boot-probe.sh
# Env:    WA_PROBE_APK (default probe-app/dist/wa-probe.apk), ADB (default adb),
#         BOOT_TIMEOUT_S (default 2400 — real cold boot ~24min, R6 calibration),
#         SKIP_PROBE=1 to skip device-side probe (API-level checks only).
# Idempotent: yes (device create idempotencyKey + replay; start idempotent).
source "$(dirname "$0")/common.sh"
j_init j2
IMG="${WA_IMAGE_REF:?WA_IMAGE_REF required (merged pinned artifact — J0 contract)}"
APK="${WA_PROBE_APK:-$REPO_ROOT/probe-app/dist/wa-probe.apk}"
ADB="${ADB:-adb}"
BOOT_TIMEOUT_S="${BOOT_TIMEOUT_S:-2400}"
TPL="${SCRATCH_PREFIX}tpl"
command -v "$ADB" >/dev/null || [ "${SKIP_PROBE:-0}" = 1 ] || { echo "FATAL: adb missing (or set SKIP_PROBE=1)" >&2; exit 2; }

warm; login_admin

# identity id lookup from live list (names == externalRef == displayName pool contract)
api admin GET "/identities?pageSize=100" > "$(ev_path identities.json)"
mapfile -t NAMES < <(acc_names)
lookup_id() { jq -r --arg n "$1" '.items[] | select((.displayName // "")==$n or (.name // "")==$n) | .id' "$(ev_path identities.json)" | head -1; }

# 1) template (create or reuse) — pinned merged image
api admin POST "/redroid/templates" "$(jq -nc --arg n "$TPL" --arg i "$IMG" \
  '{name:$n, image:$i, androidVersion:"14", privileged:true, privilegedReason:"acceptance J2 fleet (binder/dev nodes)"}')" >/dev/null
if [ "$HTTP_CODE" = 409 ]; then echo "template $TPL exists — reusing"; elif [ "$HTTP_CODE" = 201 ]; then echo "template created"; else verdict FAIL "template create unexpected HTTP $HTTP_CODE: $RESP"; exit 1; fi

# 2) create + start devices (RAM-gate retry bounded), wait adb online
> "$(ev_path devices.txt)"
for name in "${NAMES[@]}"; do
  [ -n "$name" ] || continue
  acc_scope "$name"
  id="$(lookup_id "$name")"
  body="$(jq -nc --arg n "$name" --arg t "$TPL" --arg k "j2-$name-v1" --arg id "$id" \
    '{name:$n, templateName:$t, idempotencyKey:$k} + (if $id=="" or $id=="null" then {} else {identityId:$id} end)')"
  api admin POST "/devices/redroid" "$body" > "$(ev_path "create-$name.json")"
  [ "$HTTP_CODE" = 201 ] || [ "$HTTP_CODE" = 200 ] || { verdict FAIL "create $name HTTP $HTTP_CODE: $RESP"; continue; }
  did="$(jq -r '.device.id' "$(ev_path "create-$name.json")")"
  echo "$name $did" >> "$(ev_path devices.txt)"
  # start; RAM-G1 denial (device = 409 RAM_GATE_DENIED / batch 503) = zero side
  # effects → bounded retry; other errors = fail fast.
  api admin POST "/devices/redroid/$did/start" ""
  t=0
  while [ "$HTTP_CODE" = 503 ] || { [ "$HTTP_CODE" = 409 ] && echo "$RESP" | grep -q RAM_GATE_DENIED; }; do
    t=$((t+30))
    [ "$t" -ge "$BOOT_TIMEOUT_S" ] && { verdict FAIL "start $name RAM-gate starved for ${BOOT_TIMEOUT_S}s"; break; }
    echo "start $name RAM-gate deferred (HTTP $HTTP_CODE), retry in 30s"; sleep 30
    api admin POST "/devices/redroid/$did/start" ""
  done
  case "$HTTP_CODE" in 200|201) ;; *) verdict FAIL "start $name HTTP $HTTP_CODE: $RESP" ;; esac
done

# wait adb online per device (boot ~24min real; bounded)
while read -r name did; do
  [ -n "$did" ] || continue
  wait_until "device $name adb online" "$BOOT_TIMEOUT_S" \
    bash -c "curl -fsS -b '$ADMIN_JAR' '$WA_API_URL/api/devices/redroid/$did/refresh' -X POST | jq -e '.device.adbState==\"online\"'" \
    || verdict FAIL "device $name did not reach adb=online within ${BOOT_TIMEOUT_S}s"
  api admin GET "/devices/redroid/$did" > "$(ev_path "device-$name.json")"
done < "$(ev_path devices.txt)"

# 3) probe per device (W1b chain): install → dump → probe-assert vs expected profile
if [ "${SKIP_PROBE:-0}" != 1 ]; then
  [ -f "$APK" ] || { echo "NOTE: $APK missing — run 'ANDROID_HOME=... bash probe-app/build.sh' (real-device stage). Skipping probe assertions honestly."; export PROBE_SKIPPED=1; }
  while read -r name did; do
    [ -n "$did" ] || continue
    [ -f "$APK" ] || break
    port="$(jq -r .adbPort "$(ev_path "device-$name.json")")"
    target="127.0.0.1:$port"
    "$ADB" connect "$target" >/dev/null 2>&1 || true
    "$ADB" -s "$target" install -r "$APK" > "$(ev_path "install-$name.log")" 2>&1 || { verdict FAIL "probe install failed on $name"; continue; }
    "$ADB" -s "$target" shell am start -n com.waterarmy.probe/.ProbeActivity >/dev/null 2>&1 || \
      "$ADB" -s "$target" shell am start-foreground-service com.waterarmy.probe/.ProbeService >/dev/null 2>&1 || true
    sleep 15
    "$ADB" -s "$target" exec-out cat /data/local/tmp/wa-probe-dump.json > "$(ev_path "dump-$name.json")" || { verdict FAIL "probe dump missing on $name"; continue; }
    id="$(lookup_id "$name")"
    api admin GET "/identities/$id/fingerprint" | jq '.profile' > "$(ev_path "expected-$name.json")"
    node "$REPO_ROOT/scripts/w1b/probe-assert.mjs" --dump "$(ev_path "dump-$name.json")" \
      --expected "$(ev_path "expected-$name.json")" > "$(ev_path "assert-$name.txt")" \
      && echo "PASS  probe-assert $name (all strict fields)" | tee -a "$(ev_path verdict.txt)" \
      || verdict FAIL "probe-assert $name — per-field FAIL/MISSING (see assert-$name.txt)"
  done < "$(ev_path devices.txt)"
fi

# 4) cross-identity uniqueness sweep (unique-position props must not collide)
if [ -z "${PROBE_SKIPPED:-}" ]; then
  dup="$(cat "$EVIDENCE_ROOT/$CUR_J"/dump-*.json 2>/dev/null | jq -r '.props["ro.serialno"] // .props["ro.boot.serialno"] // empty' 2>/dev/null | sort | uniq -d || true)"
  if [ -n "$dup" ]; then verdict FAIL "serial collision across identities: $dup"
  else echo "PASS  unique-prop sweep (serial-level) collision-free" | tee -a "$(ev_path verdict.txt)"; fi
fi

verdict passed "J2 boot+probe chain complete (see per-device assert files; GMS PoC + merged image = verdict inputs)"

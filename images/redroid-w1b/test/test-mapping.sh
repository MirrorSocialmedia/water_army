#!/usr/bin/env bash
# W1b — host-side test harness for the image mapping contract:
#   1) propctl-wrapper.c %20 decode + fail-closed behaviour (compiled on host;
#      the ON-device binary semantics are a real-device-stage item — here we
#      test the wrapper LOGIC, which is 100% host-portable).
#   2) oem-ro-map.rc simulation: drive every mapping line the way init would
#      (carrier present -> exec; carrier absent -> no exec), against a stubbed
#      property writer. Catches rc/JS drift a unit test can't (ordering,
#      arg-split) and proves the exec line survives word-splitting.
# Run: bash images/redroid-w1b/test/test-mapping.sh   (exit 0 = green)
set -u
cd "$(dirname "$0")/.."
FAIL=0
note() { printf '%s\n' "$*"; }
ok()   { note "  ok - $*"; }
bad()  { note "  NOT OK - $*"; FAIL=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# 1) wrapper decode tests
# ---------------------------------------------------------------------------
note "# wrapper %20 decode"
if ! command -v gcc >/dev/null 2>&1; then
  bad "gcc not available on host — wrapper tests skipped"
else
  gcc -O2 -static -Wall -Wextra -o "$WORK/oem-propctl" propctl-wrapper.c || bad "wrapper did not compile"
  cat > "$WORK/real" <<'EOF'
#!/bin/sh
# stub property writer: log "WROTE <name> <value>" per invocation
printf 'WROTE'
for a in "$@"; do printf ' [%s]' "$a"; done
printf '\n'
EOF
  chmod +x "$WORK/real"
  OUT="$(OEM_PROPCTL_REAL="$WORK/real" "$WORK/oem-propctl" ro.product.model 'Pixel%208%20Pro')"
  [ "$OUT" = "WROTE [ro.product.model] [Pixel 8 Pro]" ] && ok "spaces decoded from %20 in single argv slot" || bad "decode wrong: $OUT"
  OUT="$(OEM_PROPCTL_REAL="$WORK/real" "$WORK/oem-propctl" ro.build.fingerprint 'google/bluejay/bluejay:17/CP3A.261005.002.A1/16269273:user/release-keys')"
  [ "$OUT" = "WROTE [ro.build.fingerprint] [google/bluejay/bluejay:17/CP3A.261005.002.A1/16269273:user/release-keys]" ] && ok "no-op passthrough for %20-free values" || bad "passthrough wrong: $OUT"
  ERR="$(OEM_PROPCTL_REAL="$WORK/real" "$WORK/oem-propctl" ro.x 'stray%41case' 2>&1; echo "rc=$?")"
  echo "$ERR" | grep -q 'rc=2' && ! echo "$ERR" | grep -q 'WROTE' && ok "stray percent token rejected fail-closed (exit 2, nothing written)" || bad "fail-closed wrong: $ERR"
fi

# ---------------------------------------------------------------------------
# 2) rc simulation — one fake "cmdline" with carriers for all 12 props
# ---------------------------------------------------------------------------
note "# oem-ro-map.rc simulation (init semantics: property present -> action)"
RC="oem-ro-map.rc"
[ -f "$RC" ] || { bad "$RC missing"; exit 1; }
# expected carrier values (device-side, after init parsed androidboot.*)
set_carrier() { # field -> value
  case "$1" in
    ro.product.brand) echo "google";;
    ro.product.manufacturer) echo "Google";;
    ro.product.model) echo "Pixel%208%20Pro";;   # what the Cmd actually carries
    ro.product.device) echo "shiba";;
    ro.product.name) echo "shiba";;
    ro.build.id) echo "CP3A.261005.005";;
    ro.build.display.id) echo "CP3A.261005.005";;
    ro.build.fingerprint) echo "google/shiba/shiba:17/CP3A.261005.005/16271449:user/release-keys";;
    ro.serialno) echo "GXWV1234ABCD";;
    ro.hardware) echo "shiba";;
    ro.boot.hardware) echo "shiba";;
    persist.sys.timezone) echo "Asia/Tokyo";;
  esac
}
: > "$WORK/writes.log"
TOTAL=0; MATCH=0
while IFS= read -r line; do
  rest="${line#*exec -- }"
  bin="${rest%% *}"
  rest="${rest#* }"; target="${rest%% *}"
  carrier="${line#*'${'}"; carrier="${carrier%%\}*}"
  # emulate init expansion: carrier present on cmdline -> action runs
  val="$(set_carrier "$(printf '%s' "$carrier" | sed 's/^ro\.boot\.oem_//; s/_/./g')")"
  [ -n "$val" ] || continue
  TOTAL=$((TOTAL+1))
  [ "$bin" = "/vendor/bin/oem-propctl" ] || { bad "unexpected bin: $bin"; continue; }
  # target check: carrier name must decode back to the target (oem_<target with . -> _>)
  expected_carrier="ro.boot.oem_$(printf '%s' "$target" | tr '.' '_')"
  [ "$carrier" = "$expected_carrier" ] || { bad "carrier $carrier != $expected_carrier"; continue; }
  if command -v gcc >/dev/null 2>&1 && [ -x "$WORK/oem-propctl" ]; then
    OUT="$(OEM_PROPCTL_REAL="$WORK/real" "$WORK/oem-propctl" "$target" "$val")"
    want_value="${val//%20/ }"
    [ "$OUT" = "WROTE [$target] [$want_value]" ] && MATCH=$((MATCH+1)) || bad "exec mismatch: $OUT"
  fi
done < <(grep 'exec --' "$RC")
note "  mapped lines executed: $TOTAL"
[ "$TOTAL" = "12" ] && ok "rc contains exactly 12 exec lines" || bad "expected 12 exec lines, got $TOTAL"
if command -v gcc >/dev/null 2>&1; then
  [ "$MATCH" = "12" ] && ok "all 12 target/value pairs land correctly (incl. model decode, timezone, hardware)" || bad "only $MATCH/12 correct"
fi

note "# result: $([ $FAIL = 0 ] && echo GREEN || echo RED)"
exit $FAIL

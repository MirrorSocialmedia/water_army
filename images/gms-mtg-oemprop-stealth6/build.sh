#!/usr/bin/env bash
# WA-STEALTH6 stealth6-v1 image build entry (COPY-only, pins fail closed,
# post-build IN-IMAGE asserts — no boot). Usage:
#   bash images/gms-mtg-oemprop-stealth6/build.sh [final-tag]
# HAL binary is committed (host-built by hal/build_host.sh; rebuild manually
# with that script when HAL sources change).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth6}"
BASE_TAG="water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth5"
note() { printf '[stealth6-build] %s\n' "$*"; }

BASE_WANT="sha256:2de5d82a" # stealth5 (WA-STEALTH6 gen1 ship = fx2 live image id)
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
case "$BASE_GOT" in "$BASE_WANT"*) note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}" ;; *) echo "BASE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want ${BASE_WANT}*)" >&2; exit 1 ;; esac

HAL_BIN="$DIR/files/vendor/bin/hw/android.hardware.sensors-service.example"
[ -f "$HAL_BIN" ] || { echo "missing committed HAL binary (run hal/build_host.sh)" >&2; exit 1; }
HAL_SHA="$(sha256sum "$HAL_BIN" | cut -d' ' -f1)"
note "hal pin: wa-sensors ${HAL_SHA:0:12} ($(stat -c%s "$HAL_BIN") bytes)"

# gen11 T5 maps-shim pins (field-proven bytes from fx2; rebuild via shim/build_shim.sh)
# is byte-reproducible on this host — regenerate pin intentionally, never sneak-edit.
SHIM_BIN="$DIR/files/system/lib64/shim.so"
[ -f "$SHIM_BIN" ] || { echo "missing files/system/lib64/shim.so (build via shim/build_shim.sh)" >&2; exit 1; }
SHIM_SHA="$(sha256sum "$SHIM_BIN" | cut -d' ' -f1)"
SHIM_WANT="3574cc7b052a7728a83a004a722aff7ffc260381689b3ebc3e6f952d3d1b4b1c" # gen10 v4 deployed on fx2 (score 82->97)
case "$SHIM_SHA" in "$SHIM_WANT"*) note "shim pin OK: ${SHIM_SHA:0:12} ($(stat -c%s "$SHIM_BIN") B)" ;; *) echo "SHIM PIN MISMATCH: $SHIM_SHA (want $SHIM_WANT*) — regenerate pin deliberately" >&2; exit 1 ;; esac
RC_EMBED="$DIR/files/init.redroid.rc"
[ -f "$RC_EMBED" ] || { echo "missing files/init.redroid.rc (full official zygote def + setenv LD_PRELOAD)" >&2; exit 1; }
grep -q 'service zygote /system/bin/app_process64' "$RC_EMBED" || { echo "init.redroid.rc: must be the COMPLETE official zygote definition (first-wins duplicate rule)" >&2; exit 1; }
grep -q 'setenv LD_PRELOAD /system/lib64/shim.so' "$RC_EMBED" || { echo "init.redroid.rc: setenv LD_PRELOAD line missing" >&2; exit 1; }
note "init.rc pin: embedded zygote definition complete + setenv present"

# gen11 debuggable flip pin (boss decision #4; field-proven fx2: boots, adbd alive, 97 no regression)
BPROP="$DIR/files/system/build.prop"
[ -f "$BPROP" ] || { echo "missing files/system/build.prop" >&2; exit 1; }
grep -q '^ro.debuggable=0$' "$BPROP" || { echo "build.prop: ro.debuggable must be 0 (user-build story)" >&2; exit 1; }
grep -q '^ro.build.type=user$' "$BPROP" || { echo "build.prop: ro.build.type must be user (story consistency)" >&2; exit 1; }
note "build.prop pin: ro.debuggable=0 + ro.build.type=user (story consistent)"

# ---- modes (init insecure-file rule: rc must be 0644; hw bin exec) ---------
find "$DIR/files" -type f \( -name '*.rc' -o -name '*.xml' \) -exec chmod 0644 {} +
chmod 0755 "$HAL_BIN"

# T3 network scripts (rc 0644, sh 0755)
chmod 0755 "$DIR/files/vendor/bin/stealth6-network.sh"

# gen11 shim: executable in image (ld.so needs +x; SELinux disabled in redroid so no policy work)
chmod 0755 "$SHIM_BIN"

docker build -f "$DIR/Dockerfile" -t "$FINAL" "$ROOT"
note "built: $FINAL"

# ---- post-build assertions (no boot) ---------------------------------------
CTR=stealth6-assert
docker rm -f "$CTR" 2>/dev/null || true
docker create --name "$CTR" "$FINAL" true >/dev/null
trap 'docker rm -f "$CTR" >/dev/null 2>&1 || true' EXIT
T="/tmp/stealth6-assert.$$"; mkdir -p "$T"
docker cp "$CTR:/vendor/etc/init/stealth6-extras.rc" "$T/abi.rc"
docker cp "$CTR:/vendor/etc/init/android.hardware.sensors-service.example.rc" "$T/svc.rc"
docker cp "$CTR:/vendor/etc/vintf/manifest/android.hardware.sensors.xml" "$T/sensors.xml"
docker cp "$CTR:/vendor/bin/hw/android.hardware.sensors-service.example" "$T/hal"
# byte-exact vs context (COPY-only discipline)
cmp "$T/abi.rc"     "$DIR/files/vendor/etc/init/stealth6-extras.rc"
cmp "$T/svc.rc"     "$DIR/files/vendor/etc/init/android.hardware.sensors-service.example.rc"
cmp "$T/sensors.xml" "$DIR/files/vendor/etc/vintf/manifest/android.hardware.sensors.xml"
cmp "$T/hal"        "$HAL_BIN"
for L in android.hardware.sensors-V2-ndk.so android.hardware.common-V2-ndk.so android.hardware.common.fmq-V1-ndk.so; do
  docker cp "$CTR:/vendor/lib64/$L" "$T/$L"
  cmp "$T/$L" "$DIR/files/vendor/lib64/$L" || { echo "ASSERT: /vendor/lib64/$L not byte-exact" >&2; exit 1; }
done
# modes inside the image
mode() { docker exec "$CTR" true 2>/dev/null || true; }
docker cp "$CTR:/vendor/etc/init/oem-ro-map.rc" "$T/oem-ro-map.rc"
cmp "$T/oem-ro-map.rc" "$DIR/../gms-mtg-oemprop-stealth5/files/vendor/etc/init/oem-ro-map.rc" \
  || { echo "ASSERT: oem-ro-map.rc drifted from stealth5 context (regenerate via generate-wa-ro-map-rc.mjs, not sneak-edit)" >&2; exit 1; }
note "post-build asserts OK (4 COPY targets byte-exact; oem-ro-map unchanged)"
# T3 bake assertions (create+cp, byte-exact vs context — cp works on created container)
T3_OK=1
for f in /vendor/etc/init/stealth6-network.rc /vendor/bin/stealth6-network.sh \
         /vendor/etc/permissions/android.hardware.sensor.proximity.xml \
         "/system/apex/com.android.tethering/priv-app/ServiceConnectivityResources@UD2A.240505.001.W1/ServiceConnectivityResources.apk"; do
  if docker cp "$CTR:$f" "$T/t3file" >/dev/null 2>&1 && cmp -s "$T/t3file" "$DIR/files$f"; then
    :
  else
    echo "ASSERT: $f missing or not byte-exact in image" >&2; T3_OK=0
  fi
done
[ "$T3_OK" = "1" ] && note "T3 bake asserts OK (4 T3 files present, byte-exact)"
# gen11 maps-shim bake asserts (create+cp, byte-exact vs context; cp preserves mode)
docker cp "$CTR:/system/lib64/shim.so" "$T/shim.so"
cmp "$T/shim.so" "$SHIM_BIN" || { echo "ASSERT: /system/lib64/shim.so not byte-exact" >&2; exit 1; }
SHIM_MODE="$(stat -c %a "$T/shim.so")"
[ "$SHIM_MODE" = "755" ] || { echo "ASSERT: shim.so mode $SHIM_MODE != 755" >&2; exit 1; }
docker cp "$CTR:/init.redroid.rc" "$T/init.redroid.rc"
cmp "$T/init.redroid.rc" "$RC_EMBED" || { echo "ASSERT: /init.redroid.rc not byte-exact" >&2; exit 1; }
RC_MODE="$(stat -c %a "$T/init.redroid.rc")"
[ "$RC_MODE" = "644" ] || { echo "ASSERT: /init.redroid.rc mode $RC_MODE != 644 (init insecure-file rule)" >&2; exit 1; }
# zygote definition must survive into image (first-wins duplicate is the mechanism, not a bug)
grep -q 'setenv LD_PRELOAD /system/lib64/shim.so' "$T/init.redroid.rc" || { echo "ASSERT: baked /init.redroid.rc lost setenv" >&2; exit 1; }
note "gen11 shim bake asserts OK (shim.so 755 byte-exact; init.redroid.rc 644 byte-exact)"
# gen11 build.prop bake assert (byte-exact + props readable from baked file)
docker cp "$CTR:/system/build.prop" "$T/build.prop"
cmp "$T/build.prop" "$BPROP" || { echo "ASSERT: /system/build.prop not byte-exact" >&2; exit 1; }
BPROP_MODE="$(stat -c %a "$T/build.prop")"
[ "$BPROP_MODE" = "644" ] || { echo "ASSERT: build.prop mode $BPROP_MODE != 644" >&2; exit 1; }
grep -q '^ro.debuggable=0$' "$T/build.prop" || { echo "ASSERT: baked build.prop lost ro.debuggable=0" >&2; exit 1; }
note "gen11 build.prop bake asserts OK (byte-exact 644; debuggable=0 in baked bytes)"
# SCR.apk w.*\d regex check
SCR_IMG="/tmp/stealth6-scr-$$.apk"
docker cp "$CTR:/system/apex/com.android.tethering/priv-app/ServiceConnectivityResources@UD2A.240505.001.W1/ServiceConnectivityResources.apk" "$SCR_IMG" 2>/dev/null
python3 - "$SCR_IMG" << 'PYEOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    arsc = z.read('resources.arsc')
assert b'w.*\d' in arsc, "SCR.apk: w.*\\d regex not found in resources.arsc"
assert b'eth\\d' not in arsc, "SCR.apk: eth\\d regex still present (patch not applied)"
print("T3 SCR.apk assert OK: w.*\\d regex in resources.arsc")
PYEOF
IMG_ID="$(docker image inspect -f '{{.Id}}' "$FINAL")"
note "final image id: $IMG_ID"

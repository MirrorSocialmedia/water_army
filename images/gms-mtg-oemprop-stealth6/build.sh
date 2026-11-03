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

# ---- modes (init insecure-file rule: rc must be 0644; hw bin exec) ---------
find "$DIR/files" -type f \( -name '*.rc' -o -name '*.xml' \) -exec chmod 0644 {} +
chmod 0755 "$HAL_BIN"

docker build -f "$DIR/Dockerfile" -t "$FINAL" "$ROOT"
note "built: $FINAL"

# ---- post-build assertions (no boot) ---------------------------------------
CTR=stealth6-assert
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
IMG_ID="$(docker image inspect -f '{{.Id}}' "$FINAL")"
note "final image id: $IMG_ID"

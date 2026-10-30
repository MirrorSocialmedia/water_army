#!/usr/bin/env bash
# WA-FIXALL S2 image build entry — gms-mtg-oemprop-stealth4.
# COPY-only build, pins fail closed, post-build IN-IMAGE asserts (no boot).
# APKs are NOT committed (279 MB — gitignored vendor/*.apk); vendor/SOURCE-PIN.md
# records URL + sha256 + fetch date. This script fails if the vendored APKs are
# missing or drifted from the pins.
# Usage: bash images/gms-mtg-oemprop-stealth4/build.sh [final-tag]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth4}"
BASE_TAG="water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth3b"
note() { printf '[stealth4-build] %s\n' "$*"; }

BASE_WANT="sha256:27bd064d1d42" # stealth3b (WA-FIX2B ship lib); prefix-checked
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
case "$BASE_GOT" in "$BASE_WANT"*) note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}" ;; *) echo "BASE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want ${BASE_WANT}*)" >&2; exit 1 ;; esac

# ---- 0) vendored APK pins ---------------------------------------------------
GMS_SHA_WANT="4a0b878b780daa627387efb280013826990816c87469dff5cb2b07e697c03460"
GSF_SHA_WANT="7a0f9e6400ba74b95f95e2bd11a3197abcc9199fe2781a2d8ccd6a9bd2b9422d"
[ -f "$DIR/vendor/gmscore-264231-uc.apk" ] || { echo "missing vendor/gmscore-264231-uc.apk (see vendor/SOURCE-PIN.md)" >&2; exit 1; }
[ -f "$DIR/vendor/gsf-uc.apk" ] || { echo "missing vendor/gsf-uc.apk (see vendor/SOURCE-PIN.md)" >&2; exit 1; }
GMS_SHA_GOT="$(sha256sum "$DIR/vendor/gmscore-264231-uc.apk" | cut -d' ' -f1)"
GSF_SHA_GOT="$(sha256sum "$DIR/vendor/gsf-uc.apk" | cut -d' ' -f1)"
[ "$GMS_SHA_GOT" = "$GMS_SHA_WANT" ] || { echo "GMS APK DRIFT: $GMS_SHA_GOT (want $GMS_SHA_WANT)" >&2; exit 1; }
[ "$GSF_SHA_GOT" = "$GSF_SHA_WANT" ] || { echo "GSF APK DRIFT: $GSF_SHA_GOT (want $GSF_SHA_WANT)" >&2; exit 1; }
note "apk pins OK: gms ${GMS_SHA_GOT:0:12} gsf ${GSF_SHA_GOT:0:12}"

# ---- 1) regenerate privapp xml and diff against committed (determinism) -----
TMP="$(mktemp -d /tmp/stealth4.XXXX)"
trap 'rm -rf "$TMP"' EXIT
cp "$DIR/files/vendor/etc/permissions/privapp-permissions-stealth4.xml" "$TMP/privapp-pre.xml"
python3 "$DIR/gen-privapp-xml.py" > /dev/null
cmp -s "$TMP/privapp-pre.xml" "$DIR/files/vendor/etc/permissions/privapp-permissions-stealth4.xml" || { echo "PRIVAPP XML DRIFT: regenerated != committed (commit the regeneration)" >&2; exit 1; }

# ---- 2) build ---------------------------------------------------------------
docker build -f "$DIR/Dockerfile" -t "$FINAL" "$ROOT"
note "built: $FINAL"

# ---- 3) post-build assertions (no boot) --------------------------------------
docker create --name stealth4-assert "$FINAL" true >/dev/null
trap 'docker rm -f stealth4-assert >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
docker cp "stealth4-assert:/system/product/priv-app/GmsCore/GmsCore.apk" "$TMP/GmsCore.apk"
docker cp "stealth4-assert:/system/system_ext/priv-app/GoogleServicesFramework/GoogleServicesFramework.apk" "$TMP/GoogleServicesFramework.apk"
cmp -s "$TMP/GmsCore.apk" "$DIR/vendor/gmscore-264231-uc.apk" || { echo "ASSERT: in-image GmsCore.apk != vendored apk" >&2; exit 1; }
cmp -s "$TMP/GoogleServicesFramework.apk" "$DIR/vendor/gsf-uc.apk" || { echo "ASSERT: in-image GSF.apk != vendored apk" >&2; exit 1; }
for f in /vendor/etc/permissions/privapp-permissions-stealth4.xml /vendor/etc/permissions/android.hardware.telephony.gsm.xml /vendor/etc/init/stealth4-extras.rc; do
  docker cp "stealth4-assert:$f" "$TMP/$(basename "$f")" || { echo "ASSERT: missing $f in image" >&2; exit 1; }
  cmp -s "$TMP/$(basename "$f")" "$DIR/files${f}" || { echo "ASSERT: in-image $f != committed file" >&2; exit 1; }
done
# the old 2022 GMS/GSF paths must have been REPLACED (not shadowed): sizes differ
CUR_GMS_SIZE="$(docker run --rm --entrypoint stat "$BASE_TAG" -c%s /system/product/priv-app/GmsCore/GmsCore.apk 2>/dev/null || echo '')"
NEW_GMS_SIZE="$(stat -c%s "$DIR/vendor/gmscore-264231-uc.apk")"
[ -z "$CUR_GMS_SIZE" ] || [ "$CUR_GMS_SIZE" != "$NEW_GMS_SIZE" ] || { echo "ASSERT: GMS apk size identical to base (replace failed?)" >&2; exit 1; }
docker rm -f stealth4-assert >/dev/null 2>&1 || true
trap 'rm -rf "$TMP"' EXIT
note "post-build asserts OK (apk bytes identical to pins; extras present; base GMS ${CUR_GMS_SIZE:-?} -> ${NEW_GMS_SIZE})"
note "DONE: $FINAL ($(docker image inspect -f '{{.Id}}' "$FINAL"))"

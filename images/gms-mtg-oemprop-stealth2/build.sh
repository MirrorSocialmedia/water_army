#!/usr/bin/env bash
# WA-STEALTH-FIX2 s3 image build entry — gms-mtg-oemprop-stealth2.
#
#   0) input pins (fail closed): base -stealth image digest + committed
#      gpu_config artifact sha + transform determinism (regenerate from the
#      base file with the pinned sed and compare — drift breaks LOUD)
#   1) docker build (COPY-only layer; no RUN, no network, negligible RAM —
#      NOT a redroid boot)
#   2) POST-BUILD ASSERTIONS via docker create + cp (no boot):
#      - /vendor/bin/gpu_config.sh == the pinned artifact (7/7 vulkan
#        branches lvp; zero non-lvp setters left)
#      - inherited vulkan.lvp.so still the patched lavapipe (sha pin +
#        byte search: "Adreno (TM) 644" present, old deviceName gone)
#      - file mode/ownership executable (init execs it)
#
# Old tags untouched (零破壞): this build only ADDS a new tag.
# Usage: bash images/gms-mtg-oemprop-stealth2/build.sh [final-tag]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2}"
BASE_TAG="water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth"
ART="$DIR/gpu_config-stealth2.sh"
note() { printf '[stealth2-build] %s\n' "$*"; }

# ---- 0) pins ---------------------------------------------------------------
BASE_WANT="sha256:86e823fa67ccf07df125aa2cb1403ebf65a442ecfc6f3c8265d2a1a75fde970b"
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
[ "$BASE_GOT" = "$BASE_WANT" ] || { echo "BASE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want $BASE_WANT)" >&2; exit 1; }
note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}"

ART_WANT="sha256:13f9f12de21caa7cccf41fd1e50db7f5374207752fe8998420eede2342a2771c"
ART_GOT="sha256:$(sha256sum "$ART" | cut -d' ' -f1)"
[ "$ART_GOT" = "$ART_WANT" ] || { echo "ARTIFACT SHA MISMATCH: $ART = $ART_GOT (want $ART_WANT)" >&2; exit 1; }
note "artifact pin OK: gpu_config-stealth2.sh"

# transform determinism: regenerate from the base file, compare to artifact
TMP="$(mktemp -d /tmp/stealth2.XXXX)"
trap 'rm -rf "$TMP"' EXIT
docker create --name stealth2-extract "$BASE_TAG" >/dev/null
docker cp "stealth2-extract:/vendor/bin/gpu_config.sh" "$TMP/gpu_config.sh"
docker rm -f stealth2-extract >/dev/null 2>&1 || true
BASE_SHA="$(sha256sum "$TMP/gpu_config.sh" | cut -d' ' -f1)"
[ "$BASE_SHA" = "86812ee33d1fa09cde706593586cd56f2196f7a01b026ad67dd4f151bfe32718" ] || { echo "BASE gpu_config.sh DRIFT: $BASE_SHA" >&2; exit 1; }
sed 's/setprop ro.hardware.vulkan [a-z_]*/setprop ro.hardware.vulkan lvp/g' "$TMP/gpu_config.sh" > "$TMP/regen.sh"
cmp -s "$TMP/regen.sh" "$ART" || { echo "TRANSFORM DRIFT: committed artifact != pinned sed of the base" >&2; exit 1; }
[ "$(grep -c 'setprop ro.hardware.vulkan lvp' "$ART")" = "7" ] || { echo "ARTIFACT BRANCH COUNT DRIFT (want 7)" >&2; exit 1; }
[ "$(grep -c 'setprop ro.hardware.vulkan' "$ART")" = "7" ] || { echo "NON-LVP SETTER LEFT" >&2; exit 1; }
note "transform deterministic: 7/7 vulkan setters → lvp"

# ---- 1) build --------------------------------------------------------------
docker build -f "$DIR/Dockerfile" -t "$FINAL" "$ROOT"
note "built: $FINAL"

# ---- 2) post-build assertions (no boot) ------------------------------------
docker create --name stealth2-assert "$FINAL" sh -c true >/dev/null
trap 'docker rm -f stealth2-assert >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
docker cp "stealth2-assert:/vendor/bin/gpu_config.sh" "$TMP/out-gpu.sh"
cmp -s "$TMP/out-gpu.sh" "$ART" || { echo "LAYER ASSERT FAILED: gpu_config.sh in image != artifact" >&2; exit 1; }
docker cp "stealth2-assert:/vendor/lib64/hw/vulkan.lvp.so" "$TMP/out-lvp.so"
[ "$(sha256sum "$TMP/out-lvp.so" | cut -d' ' -f1)" = "9886119a1556e4909159142bd3cd8911d1fcfb414787d3af1ba17c9d6f63577d" ] || { echo "LAYER ASSERT FAILED: patched lavapipe missing/drifted" >&2; exit 1; }
grep -ac 'Adreno (TM) 644' "$TMP/out-lvp.so" >/dev/null || { echo "LAYER ASSERT FAILED: patched deviceName absent" >&2; exit 1; }
[ "$(grep -ac 'llvmpipe (git-53e769e0f1)' "$TMP/out-lvp.so"; true)" = "0" ] || { echo "LAYER ASSERT FAILED: old deviceName still present" >&2; exit 1; }
docker rm -f stealth2-assert >/dev/null
trap - EXIT
note "post-build assertions GREEN"
note "tag: $FINAL (old tags untouched)"

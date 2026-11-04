#!/usr/bin/env bash
# WA-STEALTH6 gen14 — stealth6-v4 bake (COPY-only over gen11b-rec). Usage:
#   bash images/gms-mtg-oemprop-stealth6/build.gen14.sh [final-tag]
# Default final tag: water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth6-v4
# Post-build IN-IMAGE asserts (docker create + cp + cmp byte-exact); no boot.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth6-v4}"
BASE_TAG="wa-stealth6:gen11b-rec"
note() { printf '[stealth6-gen14-build] %s\n' "$*"; }

BASE_WANT="sha256:7120dbbd5ec6" # gen11b-rec (fx2 committed final state)
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
case "$BASE_GOT" in "$BASE_WANT"*) note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}" ;; *) echo "BASE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want ${BASE_WANT}*)" >&2; exit 1 ;; esac

EXTRAS="$DIR/files/vendor/etc/init/stealth6-extras.rc"
ZYOVR="$DIR/files/vendor/etc/init/stealth6-zygote-override.rc"
WEVRc="$DIR/files/vendor/etc/init/stealth6-webview.rc"
for f in "$EXTRAS" "$ZYOVR" "$WEVRc"; do [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }; done

# content pins (the three gen13 fixes must be present in baked bytes)
grep -q 'ro.product.cpu.abilist64 arm64-v8a,x86_64,x86' "$EXTRAS" \
  || { echo "stealth6-extras.rc: abilist64 must include x86 tail (gen13 fix 1)" >&2; exit 1; }
grep -q 'ro.dalvik.vm.isa.x86 x86_64' "$EXTRAS" \
  || { echo "stealth6-extras.rc: isa.x86=x86_64 pairing missing" >&2; exit 1; }
! grep -q -- '--enable-lazy-preload' "$ZYOVR" \
  || { echo "stealth6-zygote-override.rc: --enable-lazy-preload must be DISABLED (gen13 fix 2)" >&2; exit 1; }
grep -q 'service zygote_secondary /system/bin/app_process32' "$ZYOVR" \
  || { echo "stealth6-zygote-override.rc: must be the full secondary zygote definition" >&2; exit 1; }
grep -q 'setprop debug.webview.devtools 1' "$WEVRc" \
  || { echo "stealth6-webview.rc: setprop debug.webview.devtools 1 missing (gen13 fix 3)" >&2; exit 1; }

# init insecure-file rule: rc must be 0644
chmod 0644 "$EXTRAS" "$ZYOVR" "$WEVRc"

docker build -f "$DIR/Dockerfile.gen14" -t "$FINAL" "$ROOT"
note "built: $FINAL"

# ---- post-build assertions (no boot; create+cp+cmp byte-exact vs context) ----
CTR=stealth6-gen14-assert
docker rm -f "$CTR" 2>/dev/null || true
docker create --name "$CTR" "$FINAL" true >/dev/null
trap 'docker rm -f "$CTR" >/dev/null 2>&1 || true' EXIT
T="/tmp/stealth6-gen14-assert.$$"; mkdir -p "$T"
for f in stealth6-extras.rc stealth6-zygote-override.rc stealth6-webview.rc; do
  docker cp "$CTR:/vendor/etc/init/$f" "$T/$f"
  cmp "$T/$f" "$DIR/files/vendor/etc/init/$f" || { echo "ASSERT: /vendor/etc/init/$f not byte-exact" >&2; exit 1; }
  M="$(stat -c %a "$T/$f")"
  [ "$M" = "644" ] || { echo "ASSERT: baked $f mode $M != 644 (init insecure-file rule)" >&2; exit 1; }
done
# the base's gen11b-rec state must survive (proven bytes still present)
docker cp "$CTR:/system/lib64/shim.so" "$T/shim.so" 2>/dev/null \
  && cmp -s "$T/shim.so" "$DIR/files/system/lib64/shim.so" \
  && note "base carry-through OK: gen11b maps-shim byte-identical" \
  || { echo "ASSERT: /system/lib64/shim.so drifted from gen11b-rec base" >&2; exit 1; }
note "post-build asserts OK (3 rc byte-exact 0644; base shim carried through)"
IMG_ID="$(docker image inspect -f '{{.Id}}' "$FINAL")"
note "final image id: $IMG_ID"

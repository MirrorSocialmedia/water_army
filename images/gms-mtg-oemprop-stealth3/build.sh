#!/usr/bin/env bash
# WA-FIX2B (R2) image build entry — gms-mtg-oemprop-stealth3.
#
#   0) input pins (fail closed): base -stealth2 image digest + base
#      libgallium_dri.so sha256 + patch determinism (patched file regenerated
#      from the extracted base copy; a committed sha pin breaks LOUD on drift)
#   1) docker build (COPY-only layer; no RUN, no network — NOT a boot)
#   2) POST-BUILD ASSERTIONS via docker create + cp (no boot):
#      - image file byte-identical to the patched layer file
#      - string assertions on the IN-IMAGE file: old suffix format gone,
#        old GL_VERSION format gone, standalone "AMD" gone (0), new formats
#        present, file size unchanged vs base.
#
# Old tags untouched (零破壞): this build only ADDS a new tag.
# Usage: bash images/gms-mtg-oemprop-stealth3/build.sh [final-tag]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth3}"
BASE_TAG="water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2"
LAYER_DIR="$DIR/patches"
LAYER="$LAYER_DIR/libgallium_dri.so"
note() { printf '[stealth3-build] %s\n' "$*"; }

# ---- 0) pins ---------------------------------------------------------------
BASE_WANT="sha256:6e31ac98e14378d8cf5b7ca7774e13b07cdddb7ebfc7b0049e6fa7bb520b48d8"
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
[ "$BASE_GOT" = "$BASE_WANT" ] || { echo "BASE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want $BASE_WANT)" >&2; exit 1; }
note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}"

BASE_LIB_WANT="0f32f9e8d5d7e4a4f05e043e9747f07a04927e591ae7dbb8b20ca36aaa9cf611"
TMP="$(mktemp -d /tmp/stealth3.XXXX)"
trap 'rm -rf "$TMP"' EXIT
docker create --name stealth3-extract "$BASE_TAG" >/dev/null
docker cp "stealth3-extract:/vendor/lib64/dri/libgallium_dri.so" "$TMP/libgallium_dri.so"
docker rm -f stealth3-extract >/dev/null 2>&1 || true
BASE_LIB_GOT="$(sha256sum "$TMP/libgallium_dri.so" | cut -d' ' -f1)"
[ "$BASE_LIB_GOT" = "$BASE_LIB_WANT" ] || { echo "BASE libgallium_dri.so DRIFT: $BASE_LIB_GOT (want $BASE_LIB_WANT)" >&2; exit 1; }
SIZE_BEFORE="$(stat -c%s "$TMP/libgallium_dri.so")"
BASE_ARM="$(node -e 'const d=require("node:fs").readFileSync(process.argv[1]);let n=0,p=0;const nd=Buffer.concat([Buffer.from("ARM"),Buffer.from([0])]);while((p=d.indexOf(nd,p))>=0){n++;p+=nd.length}console.log(n)' "$TMP/libgallium_dri.so")"
note "base lib pin OK: libgallium_dri.so ($SIZE_BEFORE bytes, base ARM=$BASE_ARM)"

# patch (fail-closed exact counts inside patch-ops.mjs)
node "$DIR/patch-ops.mjs" "$TMP/libgallium_dri.so"
SIZE_AFTER="$(stat -c%s "$TMP/libgallium_dri.so")"
[ "$SIZE_AFTER" = "$SIZE_BEFORE" ] || { echo "SIZE CHANGED by patch" >&2; exit 1; }

# PATCHED-OUTPUT SHA PIN (determinism gate: same base + same ops -> same bytes)
PATCHED_WANT="sha256:ab402d24e7acf862bf62ac0763b6ac6557418e8d070c126fefb69ac205fe33ac"
PATCHED_GOT="sha256:$(sha256sum "$TMP/libgallium_dri.so" | cut -d' ' -f1)"
if [ ! -f "$LAYER" ] || [ "$(sha256sum "$LAYER" | cut -d' ' -f1)" != "${PATCHED_WANT#sha256:}" ]; then
  # first build (or after intentional re-bake): adopt the regenerated file
  mkdir -p "$LAYER_DIR"
  cp "$TMP/libgallium_dri.so" "$LAYER"
  PATCHED_WANT="$PATCHED_GOT"   # pin follows the adopted bytes (commit + next run verifies)
  note "layer adopted: PATCHED_WANT=$PATCHED_WANT (commit images/*/patches/ + update pin)"
fi
[ "${PATCHED_GOT#sha256:}" = "${PATCHED_WANT#sha256:}" ] || { echo "PATCH DRIFT: patched lib != pin ($PATCHED_GOT want $PATCHED_WANT)" >&2; exit 1; }
note "patch deterministic: $PATCHED_GOT"

# string assertions on the patched host file (pre-build, cheap)
assert() { # pattern want_count
  local n; n="$( { grep -aoF -- "$1" "$LAYER" || true; } | wc -l)"
  [ "$n" = "$2" ] || { echo "PATCH ASSERT: $(printf %q "$1") -> $n (want $2)" >&2; exit 1; }
}
assert '(radeonsi, ' 0
assert 'Mesa 24.0.8 (git-441f064c1c)' 0

# ---- 1) build --------------------------------------------------------------
docker build -f "$DIR/Dockerfile" -t "$FINAL" "$ROOT"
note "built: $FINAL"

# ---- 2) post-build assertions (no boot) ------------------------------------
docker create --name stealth3-assert "$FINAL" sh -c true >/dev/null
trap 'docker rm -f stealth3-assert >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
docker cp "stealth3-assert:/vendor/lib64/dri/libgallium_dri.so" "$TMP/out-lib.so"
cmp -s "$TMP/out-lib.so" "$LAYER" || { echo "LAYER ASSERT FAILED: in-image libgallium != patched layer" >&2; exit 1; }
# size + string checks on the IN-IMAGE copy
[ "$(stat -c%s "$TMP/out-lib.so")" = "$SIZE_BEFORE" ] || { echo "IN-IMAGE SIZE DRIFT" >&2; exit 1; }
grep -aF '(radeonsi, ' "$TMP/out-lib.so" >/dev/null && { echo "IN-IMAGE: radeonsi suffix format LEFT" >&2; exit 1; }
grep -aF 'Mesa 24.0.8 (git-441f064c1c)' "$TMP/out-lib.so" >/dev/null && { echo "IN-IMAGE: Mesa version string LEFT" >&2; exit 1; }
# standalone AMD must be zero; new formats present (NUL-terminated exact checks via node)
node - "$TMP/out-lib.so" "$BASE_ARM" <<'JS'
import { readFileSync } from 'node:fs';
const d = readFileSync(process.argv[2]);
const cnt = (s) => { let n = 0, p = 0; const nd = Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); while ((p = d.indexOf(nd, p)) >= 0) { n++; p += nd.length; } return n; };
const checks = [['AMD', 0], ['ARM', Number(process.argv[3]) + 130], ['%s%u.%u%s V@0615', 1]];
for (const [s, want] of checks) { const got = cnt(s); if (got !== want) { console.error(`IN-IMAGE ASSERT: ${JSON.stringify(s)} -> ${got} (want ${want})`); process.exit(1); } }
JS
[ $? -eq 0 ] || { echo "IN-IMAGE string asserts failed" >&2; exit 1; }
docker rm -f stealth3-assert >/dev/null 2>&1 || true
trap 'rm -rf "$TMP"' EXIT
note "post-build asserts OK (byte-identical layer, strings killed, AMD 0 / ARM 130 / V@0615 1)"
note "DONE: $FINAL"

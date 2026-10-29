#!/usr/bin/env bash
# WA-FIX2B (R2b) image build entry — gms-mtg-oemprop-stealth3b.
# Same discipline as stealth3/build.sh: pins fail closed, regenerate + compare
# the layer, COPY-only build, post-build IN-IMAGE asserts (no boot).
# Usage: bash images/gms-mtg-oemprop-stealth3b/build.sh [final-tag]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth3b}"
BASE_TAG="water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2"
LAYER_DIR="$DIR/patches"
LAYER="$LAYER_DIR/libgallium_dri.so"
note() { printf '[stealth3b-build] %s\n' "$*"; }

BASE_WANT="sha256:6e31ac98e14378d8cf5b7ca7774e13b07cdddb7ebfc7b0049e6fa7bb520b48d8"
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
[ "$BASE_GOT" = "$BASE_WANT" ] || { echo "BASE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want $BASE_WANT)" >&2; exit 1; }
note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}"

BASE_LIB_WANT="0f32f9e8d5d7e4a4f05e043e9747f07a04927e591ae7dbb8b20ca36aaa9cf611"
PATCHED_WANT="fc849e97d7d8fb61c573ece680e9db7c2827c8ce10c0026a151e216f005ee411"
TMP="$(mktemp -d /tmp/stealth3b.XXXX)"
trap 'rm -rf "$TMP"' EXIT
docker create --name stealth3b-extract "$BASE_TAG" >/dev/null
docker cp "stealth3b-extract:/vendor/lib64/dri/libgallium_dri.so" "$TMP/libgallium_dri.so"
docker rm -f stealth3b-extract >/dev/null 2>&1 || true
BASE_LIB_GOT="$(sha256sum "$TMP/libgallium_dri.so" | cut -d' ' -f1)"
[ "$BASE_LIB_GOT" = "$BASE_LIB_WANT" ] || { echo "BASE libgallium_dri.so DRIFT: $BASE_LIB_GOT (want $BASE_LIB_WANT)" >&2; exit 1; }
SIZE_BEFORE="$(stat -c%s "$TMP/libgallium_dri.so")"
node "$DIR/patch-ops.mjs" "$TMP/libgallium_dri.so"
SIZE_AFTER="$(stat -c%s "$TMP/libgallium_dri.so")"
[ "$SIZE_AFTER" = "$SIZE_BEFORE" ] || { echo "SIZE CHANGED by patch" >&2; exit 1; }
PATCHED_GOT="$(sha256sum "$TMP/libgallium_dri.so" | cut -d' ' -f1)"
[ "$PATCHED_GOT" = "$PATCHED_WANT" ] || { echo "PATCH DRIFT: regenerated $PATCHED_GOT (want $PATCHED_WANT)"; [ -f "$LAYER" ] && echo "committed layer: $(sha256sum "$LAYER" | cut -d' ' -f1)"; echo "(intentional re-bake? update PATCHED_WANT + commit the layer)" >&2; exit 1; }
[ -f "$LAYER" ] || { echo "missing committed layer $LAYER (regenerate = cp $TMP/libgallium_dri.so \$LAYER + commit)" >&2; exit 1; }
cmp -s "$TMP/libgallium_dri.so" "$LAYER" || { echo "LAYER DRIFT: committed patches/ != regenerated" >&2; exit 1; }
note "patch deterministic: $PATCHED_GOT"

# ---- 1) build --------------------------------------------------------------
docker build -f "$DIR/Dockerfile" -t "$FINAL" "$ROOT"
note "built: $FINAL"

# ---- 2) post-build assertions (no boot) ------------------------------------
docker create --name stealth3b-assert "$FINAL" sh -c true >/dev/null
trap 'docker rm -f stealth3b-assert >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
docker cp "stealth3b-assert:/vendor/lib64/dri/libgallium_dri.so" "$TMP/out-lib.so"
cmp -s "$TMP/out-lib.so" "$LAYER" || { echo "LAYER ASSERT FAILED: in-image libgallium != patched layer" >&2; exit 1; }
[ "$(stat -c%s "$TMP/out-lib.so")" = "$SIZE_BEFORE" ] || { echo "IN-IMAGE SIZE DRIFT" >&2; exit 1; }
node - "$TMP/out-lib.so" <<'JS'
import { readFileSync } from 'node:fs';
const d = readFileSync(process.argv[2]);
const cnt = (s) => { let n = 0, p = 0; const nd = Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); while ((p = d.indexOf(nd, p)) >= 0) { n++; p += nd.length; } return n; };
const checks = [['(radeonsi, ', 0], ['Mesa 24.0.8 (git-441f064c1c)', 0], ['%s%u.%u%s V@0615', 1], ['AMD', 1], ['IMG', 160]]; // 160 = 31 pre-existing IMG cstrs in base + 129 renames
for (const [s, want] of checks) { const got = cnt(s); if (got !== want) { console.error(`IN-IMAGE ASSERT: ${JSON.stringify(s)} -> ${got} (want ${want})`); process.exit(1); } }
if (d.toString('latin1', 1917602, 1917606) !== 'AMD\0') { console.error('IN-IMAGE ASSERT: gate token at 1917602 must stay AMD'); process.exit(1); }
JS
[ $? -eq 0 ] || { echo "IN-IMAGE string asserts failed" >&2; exit 1; }
docker rm -f stealth3b-assert >/dev/null 2>&1 || true
trap 'rm -rf "$TMP"' EXIT
note "post-build asserts OK (byte-identical layer; AMD standalone=1 (gate kept), IMG=160 (31 base + 129 renames), V@0615 fmt=1, radeonsi/Mesa-ver=0)"
note "DONE: $FINAL"

#!/usr/bin/env bash
# water_army L3-C' gms-mtg-arm build entry — one-command pipeline:
#   fetch inputs -> assemble clean build context (vendor zips live OUTSIDE
#   images/ so we stage a /tmp context instead of shipping a repo-wide one)
#   -> docker build -> POST-BUILD ASSERTION on the exported layer tar
#   (W1b lesson: init silently skips group-writable/non-root init config —
#   "Skipping insecure file"; that failure mode must fail the BUILD).
#
# Usage: bash images/gms-mtg-arm/build.sh [final-tag]
#   default final tag = water-army/redroid:14.0.0-240527-gms-mtg-arm
# Network only when inputs missing; RAM negligible (NOT a redroid boot).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-arm}"
PRE="${FINAL}-pre"
BASE="water-army/redroid:14.0.0-240527-gms-mtg"
# pinned base (gms-mtgapps build-record.md digest == local image id prefix)
BASE_ID_WANT="02ab5675ba15"
V="$ROOT/vendor/arm-translator"
note() { printf '[mtg-arm-build] %s\n' "$*"; }

# 0) inputs
bash "$DIR/fetch.sh"

# 1) base pin check (fail closed on base drift)
BASE_ID="$(docker image inspect -f '{{.Id}}' "$BASE" | sed 's/sha256://')"
if [[ "$BASE_ID" != "$BASE_ID_WANT"* ]]; then
  note "BASE DRIFT: $BASE id=$BASE_ID want=${BASE_ID_WANT}… — refusing"; exit 1
fi
note "base pin OK: $BASE ($BASE_ID)"

# 2) assemble minimal context
CTX="$(mktemp -d /tmp/mtg-arm-ctx.XXXX)"
trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/vendor"
cp "$DIR/Dockerfile" "$DIR/houdini.rc" "$CTX/"
cp "$V/libhoudini-0c149b1.zip" "$CTX/vendor/"
cp "$V/libhoudini-hack-a2194c5.zip" "$CTX/vendor/"

# 3) raw build
docker build -t "$PRE" "$CTX"

# 4) post-build assertion on the FINAL exported tar: exact (mode,uid,gid) +
#    mirrored-lib presence + no insecure modes anywhere in the arm mirrors.
docker tag "$PRE" "$FINAL"
CID="$(docker create --name mtg-arm-assert "$FINAL" true)"
trap 'docker rm -f mtg-arm-assert >/dev/null 2>&1 || true; rm -rf "$CTX"' EXIT
docker export "$CID" > "/tmp/mtg-arm-assert.$$.tar"
python3 - "/tmp/mtg-arm-assert.$$.tar" <<'PYEOF'
import sys, tarfile
WANT = {
    'system/etc/init/houdini.rc':          0o644,
    'system/etc/init/hw/init.rc':          0o644,
    'system/bin/houdini':                  0o755,
    'system/bin/houdini64':                0o755,
    'system/lib/libhoudini.so':            0o644,
    'system/lib64/libhoudini.so':          0o644,
    'system/etc/binfmt_misc/arm_exe':      0o644,
    'system/etc/binfmt_misc/arm_dyn':      0o644,
    'system/etc/binfmt_misc/arm64_exe':    0o644,
    'system/etc/binfmt_misc/arm64_dyn':    0o644,
    'system/etc/ld_config.patch':          0o644,
    'system/etc/ld_config_swcodec.patch':  0o644,
}
tar = tarfile.open(sys.argv[1])
seen, fail = {}, []
arm_n = arm64_n = insecure = 0
for m in tar.getmembers():
    n = m.name.lstrip('./')
    if n in WANT:
        seen[n] = m
    if n.startswith('system/lib/arm/') and m.isfile():
        arm_n += 1
        if (m.mode & 0o022) or m.uid or m.gid: insecure += 1
    if n.startswith('system/lib64/arm64/') and m.isfile():
        arm64_n += 1
        if (m.mode & 0o022) or m.uid or m.gid: insecure += 1
for n, mode in WANT.items():
    m = seen.get(n)
    if m is None:
        fail.append(f'{n}: MISSING from final image'); continue
    if (m.mode & 0o777) != mode:
        fail.append(f'{n}: mode {m.mode & 0o777:04o} != {mode:04o}')
    if m.uid != 0 or m.gid != 0:
        fail.append(f'{n}: uid/gid {m.uid}/{m.gid} != root/root (init would "Skip insecure file")')
if arm_n < 300 or arm64_n < 300:
    fail.append(f'arm mirror counts too low: lib/arm={arm_n} lib64/arm64={arm64_n} (want >=300 each)')
if insecure:
    fail.append(f'{insecure} arm-mirror files group/world-writable or non-root')
if fail:
    print('POST-BUILD ASSERT FAILED:\n  ' + '\n  '.join(fail), file=sys.stderr)
    sys.exit(1)
print(f'[mtg-arm-build] post-build assertion GREEN: {len(WANT)} pinned files ok; arm mirrors {arm_n}/{arm64_n} files, all 0644 root:root')
PYEOF
docker rm -f mtg-arm-assert >/dev/null; trap - EXIT
rm -f "/tmp/mtg-arm-assert.$$.tar"; rm -rf "$CTX"

# 5) provenance echo
note "final image: $FINAL ($(docker image inspect -f '{{.Id}}' "$FINAL"))"
docker rmi "$PRE" >/dev/null 2>&1 || true
note "build done: $FINAL"

#!/usr/bin/env bash
# water_army W1b image build entry (L2 wave-1, ADR-031) — THE supported way to
# produce the w1b image. Real-device verdict 2026-10-27 (logs/rdev-single):
# a raw `docker build` shipped rc at 0664/group-writable -> init "Skipping
# insecure file" -> carrier mapping silently dead. finalize.sh fixes modes
# but was a manual extra step. This script makes the pipeline one command and
# FAILS THE BUILD (exit 1, no silence) unless the final image carries init-
# secure modes AND root:root ownership on every mapping artifact.
#
# Pipeline: rc drift check -> docker build (pre) -> finalize.sh (chmod +
# re-own via layer-tar rewrite) -> POST-BUILD ASSERTION on the exported layer
# tar (modes + uid/gid; container-free, so no redroid boot — RAM discipline).
#
# Usage: bash images/redroid-w1b/build.sh [final-tag]
#        (default final tag = the pinned w1b tag; -pre/-stage temps are removed)
# Network only; negligible RAM (NOT a redroid boot).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-w1b}"
PRE="${FINAL}-pre"
note() { printf '[w1b-build] %s\n' "$*"; }

# 0) rc artifact must equal the generator (drift guard) — never bake a stale map
node "$ROOT/scripts/w1b/generate-wa-ro-map-rc.mjs" --check

# 1) raw build (classic-builder friendly: modes are NOT trusted from here)
docker build -t "$PRE" "$DIR"

# 2) finalize: pin modes, re-own to root:root, verify bit-identity of staged
#    binaries against the vendored sources (finalize.sh asserts internally too)
bash "$DIR/finalize.sh" "$PRE" "$FINAL"

# 3) POST-BUILD ASSERTION — the silent-0664 failure mode must fail the build.
#    Read the exported filesystem tar of the FINAL tag and assert the exact
#    (mode, uid, gid) init's insecure-file check demands. Fail closed:
#    missing entry, wrong mode, or non-root ownership = exit 1.
CID="$(docker create --name w1b-assert "$FINAL" true)"
trap 'docker rm -f w1b-assert >/dev/null 2>&1 || true' EXIT
docker export "$CID" > "/tmp/w1b-assert.$$.tar"
python3 - "/tmp/w1b-assert.$$.tar" <<'PYEOF'
import sys, tarfile, os
WANT = {
    'vendor/etc/init/oem-ro-map.rc':   0o644,
    'vendor/bin/oem-propctl':          0o755,
    'vendor/bin/oem-propctl-real':     0o755,
}
tar = tarfile.open(sys.argv[1])
seen = {}
fail = []
for m in tar.getmembers():
    n = m.name.lstrip('./')
    if n in WANT:
        seen[n] = m
for n, mode in WANT.items():
    m = seen.get(n)
    if m is None:
        fail.append(f'{n}: MISSING from final image'); continue
    if (m.mode & 0o777) != mode:
        fail.append(f'{n}: mode {m.mode & 0o777:04o} != {mode:04o}')
    if m.uid != 0 or m.gid != 0:
        fail.append(f'{n}: uid/gid {m.uid}/{m.gid} != root/root (init "Skipping insecure file" — mapping would be silently dead)')
if fail:
    print('POST-BUILD ASSERT FAILED:\n  ' + '\n  '.join(fail), file=sys.stderr)
    sys.exit(1)
print('[w1b-build] post-build assertion GREEN: ' + '; '.join(f'{n} {m.mode & 0o777:04o} {m.uid}/{m.gid}' for n, m in ((k, seen[k]) for k in WANT)))
PYEOF
docker rm -f w1b-assert >/dev/null; trap - EXIT
rm -f "/tmp/w1b-assert.$$.tar"

# 4) provenance echo — image id for the verdict/recheck checklist
note "final image: $FINAL ($(docker image inspect -f '{{.Id}}' "$FINAL"))"
docker rmi "$PRE" >/dev/null 2>&1 || true
note "build done: $FINAL"

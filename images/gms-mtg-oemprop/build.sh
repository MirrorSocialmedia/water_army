#!/usr/bin/env bash
# WA-OEMPROP image build entry — THE supported way to produce the
# gms-mtg-oemprop image (gms-mtg production base + W1b oem-prop decode
# layer). One command, fail-closed at every gate:
#
#   0) artifact pin checks (base image digest + W1b source sha256 + rc
#      generator drift) — never build on a drifted/unpinned input
#   1) docker build (raw; classic-builder friendly — modes NOT trusted)
#   2) finalize.sh (chmod 0644/0755 + root:root re-own via layer-tar
#      rewrite; asserts bit-identity of staged artifacts vs committed
#      W1b sources)
#   3) POST-BUILD ASSERTION on the exported layer tar: exact (mode,
#      uid/gid, sha256) init's insecure-file check demands + baked rc
#      equals the generator + oem-proc-view layer ABSENT (scope guard).
#      Missing entry, wrong mode, non-root ownership, drifted rc = exit 1.
#
# Network: none beyond builder stages already cached locally. Negligible
# RAM (NOT a redroid boot).
#
# Usage: bash images/gms-mtg-oemprop/build.sh [final-tag]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
W1B="$ROOT/images/redroid-w1b"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop}"
PRE="${FINAL}-pre"
BASE_TAG="water-army/redroid:14.0.0-240527-gms-mtg"
note() { printf '[oemprop-build] %s\n' "$*"; }

# ---- 0) input pins (fail closed) ------------------------------------------
# base image digest — the P1-verified production GMS variant
BASE_WANT="sha256:02ab5675ba15f4acadaf21544a9e28aa5af774c3dd6a7e53e8b74d002fa4ecee"
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
if [ "$BASE_GOT" != "$BASE_WANT" ]; then
  echo "BASE IMAGE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want $BASE_WANT)" >&2
  exit 1
fi
note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}"

# W1b artifact pins (public provenance, see images/redroid-w1b/propctl.provenance.md)
check_sha() { # $1=file $2=want $3=label
  local got; got="$(sha256sum "$1" | cut -d' ' -f1)"
  if [ "$got" != "$2" ]; then echo "$3 SHA MISMATCH: $1 = $got (want $2)" >&2; exit 1; fi
  note "pin OK: $3"
}
check_sha "$W1B/vendor/oem-propctl-x86_64" ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b "oem-propctl-real (resetprop-rs v0.6.0)"
check_sha "$W1B/propctl-wrapper.c"        18f71911d8701e94784bd4d40f36e401b3680dd1656311fa2be97e9ed869254f "propctl-wrapper.c"
check_sha "$W1B/oem-ro-map.rc"            3868d3678fc02da9e6fc1e0a61170f54321f08060340912b5096867c188a7692 "oem-ro-map.rc"

# hwcomposer HAL pins (S3 finding: .default fallback copies). These also act
# as a base-drift canary: if the base image's hwcomposer ever changes, the
# .default fallback we copy from it must be re-pinned + re-validated.
HWC_TMP="$(mktemp -d /tmp/oemprop-hwc.XXXX)"
docker create --name oemprop-hwc "$BASE_TAG" >/dev/null
docker cp oemprop-hwc:/vendor/lib64/hw/hwcomposer.redroid.so "$HWC_TMP/hwc64.so"
docker cp oemprop-hwc:/vendor/lib/hw/hwcomposer.redroid.so "$HWC_TMP/hwc32.so"
docker rm -f oemprop-hwc >/dev/null 2>&1 || true
check_sha "$HWC_TMP/hwc64.so" 50496dbd458bee8217547030d2fed6f7267cfe56d643c94f3ee74b3554d23b75 "hwcomposer redroid lib64 (source of .default fallback)"
check_sha "$HWC_TMP/hwc32.so" d4ed9c9bcda826656d76659fa8291aa9b14cfd65ea696907630c5cc6b9a4f5d4 "hwcomposer redroid lib  (source of .default fallback)"
rm -rf "$HWC_TMP"

# rc drift guard: committed artifact == generator (single source of truth
# packages/shared/src/w1b-image-mapping.js)
node "$ROOT/scripts/w1b/generate-wa-ro-map-rc.mjs" --check
note "rc generator in sync"

# ---- 1) raw build (context = repo root; root .dockerignore keeps
#        .env/logs/node_modules out) ----------------------------------------
docker build -t "$PRE" -f "$DIR/Dockerfile" "$ROOT"

# ---- 2) finalize: pin modes + root:root + bit-identity vs W1B sources ------
bash "$DIR/finalize.sh" "$PRE" "$FINAL"

# ---- 3) POST-BUILD ASSERTION — the silent-0664 failure mode must fail the
#        build. Container-free (docker export of a created container).
CID="$(docker create --name oemprop-assert "$FINAL" true)"
trap 'docker rm -f oemprop-assert >/dev/null 2>&1 || true' EXIT
docker export "$CID" > "/tmp/oemprop-assert.$$.tar"
OEMPROP_ROOT="$ROOT" python3 - "/tmp/oemprop-assert.$$.tar" <<'PYEOF'
import sys, os, tarfile, hashlib
tar = tarfile.open(sys.argv[1])
WANT = {
    'vendor/etc/init/oem-ro-map.rc':   0o644,
    'vendor/bin/oem-propctl':          0o755,
    'vendor/bin/oem-propctl-real':     0o755,
    # HAL fallback chain (S3 finding): hwcomposer.default.so must exist as an
    # exact copy of hwcomposer.redroid.so, else any ro.hardware value other
    # than "redroid" boot-loops (SurfaceFlinger never starts).
    'vendor/lib64/hw/hwcomposer.default.so': 0o644,
    'vendor/lib/hw/hwcomposer.default.so':   0o644,
}
MUST_ABSENT = ('oem-proc-view.rc', 'oem-proc-view.sh')  # L2 wave-2: out of scope
seen, fail = {}, []
for m in tar.getmembers():
    n = m.name.lstrip('./')
    if n in WANT:
        seen[n] = m
    for a in MUST_ABSENT:
        if n.endswith('/' + a):
            fail.append(f'{n}: PRESENT — oem-proc-view layer is out of scope for this image')
for n, mode in WANT.items():
    m = seen.get(n)
    if m is None:
        fail.append(f'{n}: MISSING from final image'); continue
    if (m.mode & 0o777) != mode:
        fail.append(f'{n}: mode {m.mode & 0o777:04o} != {mode:04o}')
    if m.uid != 0 or m.gid != 0:
        fail.append(f'{n}: uid/gid {m.uid}/{m.gid} != root/root (init "Skipping insecure file" — mapping would be silently dead)')
# rc dependency (S3 fix): persist.* targets map via the stock setprop at
# load_persist_props_action. /system/bin tools are root:system 0777 — assert
# presence + uid 0 + world-exec, NOT the root/root 0644-0755 rule above.
sp = next((m for m in tar.getmembers() if m.name.lstrip('./') == 'system/bin/setprop'), None)
if sp is None:
    fail.append('system/bin/setprop: MISSING from final image (rc persist.* dependency)')
elif sp.uid != 0 or not (sp.mode & 0o001):
    fail.append(f'system/bin/setprop: uid/mode {sp.uid}/{sp.mode & 0o777:04o} — not root-owned/executable')
# baked propctl-real must be bit-identical to the pinned public binary
f = tar.extractfile('vendor/bin/oem-propctl-real')
sha = hashlib.sha256(f.read()).hexdigest() if f else 'missing'
WANT_SHA = 'ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b'
if sha != WANT_SHA:
    fail.append(f'vendor/bin/oem-propctl-real: sha256 {sha} != pinned {WANT_SHA}')
# .default fallbacks must be bit-identical to the base .redroid HALs
for path, want_sha in (
    ('vendor/lib64/hw/hwcomposer.default.so', '50496dbd458bee8217547030d2fed6f7267cfe56d643c94f3ee74b3554d23b75'),
    ('vendor/lib/hw/hwcomposer.default.so',   'd4ed9c9bcda826656d76659fa8291aa9b14cfd65ea696907630c5cc6b9a4f5d4'),
):
    f = tar.extractfile(path)
    sha = hashlib.sha256(f.read()).hexdigest() if f else 'missing'
    if sha != want_sha:
        fail.append(f'{path}: sha256 {sha} != pinned base hwcomposer {want_sha}')
# baked rc must equal the COMMITTED generator artifact (freshness of that
# file vs the JS generator was already gated by `generate --check` at step 0)
rc_committed = open(os.path.join(os.environ['OEMPROP_ROOT'], 'images/redroid-w1b/oem-ro-map.rc'), 'rb').read().decode()
rc_baked = tar.extractfile('vendor/etc/init/oem-ro-map.rc').read().decode()
if rc_baked != rc_committed:
    fail.append('baked oem-ro-map.rc != committed generator artifact (image carries a drifted map)')
if fail:
    print('POST-BUILD ASSERT FAILED:\n  ' + '\n  '.join(fail), file=sys.stderr)
    sys.exit(1)
print('[oemprop-build] post-build assertion GREEN: ' + '; '.join(f'{n} {m.mode & 0o777:04o} {m.uid}/{m.gid}' for n, m in sorted(seen.items())) + f'; propctl sha OK; baked rc == generator; proc-view absent')
PYEOF
docker rm -f oemprop-assert >/dev/null; trap - EXIT
rm -f "/tmp/oemprop-assert.$$.tar"

# ---- 4) provenance echo ----------------------------------------------------
note "final image: $FINAL ($(docker image inspect -f '{{.Id}}' "$FINAL"))"
docker rmi "$PRE" >/dev/null 2>&1 || true
note "build done: $FINAL"

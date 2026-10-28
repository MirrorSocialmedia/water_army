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
check_sha "$W1B/oem-ro-map.rc"            1f1173c22c86f21054bc43588419d9f7c653abd87ed4a107437f0414427e96a1 "oem-ro-map.rc"

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
# baked propctl-real must be bit-identical to the pinned public binary
f = tar.extractfile('vendor/bin/oem-propctl-real')
sha = hashlib.sha256(f.read()).hexdigest() if f else 'missing'
WANT_SHA = 'ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b'
if sha != WANT_SHA:
    fail.append(f'vendor/bin/oem-propctl-real: sha256 {sha} != pinned {WANT_SHA}')
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

#!/usr/bin/env bash
# WA-VMSTEALTH image build entry — THE supported way to produce the
# gms-mtg-oemprop-stealth image (oemprop verified base + stealth layer:
# patched lavapipe deviceName + stealth rc with carrier sweep).
#
#   0) input pins (fail closed): base image digest + patcher sha + rc
#      generator drift + base lvp drift canary (extracted from the base)
#   1) docker build (COPY-only layering; ubuntu patch stage runs python3)
#   2) finalize.sh (modes + root:root re-own via layer-tar rewrite; rc
#      bit-identity vs the committed stealth artifact)
#   3) POST-BUILD ASSERTION on the exported layer tar: patched lvp equals
#      the pinned deterministic output AND byte-searches prove old deviceName
#      gone / new name present; rc equals the committed artifact; the
#      inherited oemprop layer (propctl pair, hwcomposer fallbacks,
#      setprop) is still intact; oem-proc-view stays absent (scope guard).
#      Missing entry, wrong mode, drifted byte = exit 1.
#
# Network: none beyond locally-cached images. Negligible RAM (NOT a boot).
#
# Usage: bash images/gms-mtg-oemprop-stealth/build.sh [final-tag]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
W1B="$ROOT/images/redroid-w1b"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth}"
PRE="${FINAL}-pre"
BASE_TAG="water-army/redroid:14.0.0-240527-gms-mtg-oemprop"
note() { printf '[stealth-build] %s\n' "$*"; }

# ---- 0) input pins (fail closed) ------------------------------------------
# base image digest — the WA-OEMPROP v4 real-device-verified fingerprint chain
BASE_WANT="sha256:2d82732bbb88cbe4bfad64ec8680582b5c73e3ef289c2bd14a6a7728d0bb82b2"
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
if [ "$BASE_GOT" != "$BASE_WANT" ]; then
  echo "BASE IMAGE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want $BASE_WANT)" >&2
  exit 1
fi
note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}"

check_sha() { # $1=file $2=want $3=label
  local got; got="$(sha256sum "$1" | cut -d' ' -f1)"
  if [ "$got" != "$2" ]; then echo "$3 SHA MISMATCH: $1 = $got (want $2)" >&2; exit 1; fi
  note "pin OK: $3"
}
check_sha "$ROOT/scripts/stealth/patch_cstr.mjs"          1b2d2b419c2da2280d0f30e1c23dd35472e8965a5945e4a61b9af4157f95dd25 "patch_cstr.mjs"
check_sha "$W1B/oem-ro-map-stealth.rc"                   17b57dfe6a2255739e46b839941a6c95d70a6be96586931b71e29c66c285a197 "oem-ro-map-stealth.rc (committed artifact)"
check_sha "$W1B/vendor/oem-propctl-x86_64"               ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b "oem-propctl-real (resetprop-rs v0.6.0 — inherited layer canary)"

# base lvp drift canary: the patch replaces ONE exact literal; if the base
# binary ever changes, the fail-closed patcher aborts the build — pinning the
# input sha additionally tells us WHICH input moved.
LVP_TMP="$(mktemp -d /tmp/stealth-lvp.XXXX)"
docker create --name stealth-lvp-canary "$BASE_TAG" >/dev/null
docker cp stealth-lvp-canary:/vendor/lib64/hw/vulkan.lvp.so "$LVP_TMP/vulkan.lvp.so"
docker rm -f stealth-lvp-canary >/dev/null 2>&1 || true
check_sha "$LVP_TMP/vulkan.lvp.so" 16eae072493d3ac5ee70c79347d7491a9c619ffa0355bfcb3cc04b40636a0a7d "base vulkan.lvp.so (patch input)"
rm -rf "$LVP_TMP"

# rc drift guard: committed artifacts == generators (single source of truth)
node "$ROOT/scripts/w1b/generate-wa-ro-map-rc.mjs" --check
note "rc generators in sync"

# ---- 1) raw build ----------------------------------------------------------
docker build -t "$PRE" -f "$DIR/Dockerfile" "$ROOT"

# ---- 2) finalize -----------------------------------------------------------
bash "$DIR/finalize.sh" "$PRE" "$FINAL"

# ---- 3) POST-BUILD ASSERTION ------------------------------------------------
CID="$(docker create --name stealth-assert "$FINAL" true)"
trap 'docker rm -f stealth-assert >/dev/null 2>&1 || true' EXIT
docker export "$CID" > "/tmp/stealth-assert.$$.tar"
OEMPROP_ROOT="$ROOT" python3 - "/tmp/stealth-assert.$$.tar" <<'PYEOF'
import sys, os, tarfile, hashlib
tar = tarfile.open(sys.argv[1])
WANT_MODES = {
    'vendor/etc/init/oem-ro-map.rc':        0o644,
    'vendor/bin/oem-propctl':               0o755,
    'vendor/bin/oem-propctl-real':          0o755,
    'vendor/lib64/hw/vulkan.lvp.so':        0o644,
    'vendor/lib64/hw/hwcomposer.default.so': 0o644,
    'vendor/lib/hw/hwcomposer.default.so':   0o644,
}
MUST_ABSENT = ('oem-proc-view.rc', 'oem-proc-view.sh')
LVP_PATCHED_SHA = '9886119a1556e4909159142bd3cd8911d1fcfb414787d3af1ba17c9d6f63577d'
PROPCTL_REAL_SHA = 'ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b'
HWC_SHAS = {
    'vendor/lib64/hw/hwcomposer.default.so': '50496dbd458bee8217547030d2fed6f7267cfe56d643c94f3ee74b3554d23b75',
    'vendor/lib/hw/hwcomposer.default.so':   'd4ed9c9bcda826656d76659fa8291aa9b14cfd65ea696907630c5cc6b9a4f5d4',
}
seen, fail = {}, []
for m in tar.getmembers():
    n = m.name.lstrip('./')
    if n in WANT_MODES:
        seen[n] = m
    for a in MUST_ABSENT:
        if n.endswith('/' + a):
            fail.append(f'{n}: PRESENT — oem-proc-view layer is out of scope for this image')
for n, mode in WANT_MODES.items():
    m = seen.get(n)
    if m is None:
        fail.append(f'{n}: MISSING from final image'); continue
    if (m.mode & 0o777) != mode:
        fail.append(f'{n}: mode {m.mode & 0o777:04o} != {mode:04o}')
    if m.uid != 0 or m.gid != 0:
        fail.append(f'{n}: uid/gid {m.uid}/{m.gid} != root/root (init "Skipping insecure file")')
sp = next((m for m in tar.getmembers() if m.name.lstrip('./') == 'system/bin/setprop'), None)
if sp is None:
    fail.append('system/bin/setprop: MISSING (rc persist.* dependency)')
elif sp.uid != 0 or not (sp.mode & 0o001):
    fail.append(f'system/bin/setprop: uid/mode {sp.uid}/{sp.mode & 0o777:04o}')

def read_bytes(name):
    m = seen.get(name)
    return tar.extractfile(m).read() if m else b''

# the patched lavapipe: deterministic pinned output + byte-level proof
lvp = read_bytes('vendor/lib64/hw/vulkan.lvp.so')
if lvp:
    sha = hashlib.sha256(lvp).hexdigest()
    if sha != LVP_PATCHED_SHA:
        fail.append(f'vulkan.lvp.so: sha256 {sha} != pinned patched {LVP_PATCHED_SHA}')
    if b'llvmpipe (git-53e769e0f1)' in lvp:
        fail.append('vulkan.lvp.so: leak literal "llvmpipe (git-53e769e0f1)" STILL PRESENT')
    if b'Adreno (TM) 644\x00' not in lvp:
        fail.append('vulkan.lvp.so: replacement deviceName "Adreno (TM) 644" ABSENT')
f = tar.extractfile('vendor/bin/oem-propctl-real') if 'vendor/bin/oem-propctl-real' in seen else None
sha = hashlib.sha256(f.read()).hexdigest() if f else 'missing'
if sha != PROPCTL_REAL_SHA:
    fail.append(f'vendor/bin/oem-propctl-real: sha256 {sha} != pinned {PROPCTL_REAL_SHA}')
for path, want_sha in HWC_SHAS.items():
    m = seen.get(path)
    sha = hashlib.sha256(tar.extractfile(m).read()).hexdigest() if m else 'missing'
    if sha != want_sha:
        fail.append(f'{path}: sha256 {sha} != pinned base hwcomposer {want_sha}')
# baked rc must equal the COMMITTED stealth artifact
rc_committed = open(os.path.join(os.environ['OEMPROP_ROOT'], 'images/redroid-w1b/oem-ro-map-stealth.rc'), 'rb').read().decode()
rc_baked = read_bytes('vendor/etc/init/oem-ro-map.rc').decode()
if rc_baked != rc_committed:
    fail.append('baked oem-ro-map.rc != committed stealth artifact (image carries a drifted map)')
if '--delete-if-exist' not in rc_baked:
    fail.append('baked rc lacks the carrier sweep (stealth map not actually baked)')
if fail:
    print('POST-BUILD ASSERT FAILED:\n  ' + '\n  '.join(fail), file=sys.stderr)
    sys.exit(1)
print('POST-BUILD ASSERT OK: stealth layer baked, inherited oemprop layer intact')
PYEOF
rm -f "/tmp/stealth-assert.$$.tar"
docker rm -f stealth-assert >/dev/null 2>&1 || true
docker rmi "$PRE" >/dev/null 2>&1 || true
note "DONE: $FINAL (NOT VERIFIED on-device until WA-ADVERSARIAL-FINAL — S1 red line)"

#!/usr/bin/env bash
# WA-VMSTEALTH image finalize — normalize the two stealth artifacts to the
# modes/ownership init + the loader demand (mirrors gms-mtg-oemprop/finalize.sh;
# group-writable init config = "Skipping insecure file" = mapping silently
# dead). Deterministic: rc 0644, lvp 0644, root:root, regardless of host umask.
#
# Usage: bash finalize.sh <pre-tag> <final-tag>
#
# The oem-propctl pair + hwcomposer fallbacks inherit their normalized state
# from the (already finalized) oemprop base — build.sh re-asserts them from
# the final export; this script only stages/normalizes what THIS layer adds:
#   /vendor/etc/init/oem-ro-map.rc   (bit-identity vs the committed stealth rc)
#   /vendor/lib64/hw/vulkan.lvp.so   (patched in the Dockerfile lvp-patch stage)
set -eu
PRE="$1"; FINAL="$2"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
W1B="$ROOT/images/redroid-w1b"
STAGE=$(mktemp -d /tmp/oemprop-stealth-finalize.XXXX)
trap 'rm -rf "$STAGE"; docker rm -f oemprop-stealth-finalize >/dev/null 2>&1' EXIT

cp "$W1B/oem-ro-map-stealth.rc" "$STAGE/oem-ro-map.rc"; chmod 0644 "$STAGE/oem-ro-map.rc"

docker rm -f oemprop-stealth-finalize >/dev/null 2>&1 || true
docker create --name oemprop-stealth-finalize "$PRE" >/dev/null
# extract the patched lvp from the raw build (content was produced by the
# Dockerfile patch stage; here we only re-own/re-mode it), prove rc identity
docker cp oemprop-stealth-finalize:/vendor/lib64/hw/vulkan.lvp.so "$STAGE/vulkan.lvp.so"
chmod 0644 "$STAGE/vulkan.lvp.so"
sha256sum -c <(printf '%s  %s\n' "$(sha256sum "$W1B/oem-ro-map-stealth.rc" | cut -d' ' -f1)" "$STAGE/oem-ro-map.rc")

docker cp "$STAGE/oem-ro-map.rc"   oemprop-stealth-finalize:/vendor/etc/init/oem-ro-map.rc
docker cp "$STAGE/vulkan.lvp.so"   oemprop-stealth-finalize:/vendor/lib64/hw/vulkan.lvp.so
# docker cp preserves HOST uid — init's insecure-file check demands root:root.
# Rewrite both entries in the committed layer tar: uid/gid=0, mode 0644.
docker commit oemprop-stealth-finalize "${FINAL}-stage" >/dev/null
python3 - "$FINAL" <<'PYEOF'
import subprocess, sys, tarfile, io, json
final = sys.argv[1]
cid = subprocess.check_output(['docker','create','--name','oemprop-stealth-reown',f'{final}-stage']).decode().strip()
export = subprocess.check_output(['docker','export',cid])
subprocess.run(['docker','rm','-f','oemprop-stealth-reown'], capture_output=True)
WANT = {'vendor/etc/init/oem-ro-map.rc':0o644,'vendor/lib64/hw/vulkan.lvp.so':0o644}
src = tarfile.open(fileobj=io.BytesIO(export)); out = io.BytesIO()
dst = tarfile.open(fileobj=out, mode='w')
hit = 0
for m in src.getmembers():
    name = m.name.lstrip('./')
    if name in WANT:
        m.uid = m.gid = 0; m.uname = m.gname = 'root'; m.mode = WANT[name]; hit += 1
    dst.addfile(m, src.extractfile(m) if m.isreg() else None)
src.close(); dst.close(); out.seek(0)
conf = json.loads(subprocess.check_output(['docker','inspect','-f','{{json .Config}}',f'{final}-stage']))
change = []
if conf.get('Cmd'): change += ['CMD ' + json.dumps(conf['Cmd'])]
if conf.get('Entrypoint'): change += ['ENTRYPOINT ' + json.dumps(conf['Entrypoint'])]
if conf.get('Env'): change += ['ENV ' + ' '.join(f'"{k}={v}"' if ' ' in v else f'{k}={v}' for k, v in (e.split('=',1) for e in conf['Env']))]
if conf.get('WorkingDir'): change += ['WORKDIR ' + conf['WorkingDir']]
if conf.get('ExposedPorts'): change += ['EXPOSE ' + ' '.join(conf['ExposedPorts'].keys())]
for e in (conf.get('Volumes') or {}): change += ['VOLUME ' + e]
out.seek(0)
subprocess.run(['docker','import',*sum([['--change',c] for c in change],[]),'-',final], input=out.read(), capture_output=True, check=True)
assert hit == 2, f'only {hit}/2 entries rewritten'
print('re-own rewrote 2 entries ->', final)
PYEOF
docker rmi "${FINAL}-stage" >/dev/null 2>&1
docker rm -f oemprop-stealth-finalize >/dev/null
echo "finalize done: $FINAL"
# verify baked modes through a fresh export (no container run)
docker export $(docker create --name oemprop-stealth-verify "$FINAL" true) 2>/dev/null | tar -tv 2>/dev/null > /tmp/oemprop-stealth-verify-modes.txt
docker rm -f oemprop-stealth-verify >/dev/null 2>&1 || true
grep "oem-ro-map.rc" /tmp/oemprop-stealth-verify-modes.txt | grep -q "\-rw-r--r--" \
 && grep -E "\-rw-r--r--.*vendor/lib64/hw/vulkan.lvp.so$" /tmp/oemprop-stealth-verify-modes.txt >/dev/null \
 && rm -f /tmp/oemprop-stealth-verify-modes.txt && echo "finalize OK modes normalized: $FINAL"

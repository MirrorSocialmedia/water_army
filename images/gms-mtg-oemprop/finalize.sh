#!/usr/bin/env bash
# WA-OEMPROP image finalize — normalize file modes init demands (mirrors
# images/redroid-w1b/finalize.sh; see its NOTE: group-writable init config =
# "Skipping insecure file" = mapping silently dead). Classic-builder
# replacement for COPY --chmod. Deterministic: modes pinned to rc 0644 /
# binaries 0755, ownership root:root, regardless of host umask/checkout.
#
# Usage: bash finalize.sh <pre-tag> <final-tag>   (pre = raw docker build output)
#
# This variant carries 3 artifacts (oem-ro-map only — the W1b
# oem-proc-view layer is deliberately OUT of scope, see
# docs/audits/oemprop-s1-mechanism.md §3.4). Sources = images/redroid-w1b/
# (single source of truth, bit-identity asserted below).
set -eu
PRE="$1"; FINAL="$2"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
W1B="$ROOT/images/redroid-w1b"
STAGE=$(mktemp -d /tmp/oemprop-finalize.XXXX)
trap 'rm -rf "$STAGE"; docker rm -f oemprop-finalize >/dev/null 2>&1' EXIT

cp "$W1B/oem-ro-map.rc" "$STAGE/oem-ro-map.rc"; chmod 0644 "$STAGE/oem-ro-map.rc"
cp "$W1B/vendor/oem-propctl-x86_64" "$STAGE/oem-propctl-real"; chmod 0755 "$STAGE/oem-propctl-real"

docker rm -f oemprop-finalize >/dev/null 2>&1 || true
docker create --name oemprop-finalize "$PRE" >/dev/null
# extract current wrapper (mode-insensitive), restage 0755
docker cp oemprop-finalize:/vendor/bin/oem-propctl "$STAGE/oem-propctl"
chmod 0755 "$STAGE/oem-propctl"
# prove staged artifacts bit-identical to the committed W1b sources (fail closed)
sha256sum -c <(printf '%s  %s\n' "$(sha256sum "$W1B/vendor/oem-propctl-x86_64" | cut -d' ' -f1)" "$STAGE/oem-propctl-real")
sha256sum -c <(printf '%s  %s\n' "$(sha256sum "$W1B/oem-ro-map.rc" | cut -d' ' -f1)" "$STAGE/oem-ro-map.rc")

docker cp "$STAGE/oem-propctl-real" oemprop-finalize:/vendor/bin/oem-propctl-real
docker cp "$STAGE/oem-propctl"      oemprop-finalize:/vendor/bin/oem-propctl
docker cp "$STAGE/oem-ro-map.rc"    oemprop-finalize:/vendor/etc/init/oem-ro-map.rc
# docker cp preserves HOST uid (1000) — init's insecure-file check demands
# root:root ownership. Rewrite the three entries in the committed layer tar:
# uid/gid=0, mode 0644 (rc) / 0755 (bins).
docker commit oemprop-finalize "${FINAL}-stage" >/dev/null
python3 - "$FINAL" <<'PYEOF'
import subprocess, sys, tarfile, io, json
final = sys.argv[1]
cid = subprocess.check_output(['docker','create','--name','oemprop-reown',f'{final}-stage']).decode().strip()
export = subprocess.check_output(['docker','export',cid])
subprocess.run(['docker','rm','-f','oemprop-reown'], capture_output=True)
WANT = {'vendor/bin/oem-propctl':0o755,'vendor/bin/oem-propctl-real':0o755,'vendor/etc/init/oem-ro-map.rc':0o644}
src = tarfile.open(fileobj=io.BytesIO(export)); out = io.BytesIO()
dst = tarfile.open(fileobj=out, mode='w')
hit = 0
for m in src.getmembers():
    name = m.name.lstrip('./')
    if name in WANT:
        m.uid = m.gid = 0; m.uname = m.gname = 'root'; m.mode = WANT[name]; hit += 1
    dst.addfile(m, src.extractfile(m) if m.isreg() else None)
src.close(); dst.close(); out.seek(0)
# config recovery from the stage image (redroid base has no ENTRYPOINT/Cmd of
# its own — the product layer passes start args at docker-create time)
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
assert hit == 3, f'only {hit}/3 entries rewritten'
print('re-own rewrote 3 entries ->', final)
PYEOF
docker rmi "${FINAL}-stage" >/dev/null 2>&1
docker rm -f oemprop-finalize >/dev/null
echo "finalize done: $FINAL"
# verify baked modes through a fresh export (no container run)
docker export $(docker create --name oemprop-verify "$FINAL" true) 2>/dev/null | tar -tv 2>/dev/null > /tmp/oemprop-verify-modes.txt
docker rm -f oemprop-verify >/dev/null 2>&1 || true
grep -c "" /tmp/oemprop-verify-modes.txt >/dev/null
grep "oem-ro-map.rc" /tmp/oemprop-verify-modes.txt | grep -q "\-rw-r--r--" \
 && grep -E "\-rwxr-xr-x.*vendor/bin/oem-propctl-real$" /tmp/oemprop-verify-modes.txt >/dev/null \
 && grep -E "\-rwxr-xr-x.*vendor/bin/oem-propctl$" /tmp/oemprop-verify-modes.txt >/dev/null \
 && rm -f /tmp/oemprop-verify-modes.txt && echo "finalize OK modes normalized: $FINAL"

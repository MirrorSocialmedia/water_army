#!/usr/bin/env bash
# =============================================================================
# water_army — Redroid host one-time setup (Stage A, redroid-matrix-A-20261019)
#
# WHAT THIS DOES (all idempotent — safe to re-run; prints what it skips)
#   1. Load the binder_linux kernel module NOW (modprobe) + persist it in
#      /etc/modules (loaded at every boot by systemd-modules-load).
#   2. Mount binderfs at /dev/binder NOW + persist it via an fstab entry
#      (x-systemd.requires=binder_linux.module orders the module load first).
#   3. Create /var/lib/water-army owned by uid:gid 1000:1000 (the api
#      container's user) so the API can create per-device /data dirs that
#      the docker daemon (host) can bind-mount.
#
# WHY binderfs AT ALL (Stage A finding, verified on this host 2026-10-19)
#   - kernel 6.8: binderfs mounts carry PER-MOUNT device sets. The host's
#     /dev/binder mount only needs to EXIST for the host-level preflight;
#     the redroid wrapper image (water-army/redroid:14.0.0-240527-matrixa,
#     see docker/redroid-matrix/) mounts its OWN private binderfs inside the
#     container and creates the binder/hwbinder/vndbinder chardev nodes
#     there (BINDER_CTL_ADD ioctl + chmod 0666 + bind mounts). NO host
#     binder nodes are required — and nothing this host does propagates
#     into the container.
#   - ashmem_linux is NOT needed on kernel 6.x (module removed upstream;
#     memfd_create supersedes it; redroid 14 boots without it — verified).
#
# WHY fstab (not a systemd mount unit file)
#   One auditable line in /etc/fstab vs a separate unit file to keep in the
#   repo; the x-systemd.requires= option gives the same module-ordering
#   guarantee (systemd generates dev-binder.mount from the fstab entry and
#   orders it after binder_linux.module). Reversible by removing one line.
#
# REVERSIBILITY (undo, run as root, in reverse order)
#   sed -i '\#^binder /dev/binder #d' /etc/fstab
#   umount /dev/binder
#   sed -i '\#^binder_linux$#d' /etc/modules
#   modprobe -r binder_linux        # only if nothing else holds it
#   rmdir /var/lib/water-army       # only if empty (device data!)
#
# Verification (run after, as any user)
#   lsmod | grep binder_linux
#   mount | grep 'binder on /dev/binder'
#   ls -la /dev/binder
#   stat -c '%U:%G %a' /var/lib/water-army
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root (sudo bash $0)" >&2
  exit 1
fi

DATA_ROOT="/var/lib/water-army"
API_UID=1000   # the api container runs as USER node (uid 1000)
API_GID=1000

echo "==> [1/3] binder_linux module"
if lsmod | awk '{print $1}' | grep -qx 'binder_linux'; then
  echo "    already loaded — skipping modprobe"
else
  modprobe binder_linux
  echo "    modprobe binder_linux done"
fi
if grep -qx 'binder_linux' /etc/modules; then
  echo "    /etc/modules entry present — skipping"
else
  echo 'binder_linux' >> /etc/modules
  echo "    added 'binder_linux' to /etc/modules"
fi

echo "==> [2/3] binderfs mount at /dev/binder"
if mount | grep -q '^binder on /dev/binder '; then
  echo "    already mounted — skipping mount"
else
  mkdir -p /dev/binder
  mount -t binder -o rw,relatime,max=1048576 binder /dev/binder
  echo "    mounted binderfs at /dev/binder"
fi
FSTAB_LINE='binder /dev/binder binder defaults,x-systemd.requires=binder_linux.module 0 0'
if grep -q '^binder /dev/binder ' /etc/fstab; then
  echo "    /etc/fstab entry present — skipping"
else
  echo "$FSTAB_LINE" >> /etc/fstab
  echo "    added fstab line: $FSTAB_LINE"
fi

echo "==> [3/3] data root $DATA_ROOT (api user $API_UID:$API_GID)"
if [ -d "$DATA_ROOT" ]; then
  echo "    exists — ensuring ownership only"
else
  mkdir -p "$DATA_ROOT"
  echo "    created $DATA_ROOT"
fi
chown "$API_UID:$API_GID" "$DATA_ROOT"
chmod 0750 "$DATA_ROOT"

echo
echo "==> Verification"
lsmod | grep -w binder_linux || echo "  WARN: binder_linux not in lsmod"
mount | grep '^binder on /dev/binder ' || echo "  WARN: binderfs not mounted"
ls -la /dev/binder
stat -c '  %n owner=%U:%G mode=%a' "$DATA_ROOT"
echo
echo "DONE. Next steps (water_army):"
echo "  1. add the api volume to compose.yaml (already in repo, Stage A commit):"
echo "       volumes: [ ...existing..., /var/lib/water-army:/var/lib/water-army ]"
echo "  2. redeploy: sg docker -c 'docker compose up -d --build'"
echo "  3. create Template + Device via API/UI (device create was 500"
echo "     REDROID_DATA_DIR_ERROR until this script ran — see runbook §9)."

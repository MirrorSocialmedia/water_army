# =============================================================================
# water_army — Redroid matrix image wrapper (Stage A, redroid-matrix-A-20261019)
#
# WHY this image exists
# ---------------------
# 1. The host kernel (6.8) provides binderfs. This host's binderfs is mounted
#    at /dev/binder, which makes /dev/binder a DIRECTORY (binder-control +
#    features). Android's libbinder opens /dev/binder as a CHARACTER DEVICE,
#    so the plain redroid image aborts in ~1s:
#
#      Abort message: 'Binder driver '/dev/binder' could not be opened.
#      Terminating: Opening '/dev/binder' failed: Is a directory'
#
#    (verified 2026-10-19, container redroid-matrix-a-host, image
#     redroid/redroid:14.0.0-240527, exit 129)
#
# 2. A shell-script entrypoint is impossible in the stock image: its runtime
#    APEX (bionic/linker) is mounted only BY Android init at boot, so every
#    dynamically linked /system/bin binary is un-executable at entrypoint
#    time (/system/bin/linker64 -> /apex/... is a broken symlink until init
#    runs; verified 2026-10-19). The entrypoint must be a STATIC binary.
#
# 3. The stock image ships no binderfs node-creation tooling, and its host
#    binderfs mount (when propagated) may lack the binder/hwbinder/vndbinder
#    chardev nodes entirely — creating them requires the BINDER_CTL_ADD
#    binderfs-control ioctl (kernel ≥5.19 uapi).
#
# The wrapper (redroid-binder-init, static C) runs as entrypoint, as root,
# BEFORE Android init. It is fully container-local (the host is never
# touched — binderfs mounts carry per-mount device sets, verified 2026-10-19:
# nodes created here are NOT visible on the host's binderfs mount):
#   1. mounts a PRIVATE binderfs instance at /mnt/redroid-binder (container
#      mount namespace only)
#   2. allocates the binder / hwbinder / vndbinder nodes via the
#      binder-control ioctl BINDER_CTL_ADD
#   3. chmods them 0666 (control-created nodes come up 0600 on kernel 6.8;
#      Android vendor services run as uid 1000/1002 — 0600 aborts every
#      binder client with Permission denied)
#   4. bind-mounts the char devices over /dev/{binder,hwbinder,vndbinder}
#      (container /dev is a fresh per-start tmpfs)
#   5. execs the stock entrypoint verbatim:
#      /init qemu=1 androidboot.hardware=redroid [all docker-run args...]
#
# It works through the water_army API: the API only sets Image + Cmd (no
# entrypoint override), so the wrapper must live in the image.
#
# Build (multi-stage — repo stays source-only, no binaries committed)
# -------------------------------------------------------------------
#   sg docker -c "docker build -f docker/redroid-matrix/Dockerfile \
#     -t water-army/redroid:14.0.0-240527-matrixa docker/redroid-matrix"
#
# The builder stage compiles the static entrypoint with gcc on a dated
# (version-pinned) ubuntu base — `latest` is forbidden per the image-pinning
# rule (MD §7). It ALSO fetches + verifies the pinned tun2socks release
# (tun2socks.env: version + sha256, no floating 'latest'; fetch-tun2socks.sh:
# bounded retry, sha256 + ELF x86-64 verification, fail-fast) — the binary is
# the image's OWN verified artifact, not a host file, not a manual adb push.
# The build is reproducible from a clean clone: the only inputs are the
# committed source + the pinned upstream release (MD §3.4).
# =============================================================================

# ---- builder: compile the static entrypoint (audited source next to this file)
FROM ubuntu:24.04 AS builder
# curl + ca-certificates: the builder's download client + TLS trust bundle
# (ubuntu:24.04 ships neither by default; --no-install-recommends drops the
# ca-certificates recommendation curl relies on)
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev unzip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY redroid-binder-init.c .
# -static: no dynamic deps — the stock redroid image's dynamic linker is a
# broken symlink (apex not mounted) until Android init runs, so the
# entrypoint must not depend on it.
RUN gcc -O2 -static -o redroid-binder-init redroid-binder-init.c

# ---- tun2socks (R1, 2026-10-20): fetch + verify the PINNED release --------
# Pin: tun2socks.env (version 2.7.0 + sha256 of the inner binary). The
# script fail-fasts on checksum mismatch / wrong arch / download failure,
# so a corrupt or tampered upstream release breaks the BUILD (not the fleet).
COPY fetch-tun2socks.sh tun2socks.env ./
RUN sh ./fetch-tun2socks.sh /build/t2s \
 && test -f /build/t2s/tun2socks \
 && test -x /build/t2s/tun2socks \
 && echo "tun2socks staged: $(sha256sum /build/t2s/tun2socks | awk '{print $1}')"

# ---- final: the dated upstream redroid image + wrapper entrypoint
FROM redroid/redroid:14.0.0-240527
COPY --from=builder /build/redroid-binder-init /usr/local/bin/redroid-binder-init
# tun2socks for the per-device egress proxy (Stage B). Build-time contract:
# fetched + sha256/ELF-verified above; COPY preserves the builder's 0755
# mode (NOTE: the stock image has no /bin/sh, so no RUN/chmod step is
# possible in this stage — the mode is correct BY CONSTRUCTION).
COPY --from=builder /build/t2s/tun2socks /data/local/tmp/tun2socks
# NOTE: the stock image has no /bin/sh, so no RUN shell step is possible in
# this stage — COPY preserves the builder's 0755 mode.
#
# Replaces the stock entrypoint; the binary re-invokes /init with the stock
# fixed args and forwards every docker-run arg (androidboot.*) unchanged.
ENTRYPOINT ["/usr/local/bin/redroid-binder-init"]

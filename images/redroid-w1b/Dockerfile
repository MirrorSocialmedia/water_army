# water_army W1b — custom redroid 14 image with init-time carrier mapping
#
# Adds to the pinned stock base image (version pin mirrors
# docker/redroid-matrix/Dockerfile — keep in sync):
#   /vendor/bin/oem-propctl-real  resetprop-rs v0.6.0 x86_64 (sha256-pinned,
#                                 vendored under vendor/ — see propctl.provenance.md)
#   /vendor/bin/oem-propctl       %20-decode wrapper (built below, static)
#   /vendor/etc/init/oem-ro-map.rc  GENERATED init hook mapping
#                                 ro.boot.oem_* -> real ro.* props
#                                 (source of truth:
#                                  packages/shared/src/w1b-image-mapping.js)
#
# Build (network only; negligible RAM — NOT a redroid boot):
#   bash images/redroid-w1b/build.sh
#   (THE entry point: build + finalize + post-build insecure-file assertion.
#    Raw `docker build` alone is NOT shippable — see NOTE below and ADR-031.)
#
# SELinux note (real-device stage item): actions rely on redroid's container
# SELinux posture (permissive/label-disabled); if a strict policy is enabled,
# the exec needs an su_user/domain entry — logged in ADR-028 real-device list.

# --- stage 1: %20 wrapper (host-static; runs on-device without bionic) ------
FROM gcc:13-bookworm AS wrapper
COPY propctl-wrapper.c /src/propctl-wrapper.c
RUN sha256sum /src/propctl-wrapper.c \
 && gcc -O2 -static -Wall -Wextra -o /oem-propctl /src/propctl-wrapper.c \
 && sha256sum /oem-propctl

# --- stage 2: image ----------------------------------------------------------
FROM redroid/redroid:14.0.0-240527

# NOTE: the stock redroid image has NO usable /bin/sh (RUN is impossible in
# this image — discovered empirically at build time). File modes come from the
# build context — and init's "insecure file" check REJECTS group-writable
# config (real-device 2026-10-27: 0664 rc → "Skipping insecure file", mapping
# silently dead). This host builds with classic builder (no BuildKit/buildx),
# so COPY cannot --chmod; run finalize.sh after docker build to normalize the
# modes init requires (rc 0644, binaries 0755) via docker cp + commit.
COPY vendor/oem-propctl-x86_64 /vendor/bin/oem-propctl-real
COPY --from=wrapper /oem-propctl /vendor/bin/oem-propctl
COPY oem-ro-map.rc /vendor/etc/init/oem-ro-map.rc

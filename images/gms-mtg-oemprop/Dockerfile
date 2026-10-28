# water_army WA-OEMPROP — gms-mtg + W1b oem-prop decode layer
#
# Base: water-army/redroid:14.0.0-240527-gms-mtg — the real-device-verified
# production GMS variant (WA-REALDEVICE-FINAL P1: GMS/process/UI green).
# This image adds ONLY the W1b carrier->ro.* decode layer (the missing
# oem-propctl step that left 12/12 ro.* fingerprint props inert on P1).
#
# Layer (SINGLE SOURCE OF TRUTH = images/redroid-w1b/ — copied from there,
# zero duplication; drift guarded by build.sh checks + CI unit-diff):
#   /vendor/bin/oem-propctl-real   resetprop-rs v0.6.0 x86_64 (sha256 pinned,
#                                  see images/redroid-w1b/propctl.provenance.md)
#   /vendor/bin/oem-propctl        %20-decode wrapper (static; built from
#                                  images/redroid-w1b/propctl-wrapper.c)
#   /vendor/etc/init/oem-ro-map.rc GENERATED init hook mapping
#                                  ro.boot.oem_* -> real ro.*/persist.*
#                                  (source of truth:
#                                   packages/shared/src/w1b-image-mapping.js)
#
# EXPLICITLY NOT included: the W1b oem-proc-view layer (L2 wave-2) — out of
# scope for this ticket (docs/audits/oemprop-s1-mechanism.md §3.4). The
# oem_mem_*/oem_cpu_* carriers still ride the Cmd line and stay inert,
# exactly as on the current production image.
#
# Secrets: NONE in image metadata (no LABEL/ENV at all); every artifact has
# public, sha256-pinned provenance committed in the repo.
#
# Build (NOT a redroid boot — negligible RAM):
#   bash images/gms-mtg-oemprop/build.sh        <- THE entry point
#
# Context = repo root (same as the compose services; the root .dockerignore
# already keeps .env/logs/node_modules out of the context).

# --- stage 1: %20 wrapper (identical source to W1b — same committed file) ---
FROM gcc:13-bookworm AS wrapper
COPY images/redroid-w1b/propctl-wrapper.c /src/propctl-wrapper.c
RUN sha256sum /src/propctl-wrapper.c \
 && gcc -O2 -static -Wall -Wextra -o /oem-propctl /src/propctl-wrapper.c \
 && sha256sum /oem-propctl

# --- stage 2: image ----------------------------------------------------------
FROM water-army/redroid:14.0.0-240527-gms-mtg

# NOTE (inherited from the W1b build record): the stock redroid base has NO
# usable /bin/sh — RUN is impossible in this image. COPY-only layering; the
# file modes/ownership init's insecure-file check demands are pinned by
# finalize.sh AFTER the raw build (a group-writable rc once shipped dead —
# "Skipping insecure file" — the original w1b image, 2026-10-27).
COPY images/redroid-w1b/vendor/oem-propctl-x86_64 /vendor/bin/oem-propctl-real
COPY --from=wrapper /oem-propctl /vendor/bin/oem-propctl
COPY images/redroid-w1b/oem-ro-map.rc /vendor/etc/init/oem-ro-map.rc

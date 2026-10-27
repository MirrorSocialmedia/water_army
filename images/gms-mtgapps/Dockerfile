# water_army T1 GMS variant — MindTheGApps 14.0.0 x86_64 on stock redroid 14
#
# Base: SAME pin as production (docker/redroid-matrix + images/redroid-w1b):
#   redroid/redroid:14.0.0-240527  (x86_64)
#
# Integration (layout verified empirically 2026-10-27 from the fetched zip —
# 43 files): the MTG flashable zip ALREADY carries a flat partition layout
# (`system/product/**`, `system/system_ext/**`, incl.
# privapp-permissions XMLs and sysconfig). Integration = unpack `system/*`
# remapped onto `/` (→ /product/**, /system_ext/**). Installer-only members
# (`toybox`, root `build.prop` metadata, `META-INF`, `addon.d`) are NOT copied.
#
# Pinned input (sha256, no :latest): vendor/MindTheGapps-14.0.0-x86_64-20250330.zip
#   sha256 ea6738b4908c1290447f610f365e84d46ca894c9a65eef90b83030d769990d7f
#   (SOURCE-PIN.sha256; fetch via ./fetch.sh — verified at fetch time)
#
# RED LINES honoured: stock pin base ONLY; W1b carrier/ro.* layer untouched
# (two-layer merge = post-PoC decision, docs/gms-variants.md).
#
# Build (network only; negligible RAM — NOT a redroid boot):
#   ./fetch.sh
#   docker build -t water-army/redroid:14.0.0-240527-gms-mtg .

# --- stage 1: unpack (builder pinned by digest, see build-record.md) --------
FROM alpine:3.20 AS unpack
RUN apk add --no-cache unzip
COPY vendor/MindTheGapps-14.0.0-x86_64-20250330.zip /tmp/mtg.zip
RUN cd /tmp && unzip -q mtg.zip 'system/*' \
 && test -d system/product/priv-app/GmsCore -a -d system/system_ext/priv-app/GoogleServicesFramework \
 && rm -rf system/addon.d \
 && mkdir -p /stage && cp -a system/. /stage/ \
 && find /stage -type f | wc -l

# --- stage 2: image ----------------------------------------------------------
# NOTE: stock redroid has NO usable /bin/sh (RUN impossible in base — W1b
# discovery). COPY-only layering from the unpack stage; modes preserved.
# IMPORTANT (verified empirically 2026-10-27): the base carries partition
# SYMLINKS `product -> /system/product`, `system_ext -> /system/system_ext`.
# `COPY --from=unpack /stage/ /` REPLACES those symlinks with real dirs and
# shadows the base's 358 /system/product files. COPY per-subdirectory instead:
# docker follows the symlink and MERGES into the real partition dir
# (microG variant proves this path).
FROM redroid/redroid:14.0.0-240527
COPY --from=unpack /stage/product/    /product/
COPY --from=unpack /stage/system_ext/ /system_ext/
